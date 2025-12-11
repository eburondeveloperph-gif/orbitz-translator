/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { useEffect, useRef, useCallback } from 'react';
import { supabase, Transcript } from '../lib/supabase';
import { useLiveAPIContext } from '../contexts/LiveAPIContext';
import { useLogStore, useSettings } from '../lib/state';

// Worker script to ensure polling continues even when tab is in background
const workerScript = `
  self.onmessage = function(e) {
    const data = e.data;
    if (data === 'start') {
      setInterval(() => {
        self.postMessage({ type: 'tick' });
      }, 5000);
    } else if (data && data.type === 'wait') {
      setTimeout(() => {
        self.postMessage({ type: 'wait_complete', id: data.id });
      }, data.ms);
    }
  };
`;

const segmentText = (text: string): string[] => {
  if (!text) return [];
  return text.split(/\r?\n+/).map(t => t.trim()).filter(t => t.length > 0);
};

type QueueItem = {
  text: string;
  refData: Transcript | null;
  turnId?: string;
};

export default function DatabaseBridge() {
  const { client, connected, getAudioStreamerState, sendToSpeaker, addOutputListener } = useLiveAPIContext();
  const { addTurn, updateTurn } = useLogStore();
  const { voiceStyle, speechRate, language } = useSettings();
  
  const lastProcessedIdRef = useRef<string | null>(null);
  const paragraphCountRef = useRef<number>(0);
  
  const voiceStyleRef = useRef(voiceStyle);
  const speechRateRef = useRef(speechRate);
  const languageRef = useRef(language);

  const currentTurnIdRef = useRef<string | null>(null);
  const currentTranslationBufferRef = useRef<string>('');
  
  const workerRef = useRef<Worker | null>(null);
  const pendingWaitsRef = useRef<Map<string, () => void>>(new Map());

  const workerWait = useCallback((ms: number) => {
    return new Promise<void>((resolve) => {
      if (!workerRef.current) {
        setTimeout(resolve, ms);
        return;
      }
      const id = crypto.randomUUID();
      pendingWaitsRef.current.set(id, resolve);
      workerRef.current.postMessage({ type: 'wait', id, ms });
    });
  }, []);

  useEffect(() => { voiceStyleRef.current = voiceStyle; }, [voiceStyle]);
  useEffect(() => { speechRateRef.current = speechRate; }, [speechRate]);
  useEffect(() => { languageRef.current = language; }, [language]);

  useEffect(() => {
    const removeListener = addOutputListener((text: string, isFinal: boolean) => {
       currentTranslationBufferRef.current += text;
       if (currentTurnIdRef.current) {
         updateTurn(currentTurnIdRef.current, { 
           translation: currentTranslationBufferRef.current 
         });
       }
    });
    return () => removeListener();
  }, [addOutputListener, updateTurn]);

  const queueRef = useRef<QueueItem[]>([]);
  const isProcessingRef = useRef(false);

  useEffect(() => {
    isProcessingRef.current = false;
    if (!connected) return;

    const processQueueLoop = async () => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;

      try {
        while (queueRef.current.length > 0) {
          if (client.status !== 'connected') {
            isProcessingRef.current = false;
            return;
          }

          const item = queueRef.current[0];
          const rawText = item.text;
          currentTurnIdRef.current = item.turnId || null;
          
          let textToSend = rawText;
          let targetSpeaker = 'default';
          
          if (rawText.startsWith('Male 1:')) { targetSpeaker = 'Male 1'; textToSend = rawText.replace('Male 1:', '').trim(); }
          else if (rawText.startsWith('Male 2:')) { targetSpeaker = 'Male 2'; textToSend = rawText.replace('Male 2:', '').trim(); }
          else if (rawText.startsWith('Female 1:')) { targetSpeaker = 'Female 1'; textToSend = rawText.replace('Female 1:', '').trim(); }
          else if (rawText.startsWith('Female 2:')) { targetSpeaker = 'Female 2'; textToSend = rawText.replace('Female 2:', '').trim(); }
          
          let scriptedText = textToSend;
          if (textToSend !== '(clears throat)') {
             const style = voiceStyleRef.current;
             switch (style) {
               case 'breathy': scriptedText = `(soft inhale) ${textToSend} ... (pause)`; break;
               case 'dramatic': scriptedText = `(slowly) ${textToSend} ... (long pause)`; break;
               case 'enthusiastic': scriptedText = `(excitedly) ${textToSend}`; break;
               case 'formal': scriptedText = `(professionally) ${textToSend}`; break;
               case 'conversational': scriptedText = `(casually) ${textToSend}`; break;
             }
          }

          if (!scriptedText || !scriptedText.trim()) {
            queueRef.current.shift();
            continue;
          }

          currentTranslationBufferRef.current = '';
          const preSendState = getAudioStreamerState(targetSpeaker);

          sendToSpeaker(scriptedText, targetSpeaker);
          queueRef.current.shift();

          const waitStart = Date.now();
          let audioArrived = false;
          while (Date.now() - waitStart < 15000) {
             const currentState = getAudioStreamerState(targetSpeaker);
             if (currentState.endOfQueueTime > preSendState.endOfQueueTime + 0.1) {
                audioArrived = true;
                break;
             }
             await workerWait(250); 
          }

          if (!audioArrived) console.warn("Timeout waiting for audio response.");

          const playStart = Date.now();
          while (Date.now() - playStart < 60000) {
             const state = getAudioStreamerState(targetSpeaker);
             if (state.duration <= 0.5) break;
             await workerWait(100);
          }

          if (item.refData && currentTranslationBufferRef.current.trim().length > 0) {
            try {
              await supabase.from('translations').insert({
                meeting_id: item.refData.session_id,
                user_id: item.refData.user_id,
                original_text: rawText, 
                translated_text: currentTranslationBufferRef.current.trim(),
                language: languageRef.current,
              });
            } catch (err) {
              console.error('Failed to save translation:', err);
            }
          }
          currentTurnIdRef.current = null;
        }
      } catch (e) {
        console.error('Error in processing loop:', e);
      } finally {
        isProcessingRef.current = false;
      }
    };

    if (queueRef.current.length > 0) processQueueLoop();

    const processNewData = (data: Transcript) => {
      const source = data.full_transcript_text;
      if (!data || !source) return;

      if (lastProcessedIdRef.current === data.id) return;
      lastProcessedIdRef.current = data.id;
      
      const segments = segmentText(source);
      if (segments.length > 0) {
        segments.forEach((seg) => {
           const turnId = crypto.randomUUID();
           let speaker = 'default';
           let uiText = seg;

           if (seg.startsWith('Male 1:')) { speaker = 'Male 1'; uiText = seg.replace('Male 1:', '').trim(); }
           else if (seg.startsWith('Male 2:')) { speaker = 'Male 2'; uiText = seg.replace('Male 2:', '').trim(); }
           else if (seg.startsWith('Female 1:')) { speaker = 'Female 1'; uiText = seg.replace('Female 1:', '').trim(); }
           else if (seg.startsWith('Female 2:')) { speaker = 'Female 2'; uiText = seg.replace('Female 2:', '').trim(); }
           
           addTurn({
            id: turnId,
            role: 'system',
            text: uiText, 
            translation: '', 
            sourceText: seg, 
            isFinal: true,
            speaker: speaker 
          });

           queueRef.current.push({ text: seg, refData: data, turnId });
           
           paragraphCountRef.current += 1;
           if (paragraphCountRef.current > 0 && paragraphCountRef.current % 3 === 0) {
              queueRef.current.push({ text: '(clears throat)', refData: null, turnId: undefined });
           }
        });
        processQueueLoop();
      }
    };

    const fetchLatest = async () => {
      try {
        // Use maybeSingle to safely handle 0 or 1 rows
        const { data, error } = await supabase
          .from('transcripts')
          .select('*')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        
        if (error) {
          console.warn('Supabase polling warning:', error.message);
          return;
        }

        if (data) {
          processNewData(data as Transcript);
        }
      } catch (err) {
        console.warn('Supabase connection error - retrying:', err);
      }
    };

    if (!workerRef.current) {
        const blob = new Blob([workerScript], { type: 'application/javascript' });
        workerRef.current = new Worker(URL.createObjectURL(blob));
        workerRef.current.onmessage = (e) => {
          if (e.data?.type === 'tick') fetchLatest();
          else if (e.data?.type === 'wait_complete') {
             const resolve = pendingWaitsRef.current.get(e.data.id);
             if (resolve) {
                resolve();
                pendingWaitsRef.current.delete(e.data.id);
             }
          }
        };
        workerRef.current.postMessage('start');
    }

    const channel = supabase
      .channel('bridge-realtime-opt')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'transcripts' },
        (payload) => {
          if (payload.new) processNewData(payload.new as Transcript);
        }
      )
      .subscribe();

    fetchLatest();

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      supabase.removeChannel(channel);
    };
  }, [connected, client, addTurn, updateTurn, getAudioStreamerState, sendToSpeaker, addOutputListener, workerWait]);

  return null;
}