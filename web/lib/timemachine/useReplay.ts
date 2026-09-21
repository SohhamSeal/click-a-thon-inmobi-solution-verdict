'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { advanceSimTime, deriveReplay, parseMs, scrubToProgress } from './derive';
import type { DerivedReplay, ReplaySpeed, TimeMachineFixture } from './types';

export interface ReplayController {
  simTimeMs: number;
  isPlaying: boolean;
  speed: ReplaySpeed;
  selectedCaseId: string | null;
  derived: DerivedReplay;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setSpeed: (s: ReplaySpeed) => void;
  scrub: (progress01: number) => void;
  scrubToMs: (ms: number) => void;
  selectCase: (id: string | null) => void;
  reset: () => void;
}

const SPEEDS: ReplaySpeed[] = [1, 2, 5, 10];

export function useReplay(fixture: TimeMachineFixture): ReplayController {
  const start = parseMs(fixture.timeline.start);
  const [simTimeMs, setSimTimeMs] = useState(start);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeedState] = useState<ReplaySpeed>(1);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  const simRef = useRef(simTimeMs);
  const playRef = useRef(isPlaying);
  const speedRef = useRef(speed);
  simRef.current = simTimeMs;
  playRef.current = isPlaying;
  speedRef.current = speed;

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      if (playRef.current) {
        const next = advanceSimTime(fixture, simRef.current, dt, speedRef.current);
        setSimTimeMs(next);
        if (next >= parseMs(fixture.timeline.end)) setIsPlaying(false);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, fixture]);

  const derived = useMemo(
    () => deriveReplay(fixture, simTimeMs, selectedCaseId),
    [fixture, simTimeMs, selectedCaseId],
  );

  const reset = useCallback(() => {
    setIsPlaying(false);
    setSimTimeMs(start);
    setSelectedCaseId(null);
  }, [start]);

  return {
    simTimeMs,
    isPlaying,
    speed,
    selectedCaseId,
    derived,
    play: () => setIsPlaying(true),
    pause: () => setIsPlaying(false),
    toggle: () => setIsPlaying(p => !p),
    setSpeed: (s: ReplaySpeed) => {
      if (SPEEDS.includes(s)) setSpeedState(s);
    },
    scrub: (progress01: number) => {
      setSimTimeMs(scrubToProgress(fixture, progress01));
    },
    scrubToMs: (ms: number) => {
      const lo = parseMs(fixture.timeline.start);
      const hi = parseMs(fixture.timeline.end);
      setSimTimeMs(Math.min(hi, Math.max(lo, ms)));
    },
    selectCase: setSelectedCaseId,
    reset,
  };
}

export { SPEEDS };
