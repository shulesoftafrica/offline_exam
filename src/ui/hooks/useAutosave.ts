import { useCallback, useEffect, useRef, useState } from 'react';
import { config } from '../../core/config';

export type SaveState = 'idle' | 'pending' | 'saved' | 'error';

/**
 * Debounced autosave for written answers.
 *
 * The debounce is short (400ms by default) and — importantly — the pending value is also
 * flushed on unmount, on tab hide and on page teardown, so "saved" is never a lie: the
 * worst case a student can hit is losing the last few hundred milliseconds of typing, and
 * only if the machine dies mid-keystroke.
 */
export interface UseAutosave<T> {
  state: SaveState;
  /** Queue a value; the latest wins. */
  push: (value: T) => void;
  /** Write immediately (Submit, navigation between questions). */
  flush: () => Promise<void>;
}

export function useAutosave<T>(
  save: (value: T) => Promise<boolean | void>,
  delayMs = config.autosaveDebounceMs,
): UseAutosave<T> {
  const [state, setState] = useState<SaveState>('idle');
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  const write = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    try {
      const ok = await saveRef.current(next.value);
      setState(ok === false ? 'error' : 'saved');
    } catch {
      setState('error');
    }
  }, []);

  const push = useCallback(
    (value: T) => {
      pending.current = { value };
      setState('pending');
      if (timer.current) clearTimeout(timer.current);
      if (delayMs <= 0) {
        void write();
        return;
      }
      timer.current = setTimeout(() => void write(), delayMs);
    },
    [delayMs, write],
  );

  useEffect(() => {
    const onHide = (): void => void write();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      void write();
    };
  }, [write]);

  return { state, push, flush: write };
}
