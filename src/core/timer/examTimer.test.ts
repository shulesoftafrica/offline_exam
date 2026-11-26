import { describe, expect, it } from 'vitest';
import {
  expectedEndWall,
  integrityOf,
  isExpired,
  percentElapsed,
  readClock,
  remainingSeconds,
  resumeTimer,
  startTimer,
  tick,
} from './examTimer';
import { fakeClock } from '../util/clock';

/**
 * The timer is the part of this app that a student has the most incentive to defeat and the
 * most to lose from if it is wrong, so its whole policy is pinned down here.
 */
describe('exam timer', () => {
  const DURATION = 600; // 10 minutes

  it('starts at zero and reports the full duration as remaining', () => {
    const { clock } = fakeClock();
    const state = startTimer(DURATION, readClock(clock));

    expect(state.elapsedSeconds).toBe(0);
    expect(remainingSeconds(state)).toBe(DURATION);
    expect(isExpired(state)).toBe(false);
    expect(percentElapsed(state)).toBe(0);
  });

  it('counts real time while the page is alive', () => {
    const f = fakeClock();
    let state = startTimer(DURATION, readClock(f.clock));

    f.advance(90_000); // 90 s
    state = tick(state, readClock(f.clock));

    expect(state.elapsedSeconds).toBeCloseTo(90, 1);
    expect(remainingSeconds(state)).toBe(DURATION - 90);
  });

  it('never gives time back when the wall clock is moved backwards', () => {
    const f = fakeClock();
    let state = startTimer(DURATION, readClock(f.clock));

    f.advance(120_000);
    state = tick(state, readClock(f.clock));
    expect(state.elapsedSeconds).toBeCloseTo(120, 1);

    // The student sets the machine's clock back an hour. Monotonic time does not care.
    f.setWall(f.wall - 3_600_000);
    state = tick(state, readClock(f.clock));

    expect(state.elapsedSeconds).toBeGreaterThanOrEqual(120);
    expect(remainingSeconds(state)).toBeLessThanOrEqual(DURATION - 120);
  });

  it('charges for time the machine spent switched off (crash / power cut)', () => {
    const f = fakeClock();
    let state = startTimer(DURATION, readClock(f.clock));

    f.advance(60_000);
    state = tick(state, readClock(f.clock)); // last checkpoint at 60 s

    // Power cut for three minutes, then a fresh page session (monotonic clock restarts).
    f.advanceWall(180_000);
    f.newPageSession('after-reboot');
    const resumed = resumeTimer(state, readClock(f.clock));

    expect(resumed.elapsedSeconds).toBeCloseTo(240, 1);
    expect(resumed.monoSessionId).toBe('after-reboot');
    expect(resumed.monoAnchorElapsed).toBeCloseTo(240, 1);
    expect(remainingSeconds(resumed)).toBe(DURATION - 240);
  });

  it('keeps counting correctly after a resume, anchored to the new page session', () => {
    const f = fakeClock();
    let state = startTimer(DURATION, readClock(f.clock));

    f.advance(100_000);
    state = tick(state, readClock(f.clock));

    f.advanceWall(50_000);
    f.newPageSession('second-session');
    state = resumeTimer(state, readClock(f.clock));
    expect(state.elapsedSeconds).toBeCloseTo(150, 1);

    f.advance(30_000);
    state = tick(state, readClock(f.clock));

    expect(state.elapsedSeconds).toBeCloseTo(180, 1);
  });

  it('ignores a monotonic reading from a different page session', () => {
    const f = fakeClock();
    let state = startTimer(DURATION, readClock(f.clock));
    f.advance(45_000);
    state = tick(state, readClock(f.clock));

    // A reading whose session id does not match must not be used as a source.
    const foreign = { wallNow: f.wall, monoNow: 999_999_999, monoSessionId: 'someone-else' };
    const next = tick(state, foreign);

    expect(next.elapsedSeconds).toBeCloseTo(45, 1);
  });

  it('clamps at the duration and reports expiry exactly once it is reached', () => {
    const f = fakeClock();
    let state = startTimer(DURATION, readClock(f.clock));

    f.advance((DURATION + 120) * 1000);
    state = tick(state, readClock(f.clock));

    expect(state.elapsedSeconds).toBe(DURATION);
    expect(remainingSeconds(state)).toBe(0);
    expect(isExpired(state)).toBe(true);
    expect(percentElapsed(state)).toBe(100);
  });

  it('survives many ticks without drifting (elapsed is monotonic)', () => {
    const f = fakeClock();
    let state = startTimer(DURATION, readClock(f.clock));
    let previous = 0;

    for (let i = 0; i < 300; i += 1) {
      f.advance(1_000);
      state = tick(state, readClock(f.clock));
      expect(state.elapsedSeconds).toBeGreaterThanOrEqual(previous);
      previous = state.elapsedSeconds;
    }

    expect(state.elapsedSeconds).toBeCloseTo(300, 1);
  });

  it('projects the wall-clock end time for the UI hint', () => {
    const f = fakeClock();
    const state = startTimer(DURATION, readClock(f.clock));
    expect(expectedEndWall(state, readClock(f.clock))).toBe(f.wall + DURATION * 1000);
  });

  describe('integrity reporting', () => {
    it('reports no drift on an honest attempt', () => {
      const f = fakeClock();
      let state = startTimer(DURATION, readClock(f.clock));
      f.advance(120_000);
      state = tick(state, readClock(f.clock));

      const integrity = integrityOf(state, readClock(f.clock));
      expect(integrity.clockWentBackwards).toBe(false);
      expect(integrity.overran).toBe(false);
      expect(Math.abs(integrity.driftSeconds)).toBeLessThan(1);
    });

    it('flags a clock that was moved backwards', () => {
      const f = fakeClock();
      let state = startTimer(DURATION, readClock(f.clock));
      f.advance(300_000);
      state = tick(state, readClock(f.clock));

      f.setWall(f.wall - 240_000); // rolled back 4 minutes
      const integrity = integrityOf(state, readClock(f.clock));

      expect(integrity.clockWentBackwards).toBe(true);
      expect(integrity.driftSeconds).toBeLessThan(0);
    });
  });
});
