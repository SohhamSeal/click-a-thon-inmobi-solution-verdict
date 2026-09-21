'use client';

import { stamp } from '@/lib/format';
import type { ReplayController, ReplaySpeed } from '@/lib/timemachine';
import { SPEEDS } from '@/lib/timemachine';

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** Minimal playback chrome for Time Machine — single clock, nothing else. */
export function TimeMachineBar({
  label,
  replay,
}: {
  label: string;
  replay: ReplayController;
}) {
  const { derived, isPlaying, speed, simTimeMs } = replay;
  const { progress01, timelineStartMs, timelineEndMs } = derived;

  return (
    <div className="tmbar">
      <div className="tmrow">
        <div className="tmleft">
          <span className="tmtag">TIME MACHINE · Recorded replay</span>
          <span className="tmdataset">{label}</span>
        </div>
        <div className="tmcontrols">
          <button className="fchip go" onClick={replay.toggle} aria-label={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          <button className="fchip" onClick={replay.reset} title="Reset playback (does not touch ClickHouse)">
            Reset
          </button>
          <span className="tmsep" />
          {SPEEDS.map((s: ReplaySpeed) => (
            <button
              key={s}
              className={`fchip${speed === s ? ' on' : ''}`}
              aria-pressed={speed === s}
              onClick={() => replay.setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      <div className="tmscrub">
        <span className="mono dim2 tmstamp">{stamp(isoFromMs(simTimeMs))}</span>
        <input
          className="tmslider"
          type="range"
          min={0}
          max={1000}
          value={Math.round(progress01 * 1000)}
          onChange={e => replay.scrub(Number(e.target.value) / 1000)}
          aria-label="Simulated time"
        />
        <span className="mono dim2 tmstamp">{stamp(isoFromMs(timelineEndMs))}</span>
      </div>
      <p className="tmnote">
        Deterministic replay of a completed investigation. Scrub to move time; graph, cases, KPIs
        and the drawer all follow the same clock.
        <span className="dim2"> · {stamp(isoFromMs(timelineStartMs))} → {stamp(isoFromMs(timelineEndMs))}</span>
      </p>
    </div>
  );
}
