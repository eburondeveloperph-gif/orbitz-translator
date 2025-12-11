/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GenAILiveClient } from '../../lib/genai-live-client';
import { LiveConnectConfig, Modality, LiveServerToolCall } from '@google/genai';
import { AudioStreamer } from '../../lib/audio-streamer';
import { audioContext } from '../../lib/utils';
import VolMeterWorket from '../../lib/worklets/vol-meter';
import { useLogStore, useSettings } from '@/lib/state';
import { SPEAKER_VOICE_MAP } from '@/lib/constants';

export type UseLiveApiResults = {
  client: GenAILiveClient;
  setConfig: (config: LiveConnectConfig) => void;
  config: LiveConnectConfig;

  connect: () => Promise<void>;
  disconnect: () => void;
  connected: boolean;

  volume: number;
  isVolumeEnabled: boolean;
  setIsVolumeEnabled: (isEnabled: boolean) => void;
  isAudioPlaying: boolean;
  getAudioStreamerState: (speaker?: string) => { duration: number; endOfQueueTime: number };
  
  // Multi-speaker support
  sendToSpeaker: (text: string, speaker: string) => void;
  addOutputListener: (callback: (text: string, isFinal: boolean) => void) => () => void;
};

const SPEAKERS = ['default', 'Male 1', 'Male 2', 'Female 1', 'Female 2'];

