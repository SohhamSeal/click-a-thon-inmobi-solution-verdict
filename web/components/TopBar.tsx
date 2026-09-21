'use client';

import { ThemeToggle } from './ThemeToggle';
import { hyperdxUrl } from '@/lib/links';

export function TopBar({
  mode = 'live',
  onModeLive,
  onModeTimeMachine,
}: {
  mode?: 'live' | 'timemachine';
  onModeLive?: () => void;
  onModeTimeMachine?: () => void;
}) {
  return (
    <div className="top">
      <span className="logo">
        <span className="mark">V</span>
        Verdict
      </span>
      <span className="vr" />
      {onModeLive && onModeTimeMachine && (
        <>
          <div className="modeseg" role="group" aria-label="Console mode">
            <button type="button" className={mode === 'live' ? 'on' : ''} aria-pressed={mode === 'live'} onClick={onModeLive}>
              Live
            </button>
            <button
              type="button"
              className={mode === 'timemachine' ? 'on' : ''}
              aria-pressed={mode === 'timemachine'}
              onClick={onModeTimeMachine}
              title="Deterministic replay of a completed investigation"
            >
              Time Machine
            </button>
          </div>
          <span className="vr" />
        </>
      )}
      <span className="mono dim2" style={{ fontSize: 11 }}>
        inmobi | glance
      </span>

      <div className="row sp" style={{ gap: 8 }}>
        <a className="btn sm" href={hyperdxUrl()} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
          HyperDX
        </a>
        <ThemeToggle />
        <span className="av" title="Verdict console">
          V
        </span>
      </div>
    </div>
  );
}
