/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { useSettings, useUI, VoiceStyle } from '@/lib/state';
import c from 'classnames';
import { useLiveAPIContext } from '@/contexts/LiveAPIContext';
import { useEffect, useState } from 'react';
import { supabase, Transcript } from '@/lib/supabase';
import { SUPPORTED_LANGUAGES, AVAILABLE_VOICES } from '@/lib/constants';

export default function Sidebar() {
  const { isSidebarOpen, toggleSidebar } = useUI();
  const { 
    language, setLanguage, 
    voice, setVoice, 
    voiceStyle, setVoiceStyle,
    speechRate, setSpeechRate,
    backgroundPadEnabled, setBackgroundPadEnabled,
    backgroundPadVolume, setBackgroundPadVolume
  } = useSettings();
  const { connected } = useLiveAPIContext();
  const [dbData, setDbData] = useState<Transcript | null>(null);

  useEffect(() => {
    // Correctly handle single row return
    supabase
      .from('transcripts')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!error && data) {
          setDbData(data);
        }
      })
      .catch((err) => {
        console.warn("Failed to fetch sidebar data:", err);
      });

    const channel = supabase
      .channel('sidebar-db-monitor')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'transcripts' },
        (payload) => {
          if (payload.new) {
             setDbData(payload.new as Transcript);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <>
      <aside className={c('sidebar', { open: isSidebarOpen })}>
        <div className="sidebar-header">
          <h3>SETTINGS</h3>
          <button onClick={toggleSidebar} className="close-button">
            <span className="material-symbols-outlined icon">close</span>
          </button>
        </div>
        <div className="sidebar-content">
          <div className="sidebar-section">
            <h4 className="sidebar-section-title">Database Monitor</h4>
            <div style={{ fontSize: '12px', background: 'var(--bg-overlay)', padding: '12px', borderRadius: '12px', border: '1px solid var(--border-subtle)' }}>
              {dbData ? (
                <>
                  <div style={{ marginBottom: '8px', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '8px' }}>
                    <div style={{ color: 'var(--text-dim)', fontSize: '10px', textTransform: 'uppercase' }}>
                      Current ID: {dbData.id?.substring ? dbData.id.substring(0, 8) : 'N/A'}...
                    </div>
                    <div style={{ color: 'var(--text-stardust)', fontSize: '10px' }}>
                      {dbData.updated_at ? new Date(dbData.updated_at).toLocaleTimeString() : 'Unknown Time'}
                    </div>
                  </div>
                  <div style={{ marginBottom: '12px' }}>
                     <strong style={{color: 'var(--accent-orbit)'}}>Source ({dbData.source_language || '?'}):</strong><br />
                     <div style={{ color: 'var(--text-nebula)', marginTop: '4px', fontStyle: 'italic', maxHeight: '100px', overflowY: 'auto', fontSize: '11px' }}>
                       "{dbData.full_transcript_text?.substring ? dbData.full_transcript_text.substring(0, 200) : ''}{(dbData.full_transcript_text?.length || 0) > 200 ? '...' : ''}"
                     </div>
                  </div>
                  <div>
                    <strong style={{color: 'var(--accent-emerald)'}}>Processing Status:</strong><br />
                    <div style={{ color: 'var(--text-stardust)', marginTop: '4px', fontSize: '11px' }}>Sent to Audio Engine</div>
                  </div>
                </>
              ) : (
                <div style={{display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-stardust)'}}>
                  <span className="material-symbols-outlined" style={{fontSize: '16px', animation: 'spin 2s linear infinite'}}>sync</span>
                  Connecting to Eburon DB...
                </div>
              )}
            </div>
          </div>

          <div className="sidebar-section">
            <fieldset disabled={connected} style={{border: 'none', padding: 0, margin: 0}}>
              <div style={{marginBottom: '1.5rem'}}>
                <label style={{display: 'block', marginBottom: '8px', fontSize: '0.75rem', color: 'var(--text-stardust)', fontWeight: 600}}>TARGET LANGUAGE</label>
                <select
                  value={language}
                  onChange={e => setLanguage(e.target.value)}
                >
                  <option value="" disabled>Select...</option>
                  {SUPPORTED_LANGUAGES.map(lang => (
                    <option key={lang} value={lang}>{lang}</option>
                  ))}
                </select>
              </div>

              <div style={{marginBottom: '1.5rem'}}>
                <label style={{display: 'block', marginBottom: '8px', fontSize: '0.75rem', color: 'var(--text-stardust)', fontWeight: 600}}>VOICE MODEL</label>
                <select
                  value={voice}
                  onChange={e => setVoice(e.target.value)}
                >
                  {AVAILABLE_VOICES.map(v => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>

              <div style={{marginBottom: '1.5rem'}}>
                <label style={{display: 'block', marginBottom: '8px', fontSize: '0.75rem', color: 'var(--text-stardust)', fontWeight: 600}}>VOICE STYLE</label>
                <select
                  value={voiceStyle}
                  onChange={e => setVoiceStyle(e.target.value as VoiceStyle)}
                >
                  <option value="conversational">Conversational</option>
                  <option value="formal">Formal</option>
                  <option value="enthusiastic">Enthusiastic</option>
                  <option value="natural">Natural</option>
                  <option value="breathy">Breathy</option>
                  <option value="dramatic">Dramatic</option>
                </select>
              </div>

              <div>
                <label style={{display: 'block', marginBottom: '8px', fontSize: '0.75rem', color: 'var(--text-stardust)', fontWeight: 600}}>READING SPEED: {speechRate}x</label>
                <input 
                    type="range" 
                    min="0.5" 
                    max="2.0" 
                    step="0.1" 
                    value={speechRate}
                    onChange={(e) => setSpeechRate(parseFloat(e.target.value))}
                    style={{width: '100%', cursor: 'pointer', accentColor: 'var(--accent-orbit)'}}
                 />
                 <div style={{display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '4px'}}>
                   <span>Slow</span>
                   <span>Normal</span>
                   <span>Fast</span>
                 </div>
              </div>
            </fieldset>
          </div>

          <div className="sidebar-section">
            <h4 className="sidebar-section-title">Background Audio</h4>
            <div style={{display: 'flex', flexDirection: 'column', gap: '1rem', background: 'var(--bg-overlay)', padding: '16px', borderRadius: '16px'}}>
               <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
                 <label style={{fontSize: '0.9rem', color: 'var(--text-nebula)'}}>Ambient Pad</label>
                 <label className="switch" style={{position: 'relative', display: 'inline-block', width: '40px', height: '24px'}}>
                   <input 
                      type="checkbox" 
                      checked={backgroundPadEnabled}
                      onChange={(e) => setBackgroundPadEnabled(e.target.checked)}
                      style={{opacity: 0, width: 0, height: 0}}
                   />
                   <span 
                     style={{
                       position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0, 
                       backgroundColor: backgroundPadEnabled ? 'var(--accent-orbit)' : 'var(--text-dim)', 
                       transition: '.4s', borderRadius: '24px'
                     }}
                   >
                     <span style={{
                       position: 'absolute', content: '""', height: '16px', width: '16px', 
                       left: backgroundPadEnabled ? '20px' : '4px', bottom: '4px', 
                       backgroundColor: 'white', transition: '.4s', borderRadius: '50%'
                     }}></span>
                   </span>
                 </label>
               </div>
               
               {backgroundPadEnabled && (
                 <div>
                   <label style={{display: 'block', marginBottom: '8px', fontSize: '0.8rem', color: 'var(--text-stardust)'}}>
                     Volume: {Math.round(backgroundPadVolume * 100)}%
                   </label>
                   <input 
                      type="range" 
                      min="0" 
                      max="0.5" 
                      step="0.01" 
                      value={backgroundPadVolume}
                      onChange={(e) => setBackgroundPadVolume(parseFloat(e.target.value))}
                      style={{width: '100%', cursor: 'pointer', accentColor: 'var(--accent-orbit)'}}
                   />
                 </div>
               )}
            </div>
          </div>
          
          <div className="sidebar-section">
            <div style={{padding: '12px', background: 'rgba(37, 99, 235, 0.1)', borderRadius: '12px', border: '1px solid var(--accent-orbit)', fontSize: '11px', color: 'var(--text-nebula)'}}>
              <strong style={{display:'block', marginBottom:'4px', color:'var(--accent-orbit)'}}>Eburon Active</strong>
              Tools disabled. Polling interval: 5s.
            </div>
          </div>

        </div>
      </aside>
    </>
  );
}