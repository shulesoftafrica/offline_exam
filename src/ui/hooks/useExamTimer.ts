import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttemptKey, TimerState } from '../../types';
import { config } from '../../core/config';
import { isExpired, readClock, remainingSeconds, tick } from '../../core/timer/examTimer';
import { systemClock } from '../../core/util/clock';
import { useService } from './useService';

/**
 * Drives the exam countdown in the UI.
 *
 * Two cadences on purpose:
 *  - every second, recompute the displayed remaining time in memory (cheap, no I/O);
 *  - every `timerCheckpointMs`, and on `visibilitychange` / `pagehide`, persist to
 *    IndexedDB, so a power cut loses at most one checkpoint interval.
 *
 * `onExpire` fires exactly once, which is what triggers the automatic submission.
 */
export interface UseExamTimer {
  timer: TimerState | null;
  secondsLeft: number;
  expired: boolean;
  /** Persist the current clock immediately (used right before submitting). */
  flush: () => Promise<void>;
}

export function useExamTimer(
  attemptKey: AttemptKey | null,
  initial: TimerState | null,
  onExpire: () => void,
): UseExamTimer {
  const service = useService();
  const [timer, setTimer] = useState<TimerState | null>(initial);
  const stateRef = useRef<TimerState | null>(initial);
  const expiredRef = useRef(false);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  useEffect(() => {
    stateRef.current = initial;
    setTimer(initial);
    expiredRef.current = initial ? isExpired(initial) : false;
  }, [initial]);

  const persist = useCallback(async () => {
    const current = stateRef.current;
    if (!attemptKey || !current) return;
    await service.exams.checkpointTimer(attemptKey, current);
  }, [attemptKey, service]);

  // The runner mounts before the attempt has loaded from IndexedDB, so this effect must
  // re-run once a timer exists — keyed on "is there one" rather than on the timer object,
  // which changes every second and would restart the intervals continuously.
  const hasTimer = initial !== null;

  useEffect(() => {
    if (!attemptKey || !hasTimer || !stateRef.current) return undefined;

    const step = (): void => {
      const current = stateRef.current;
      if (!current) return;
      const next = tick(current, readClock(systemClock));
      stateRef.current = next;
      setTimer(next);
      if (isExpired(next) && !expiredRef.current) {
        expiredRef.current = true;
        void persist().finally(() => expireRef.current());
      }
    };

    const ticker = window.setInterval(step, 1_000);
    const checkpointer = window.setInterval(() => void persist(), config.timerCheckpointMs);

    // The two moments a lab machine actually disappears: the tab is hidden, or the page is
    // being torn down. Checkpoint on both.
    const onHide = (): void => {
      step();
      void persist();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);

    step();

    return () => {
      window.clearInterval(ticker);
      window.clearInterval(checkpointer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      void persist();
    };
  }, [attemptKey, hasTimer, persist]);

  return {
    timer,
    secondsLeft: timer ? remainingSeconds(timer) : 0,
    expired: timer ? isExpired(timer) : false,
    flush: persist,
  };
}
