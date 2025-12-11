/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import cn from 'classnames';

import { memo, ReactNode, useEffect, useRef } from 'react';
import { useLiveAPIContext } from '../../../contexts/LiveAPIContext';
import AudioVisualizer from '@/components/visualizer/AudioVisualizer';
import { useSettings } from '@/lib/state';
import { SUPPORTED_LANGUAGES } from '@/lib/constants';

export type ControlTrayProps = {
  children?: ReactNode;
};

function ControlTray({ children }: ControlTrayProps) {
  const connectButtonRef = useRef<HTMLButtonElement>(null);
  const { language, setLanguage } = useSettings();

  const { connected, connect, disconnect, isVolumeEnabled, setIsVolumeEnabled, volume } = useLiveAPIContext();

  useEffect(() => {
    if (!connected && connectButtonRef.current) {
      connectButtonRef.current.focus();
    }
  }, [connected]);

  const connectButtonTitle = connected
    ? 'Stop streaming'
    : !language
    ? 'Select a language to start'
    : 'Start streaming';

  const isPlayDisabled = !connected && !language;

  return (
    <section className="control-tray">
      <nav className={cn('actions-nav')}>
        <button
          className={cn('action-button')}
          onClick={() => setIsVolumeEnabled(!isVolumeEnabled)}
          title={isVolumeEnabled ? 'Mute Audio' : 'Unmute Audio'}
        >
          <span className="material-symbols-outlined filled">
            {isVolumeEnabled ? 'volume_up' : 'volume_off'}
          </span>
        </button>

        <div className="language-selector-container">
          <select
            className="tray-select"
            value={language}
            onChange={e => setLanguage(e.target.value)}
            disabled={connected}
          >
            <option value="" disabled>Select Language</option>
            {SUPPORTED_LANGUAGES.map(lang => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
          </select>
        </div>

        {children}
      </nav>

      <div className={cn('connection-container', { connected })}>
        <span className="text-indicator">
            {connected ? 'Live' : language ? 'Ready' : ''}
        </span>
        <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
          <AudioVisualizer volume={volume} active={connected && isVolumeEnabled} />
        </div>
        <button
          ref={connectButtonRef}
          className={cn('action-button connect-toggle', { connected, disabled: isPlayDisabled })}
          onClick={connected ? disconnect : connect}
          title={connectButtonTitle}
          disabled={isPlayDisabled}
        >
          <span className="material-symbols-outlined filled" style={{fontSize: '28px'}}>
            {connected ? 'stop' : 'play_arrow'}
          </span>
        </button>
      </div>
    </section>
  );
}

export default memo(ControlTray);