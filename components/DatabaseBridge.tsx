/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { useEffect, useRef, useCallback } from 'react';
import { supabase, Transcript } from '../lib/supabase';
import { useLiveAPIContext } from '../contexts/LiveAPIContext';
import { useLogStore, useSettings } from '../lib/state';

// Worker script to ensure polling continues even when tab is in background
// and to provide precise timing for main thread loops to avoid throttling
const workerScript = `
  self.onmessage = function(e) {
    const data = e.data;
    if (data === 'start') {
      // Polling heartbeat
      setInterval(() => {
        self.postMessage({ type: 'tick' });
      }, 5000);
    } else if (data && data.type === 'wait') {
      // Precise one-off timer
      setTimeout(() => {
        self.postMessage({ type: 'wait_complete', id: data.id });
      }, data.ms);
    }
  };
`;

// Helper to segment text into natural reading chunks (Paragraphs)
const segmentText = (text: string): string[] => {
  if (!text) return [];
  return text.split(/\r?\n+/).map(t => t.trim()).filter(t => t.length > 0);
};

type QueueItem = {
  text: string;
  refData: Transcript | null; // null if system message like (clears throat)
  turnId?: string; // ID of the UI turn this segment belongs to
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

  // Track which turn we are currently processing to attach translation
  const currentTurnIdRef = useRef<string | null>(null);

  // Buffer to capture incoming translations for the current turn
  const currentTranslationBufferRef = useRef<string>('');
  
  // Worker reference for timing
  const workerRef = useRef<Worker | null>(null);
  const pendingWaitsRef = useRef<Map<string, () => void>>(new Map());

  // Precise wait function using Worker to bypass main thread throttling
  const workerWait = useCallback((ms: number) => {
    return new Promise<void>((resolve) => {
      if (!workerRef.current) {
        setTimeout(resolve, ms); // Fallback
        return;
      }
      const id = crypto.randomUUID();
      pendingWaitsRef.current.set(id, resolve);
      workerRef.current.postMessage({ type: 'wait', id, ms });
    });
  }, []);

  useEffect(() => {
    voiceStyleRef.current = voiceStyle;
  }, [voiceStyle]);

  useEffect(() => {
    speechRateRef.current = speechRate;
  }, [speechRate]);

  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  // Hook up listener to capture the model's spoken response text
  useEffect(() => {
    const removeListener = addOutputListener((text: string, isFinal: boolean) => {
       currentTranslationBufferRef.current += text;
       
       // Update the UI turn in real-time
       if (currentTurnIdRef.current) {
         updateTurn(currentTurnIdRef.current, { 
           translation: currentTranslationBufferRef.current 
         });
       }
    });
    return () => {
       removeListener();
    };
  }, [addOutputListener, updateTurn]);

  // High-performance queue using Refs
  const queueRef = useRef<QueueItem[]>([]);
  const isProcessingRef = useRef(false);

  // Data Ingestion & Processing Logic
  useEffect(() => {
    isProcessingRef.current = false;

    if (!connected) return;

    // The consumer loop that processes the queue sequentially (Closed Loop Control)
    const processQueueLoop = async () => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;

      try {
        while (queueRef.current.length > 0) {
          // Safety check
          if (client.status !== 'connected') {
            isProcessingRef.current = false;
            return;
          }

          const item = queueRef.current[0];
          const rawText = item.text;

          // Set current turn context for translation binding
          currentTurnIdRef.current = item.turnId || null;
          
          // Detect Speaker
          let textToSend = rawText;
          let targetSpeaker = 'default';
          
          if (rawText.startsWith('Male 1:')) {
            targetSpeaker = 'Male 1';
            textToSend = rawText.replace('Male 1:', '').trim();
          } else if (rawText.startsWith('Male 2:')) {
             targetSpeaker = 'Male 2';
             textToSend = rawText.replace('Male 2:', '').trim();
          } else if (rawText.startsWith('Female 1:')) {
             targetSpeaker = 'Female 1';
             textToSend = rawText.replace('Female 1:', '').trim();
          } else if (rawText.startsWith('Female 2:')) {
             targetSpeaker = 'Female 2';
             textToSend = rawText.replace('Female 2:', '').trim();
          }
          
          const style = voiceStyleRef.current;
          let scriptedText = textToSend;
          
          // Apply Voice Style only to non-command text
          if (textToSend !== '(clears throat)') {
             switch (style) {
               case 'breathy':
                 scriptedText = `(soft inhale) ${textToSend} ... (pause)`;
                 break;
               case 'dramatic':
                 scriptedText = `(slowly) ${textToSend} ... (long pause)`;
                 break;
               case 'enthusiastic':
                 scriptedText = `(excitedly) ${textToSend}`;
                 break;
               case 'formal':
                 scriptedText = `(professionally) ${textToSend}`;
                 break;
               case 'conversational':
                 scriptedText = `(casually) ${textToSend}`;
                 break;
               // 'natural' adds no stage directions
             }
          }

          if (!scriptedText || !scriptedText.trim()) {
            queueRef.current.shift();
            continue;
          }

          // Reset translation buffer for this new segment
          currentTranslationBufferRef.current = '';

          // Capture audio state BEFORE sending (for the target speaker)
          const preSendState = getAudioStreamerState(targetSpeaker);

          // 1. Send text to correct model
          sendToSpeaker(scriptedText, targetSpeaker);
          queueRef.current.shift();

          // 2. Wait for Audio to ARRIVE for this specific speaker
          // Using workerWait instead of setTimeout loop to handle background throttling
          const waitStart = Date.now();
          let audioArrived = false;
          while (Date.now() - waitStart < 15000) {
             const currentState = getAudioStreamerState(targetSpeaker);
             // Check if something was added to the audio queue
             if (currentState.endOfQueueTime > preSendState.endOfQueueTime + 0.1) {
                audioArrived = true;
                break;
             }
             await workerWait(250); 
          }

          if (!audioArrived) {
            console.warn("Timeout waiting for audio response from model. Moving to next chunk.");
          }

          // 3. VIDEOKE STYLE OVERLAP: Dynamic Wait
          // We wait until the current audio is *almost* finished before starting the next turn.
          // This allows masking the latency of the next request.
          // Using workerWait to ensure precision in background.
          
          const playStart = Date.now();
          
          while (Date.now() - playStart < 60000) {
             const state = getAudioStreamerState(targetSpeaker);
             
             // Dynamic Threshold Calculation:
             // Use 0.5s before the next speaker to ensure smooth transition
             const threshold = 0.5;
             
             if (state.duration <= threshold) {
                break;
             }
             
             await workerWait(100);
          }

          // 5. Save Translation to Supabase
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
          
          // Clear current turn ref
          currentTurnIdRef.current = null;
        }
      } catch (e) {
        console.error('Error in processing loop:', e);
      } finally {
        isProcessingRef.current = false;
      }
    };

    if (queueRef.current.length > 0) {
      processQueueLoop();
    }

    const processNewData = (data: Transcript) => {
      const source = data.full_transcript_text;
      if (!data || !source) return;

      if (lastProcessedIdRef.current === data.id) return;
      lastProcessedIdRef.current = data.id;
      
      // Queue Paragraphs
      const segments = segmentText(source);
      if (segments.length > 0) {
        segments.forEach((seg, index) => {
           const turnId = crypto.randomUUID();
           
           let speaker = 'default';
           let uiText = seg;

           // Parse speaker for UI display
           if (seg.startsWith('Male 1:')) { speaker = 'Male 1'; uiText = seg.replace('Male 1:', '').trim(); }
           else if (seg.startsWith('Male 2:')) { speaker = 'Male 2'; uiText = seg.replace('Male 2:', '').trim(); }
           else if (seg.startsWith('Female 1:')) { speaker = 'Female 1'; uiText = seg.replace('Female 1:', '').trim(); }
           else if (seg.startsWith('Female 2:')) { speaker = 'Female 2'; uiText = seg.replace('Female 2:', '').trim(); }
           
           // Create a specific turn for this paragraph
           addTurn({
            id: turnId,
            role: 'system',
            text: uiText, 
            translation: '', // Will be streamed
            sourceText: seg, 
            isFinal: true,
            speaker: speaker 
          });

           // We associate all segments of this source with the same UI Turn ID
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
        const { data: rows, error } = await supabase
          .from('transcripts')
          .select('*')
          .order('updated_at', { ascending: false })
          .limit(1);
        
        if (error) {
          // Log quiet warning instead of throwing to avoid noise
          console.warn('Supabase polling warning:', error.message);
          return;
        }

        if (rows && rows.length > 0) {
          processNewData(rows[0] as Transcript);
        }
      } catch (err) {
        // Catch network errors (e.g. offline, CORS, invalid URL)
        console.warn('Supabase connection error - retrying:', err);
      }
    };

    // Initialize Web Worker for background polling and timing
    if (!workerRef.current) {
        const blob = new Blob([workerScript], { type: 'application/javascript' });
        workerRef.current = new Worker(URL.createObjectURL(blob));
        
        workerRef.current.onmessage = (e) => {
          if (e.data && e.data.type === 'tick') {
             fetchLatest();
          } else if (e.data && e.data.type === 'wait_complete') {
             const resolve = pendingWaitsRef.current.get(e.data.id);
             if (resolve) {
                resolve();
                pendingWaitsRef.current.delete(e.data.id);
             }
          }
        };
        
        workerRef.current.postMessage('start');
    }

    // Setup Realtime Subscription
    const channel = supabase
      .channel('bridge-realtime-opt')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'transcripts' },
        (payload) => {
          if (payload.new) {
             processNewData(payload.new as Transcript);
          }
        }
      )
      .subscribe((status) => {
         if (status === 'SUBSCRIBED') {
           console.log('Connected to realtime db');
         } else if (status === 'CHANNEL_ERROR') {
           console.warn('Realtime channel error');
         }
      });

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