export function useLiveApi({
  apiKey,
}: {
  apiKey: string;
}): UseLiveApiResults {
  const { model, backgroundPadEnabled, backgroundPadVolume } = useSettings();
  
  // Main client (default voice/settings)
  const client = useMemo(() => new GenAILiveClient(apiKey, model), [apiKey, model]);
  
  // Dedicated Speaker Clients
  const male1 = useMemo(() => new GenAILiveClient(apiKey, model), [apiKey, model]);
  const male2 = useMemo(() => new GenAILiveClient(apiKey, model), [apiKey, model]);
  const female1 = useMemo(() => new GenAILiveClient(apiKey, model), [apiKey, model]);
  const female2 = useMemo(() => new GenAILiveClient(apiKey, model), [apiKey, model]);

  // Map to hold separate streamers for each speaker to allow overlapping audio
  const streamersRef = useRef<Record<string, AudioStreamer>>({});

  const [volume, setVolume] = useState(0);
  const [isVolumeEnabled, setIsVolumeEnabled] = useState(true);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<LiveConnectConfig>({});

  // Initialize streamers
  useEffect(() => {
    if (Object.keys(streamersRef.current).length === 0) {
      audioContext({ id: 'audio-out' }).then((audioCtx: AudioContext) => {
        
        SPEAKERS.forEach(key => {
          const streamer = new AudioStreamer(audioCtx);
          
          // Apply initial volume state
          streamer.gainNode.gain.value = isVolumeEnabled ? 1 : 0;
          
          // Bind playback state callbacks (simple OR logic aggregation)
          streamer.onPlay = () => setIsAudioPlaying(true);
          // We don't set isAudioPlaying false here individually because others might be playing.
          // For this simple demo, visualizer relies more on 'volume' > 0.

          streamer.addWorklet<any>('vumeter-out', VolMeterWorket, (ev: any) => {
              // Aggregate volume: take the max of current visual or new input
              // This is a simple approximation for visualization
              setVolume(prev => Math.max(prev * 0.8, ev.data.volume)); 
          }).catch(err => console.error(`Error adding worklet for ${key}:`, err));
          
          streamersRef.current[key] = streamer;
        });

        // Initialize Pad on the default streamer
        if (backgroundPadEnabled && streamersRef.current['default']) {
          streamersRef.current['default'].startPad(backgroundPadVolume);
        }

      });
    }
  }, [backgroundPadEnabled, backgroundPadVolume, isVolumeEnabled]);

  // Sync background pad settings
  useEffect(() => {
    const defaultStreamer = streamersRef.current['default'];
    if (!defaultStreamer) return;
    
    if (backgroundPadEnabled) {
      defaultStreamer.startPad(backgroundPadVolume);
    } else {
      defaultStreamer.stopPad();
    }
  }, [backgroundPadEnabled]);

  useEffect(() => {
    const defaultStreamer = streamersRef.current['default'];
    if (defaultStreamer && backgroundPadEnabled) {
      defaultStreamer.setPadVolume(backgroundPadVolume);
    }
  }, [backgroundPadVolume]);

  // Sync volume enabled state with gain nodes
  useEffect(() => {
    Object.values(streamersRef.current).forEach((streamer: AudioStreamer) => {
       streamer.gainNode.gain.value = isVolumeEnabled ? 1 : 0;
    });
  }, [isVolumeEnabled]);

  useEffect(() => {
    const onOpen = () => setConnected(true);
    const onClose = () => setConnected(false);
    
    // Stop all streamers if main client is interrupted
    const stopAllStreamers = () => {
      Object.values(streamersRef.current).forEach((s: AudioStreamer) => s.stop());
    };

    // Helper to route audio to specific streamer
    const onAudio = (speaker: string) => (data: ArrayBuffer) => {
      const streamer = streamersRef.current[speaker];
      if (streamer) {
        streamer.addPCM16(new Uint8Array(data));
      }
    };

    // Bind event listeners to Main Client
    client.on('open', onOpen);
    client.on('close', onClose);
    client.on('interrupted', stopAllStreamers);
    client.on('audio', onAudio('default'));

    // Bind audio listeners to Speaker Clients
    male1.on('audio', onAudio('Male 1'));
    male2.on('audio', onAudio('Male 2'));
    female1.on('audio', onAudio('Female 1'));
    female2.on('audio', onAudio('Female 2'));

    // Only attaching tool handling to the main client for this demo scope
    const onToolCall = (toolCall: LiveServerToolCall) => {
      const functionResponses: any[] = [];
      for (const fc of toolCall.functionCalls) {
        const triggerMessage = `Triggering function call: **${fc.name}**\n\`\`\`json\n${JSON.stringify(fc.args, null, 2)}\n\`\`\``;
        useLogStore.getState().addTurn({ role: 'system', text: triggerMessage, isFinal: true });
        functionResponses.push({ id: fc.id, name: fc.name, response: { result: 'ok' } });
      }
      if (functionResponses.length > 0) {
        const responseMessage = `Function call response:\n\`\`\`json\n${JSON.stringify(functionResponses, null, 2)}\n\`\`\``;
        useLogStore.getState().addTurn({ role: 'system', text: responseMessage, isFinal: true });
      }
      client.sendToolResponse({ functionResponses: functionResponses });
    };

    client.on('toolcall', onToolCall);

    return () => {
      // Clean up event listeners
      client.off('open', onOpen);
      client.off('close', onClose);
      client.off('interrupted', stopAllStreamers);
      client.off('audio', onAudio('default'));
      client.off('toolcall', onToolCall);
      
      male1.off('audio', onAudio('Male 1'));
      male2.off('audio', onAudio('Male 2'));
      female1.off('audio', onAudio('Female 1'));
      female2.off('audio', onAudio('Female 2'));
    };
  }, [client, male1, male2, female1, female2]);

  const connect = useCallback(async () => {
    if (!config) {
      throw new Error('config has not been set');
    }
    
    // Disconnect all first
    client.disconnect();
    male1.disconnect();
    male2.disconnect();
    female1.disconnect();
    female2.disconnect();
    
    // Resume audio context
    if (Object.values(streamersRef.current).length > 0) {
      try {
        // Resume any/all
        await streamersRef.current['default'].resume();
        if (backgroundPadEnabled) {
          streamersRef.current['default'].startPad(backgroundPadVolume);
        }
      } catch (e) {
        console.warn('Failed to resume audio context:', e);
      }
    }
    
    // Create config helper
    const getSpeakerConfig = (voiceName: string): LiveConnectConfig => ({
      ...config,
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceName
          }
        }
      }
    });

    // Sequentially connect clients to avoid "Service Unavailable" burst errors
    try {
      await client.connect(config);
      await new Promise(r => setTimeout(r, 50)); // Tiny stagger
      
      await male1.connect(getSpeakerConfig(SPEAKER_VOICE_MAP['Male 1']));
      await new Promise(r => setTimeout(r, 50));
      
      await male2.connect(getSpeakerConfig(SPEAKER_VOICE_MAP['Male 2']));
      await new Promise(r => setTimeout(r, 50));
      
      await female1.connect(getSpeakerConfig(SPEAKER_VOICE_MAP['Female 1']));
      await new Promise(r => setTimeout(r, 50));
      
      await female2.connect(getSpeakerConfig(SPEAKER_VOICE_MAP['Female 2']));
    } catch (err) {
      console.error("Initialization error:", err);
      // We rely on the internal error handlers to update state if things fail partially
    }

  }, [client, male1, male2, female1, female2, config, backgroundPadEnabled, backgroundPadVolume]);

  const disconnect = useCallback(async () => {
    client.disconnect();
    male1.disconnect();
    male2.disconnect();
    female1.disconnect();
    female2.disconnect();
    setConnected(false);
  }, [setConnected, client, male1, male2, female1, female2]);

  const getAudioStreamerState = useCallback((speaker?: string) => {
    const target = speaker && streamersRef.current[speaker] ? streamersRef.current[speaker] : streamersRef.current['default'];
    return {
      duration: target?.duration || 0,
      endOfQueueTime: target?.endOfQueueTime || 0,
    };
  }, []);

  // Send text to specific speaker client
  const sendToSpeaker = useCallback((text: string, speaker: string) => {
    switch(speaker) {
      case 'Male 1':
        male1.send([{ text }]);
        break;
      case 'Male 2':
        male2.send([{ text }]);
        break;
      case 'Female 1':
        female1.send([{ text }]);
        break;
      case 'Female 2':
        female2.send([{ text }]);
        break;
      default:
        client.send([{ text }]);
    }
  }, [client, male1, male2, female1, female2]);

  // Aggregate output listeners
  const addOutputListener = useCallback((callback: (text: string, isFinal: boolean) => void) => {
    const handler = (text: string, isFinal: boolean) => callback(text, isFinal);
    
    client.on('outputTranscription', handler);
    male1.on('outputTranscription', handler);
    male2.on('outputTranscription', handler);
    female1.on('outputTranscription', handler);
    female2.on('outputTranscription', handler);

    return () => {
      client.off('outputTranscription', handler);
      male1.off('outputTranscription', handler);
      male2.off('outputTranscription', handler);
      female1.off('outputTranscription', handler);
      female2.off('outputTranscription', handler);
    };
  }, [client, male1, male2, female1, female2]);

  return {
    client,
    config,
    setConfig,
    connect,
    connected,
    disconnect,
    volume,
    isVolumeEnabled,
    setIsVolumeEnabled,
    isAudioPlaying,
    getAudioStreamerState,
    sendToSpeaker,
    addOutputListener,
  };
}