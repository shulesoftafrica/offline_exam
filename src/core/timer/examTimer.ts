import type { TimerState } from '../../types';
import type { Clock } from '../util/clock';

/**
 * The exam clock.
 *
 * Requirements this satisfies:
 *  1. The internet is off, so the server cannot be asked what time it is.
 *  2. A refresh, a crashed tab or a lab power cut must not give time back.
 *  3. Moving the machine's clock must not give time back either.
 *  4. The duration must be enforced even if nothing re-renders (checked on resume).
 *
 * Elapsed time is therefore a **non-decreasing** value, the maximum of three sources:
 *
 *  - what was last persisted (`elapsedSeconds`);
 *  - the wall-clock delta since the last checkpoint (covers time while the page was dead,
 *    contributes 0 if the clock moved backwards);
 *  - the monotonic delta since the attempt was started, valid only within the page session
 *    that recorded it (`monoSessionId`) — immune to clock changes while the tab lives.
 *
 * Everything here is a pure function of state + a clock reading, so the whole policy is
 * unit-tested in `examTimer.test.ts`.
 */

export interface ClockReading {
  wallNow: number;
  monoNow: number;
  monoSessionId: string;
}

export function readClock(clock: Clock): ClockReading {
  return {
    wallNow: clock.wallNow(),
    monoNow: clock.monoNow(),
    monoSessionId: clock.monoSessionId(),
  };
}

/** A fresh timer for an attempt that is being started now. */
export function startTimer(durationSeconds: number, reading: ClockReading): TimerState {
  return {
    startedAtWall: reading.wallNow,
    startedAtMono: reading.monoNow,
    monoSessionId: reading.monoSessionId,
    monoAnchorElapsed: 0,
    elapsedSeconds: 0,
    lastCheckpointWall: reading.wallNow,
    durationSeconds: Math.max(0, Math.round(durationSeconds)),
  };
}

/**
 * Re-anchor a timer loaded from IndexedDB onto the current page session.
 *
 * The elapsed seconds already include everything up to the last checkpoint; the wall delta
 * from that checkpoint to now covers the gap (refresh, crash, power cut). After this call
 * the monotonic source takes over again for this page session.
 */
export function resumeTimer(state: TimerState, reading: ClockReading): TimerState {
  const gapSeconds = Math.max(0, (reading.wallNow - state.lastCheckpointWall) / 1000);
  const elapsed = Math.min(state.durationSeconds, state.elapsedSeconds + gapSeconds);
  return {
    ...state,
    elapsedSeconds: round2(elapsed),
    startedAtMono: reading.monoNow,
    monoSessionId: reading.monoSessionId,
    monoAnchorElapsed: round2(elapsed),
    lastCheckpointWall: reading.wallNow,
  };
}

/**
 * Advance the timer. Safe to call as often as the UI likes; it only ever moves forward.
 *
 * On a resumed attempt the monotonic clock restarts at 0 while elapsed is already large, so
 * the monotonic candidate is anchored: `monoAnchorElapsed + (monoNow - startedAtMono)`.
 */
export function tick(state: TimerState, reading: ClockReading): TimerState {
  const wallCandidate =
    state.elapsedSeconds + Math.max(0, (reading.wallNow - state.lastCheckpointWall) / 1000);

  let monoCandidate = 0;
  if (state.startedAtMono !== null && state.monoSessionId === reading.monoSessionId) {
    monoCandidate =
      state.monoAnchorElapsed + Math.max(0, (reading.monoNow - state.startedAtMono) / 1000);
  }

  const elapsed = Math.min(
    state.durationSeconds,
    Math.max(state.elapsedSeconds, wallCandidate, monoCandidate),
  );

  return {
    ...state,
    elapsedSeconds: round2(elapsed),
    lastCheckpointWall: reading.wallNow,
  };
}

export function remainingSeconds(state: TimerState): number {
  return Math.max(0, Math.ceil(state.durationSeconds - state.elapsedSeconds));
}

export function isExpired(state: TimerState): boolean {
  return state.elapsedSeconds >= state.durationSeconds;
}

export function percentElapsed(state: TimerState): number {
  if (state.durationSeconds <= 0) return 100;
  return Math.min(100, Math.max(0, (state.elapsedSeconds / state.durationSeconds) * 100));
}

/** Wall-clock time (ms) the exam is expected to end at, for the "ends at 10:01" hint. */
export function expectedEndWall(state: TimerState, reading: ClockReading): number {
  return reading.wallNow + remainingSeconds(state) * 1000;
}

/**
 * How suspicious this attempt's timing looks, for the proctor and for the server's
 * `needs_attention` triage. Never blocks a student — it is reported, not enforced.
 */
export interface TimerIntegrity {
  /** The machine's clock moved backwards at least once during the attempt. */
  clockWentBackwards: boolean;
  /** Elapsed exceeded the allowed duration before submission. */
  overran: boolean;
  /** Wall-clock span between start and now, which should roughly equal elapsed. */
  wallSpanSeconds: number;
  driftSeconds: number;
}

export function integrityOf(state: TimerState, reading: ClockReading): TimerIntegrity {
  const wallSpanSeconds = (reading.wallNow - state.startedAtWall) / 1000;
  return {
    clockWentBackwards: wallSpanSeconds + 1 < state.elapsedSeconds,
    overran: state.elapsedSeconds > state.durationSeconds,
    wallSpanSeconds: round2(wallSpanSeconds),
    driftSeconds: round2(wallSpanSeconds - state.elapsedSeconds),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
