/**
 * Logging that survives a lab with no console open: every line is also appended to the
 * `events` store (see `storage/events.ts`), which the proctor can export as JSON when
 * something needs explaining.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogSink {
  (level: LogLevel, message: string, detail?: unknown): void;
}

const sinks: LogSink[] = [];

export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}

function emit(level: LogLevel, message: string, detail?: unknown): void {
  const prefix = `[exam:${level}]`;
  if (level === 'error') console.error(prefix, message, detail ?? '');
  else if (level === 'warn') console.warn(prefix, message, detail ?? '');
  else if (level === 'info') console.info(prefix, message, detail ?? '');
  for (const sink of sinks) {
    try {
      sink(level, message, detail);
    } catch {
      /* a broken sink must never break the app */
    }
  }
}

export const log = {
  debug: (m: string, d?: unknown) => emit('debug', m, d),
  info: (m: string, d?: unknown) => emit('info', m, d),
  warn: (m: string, d?: unknown) => emit('warn', m, d),
  error: (m: string, d?: unknown) => emit('error', m, d),
};

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
