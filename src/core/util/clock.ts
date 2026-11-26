/**
 * The only place the app reads time. Injecting a `Clock` is what makes the timer and the
 * retry engine testable without waiting for real seconds to pass.
 */

export interface Clock {
  /** Wall clock, ms since epoch. Can jump (NTP, a student changing the BIOS clock). */
  wallNow(): number;
  /** Monotonic ms since this page session started. Never jumps, never goes backwards. */
  monoNow(): number;
  /** Identifies this page session; `monoNow()` values are only comparable within it. */
  monoSessionId(): string;
}

let sessionId = '';

export function pageSessionId(): string {
  if (sessionId === '') {
    const c = globalThis.crypto;
    sessionId =
      c && typeof c.randomUUID === 'function'
        ? c.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return sessionId;
}

export const systemClock: Clock = {
  wallNow: () => Date.now(),
  monoNow: () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now(),
  monoSessionId: pageSessionId,
};

/** A clock the tests drive by hand. */
export function fakeClock(startWall = 1_700_000_000_000, startMono = 0, session = 'test-session') {
  let wall = startWall;
  let mono = startMono;
  return {
    clock: {
      wallNow: () => wall,
      monoNow: () => mono,
      monoSessionId: () => session,
    } as Clock,
    /** Advance both clocks together, as real time does. */
    advance(ms: number) {
      wall += ms;
      mono += ms;
    },
    /** Advance only the wall clock (the page was dead, or NTP stepped it). */
    advanceWall(ms: number) {
      wall += ms;
    },
    /** Move the wall clock backwards — a student trying to win time back. */
    setWall(value: number) {
      wall = value;
    },
    /** Simulate a reload: a new page session, monotonic time restarts at 0. */
    newPageSession(id: string) {
      session = id;
      mono = 0;
    },
    get wall() {
      return wall;
    },
    get mono() {
      return mono;
    },
  };
}

// ── Formatting helpers (pure, used by the UI) ───────────────────────────────

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
