import { useEffect, useRef, type ReactNode } from 'react';
import type { ExamListState, SyncSummary } from '../../types';
import { stateLabel } from '../../core/examMerge';
import { formatDuration } from '../../core/util/clock';
import type { ConnectivityState } from '../../core/sync/connectivity';

/** Exam state badge. One component so every screen names a state identically. */
export function StateBadge({ state }: { state: ExamListState }): JSX.Element {
  const { label, tone } = stateLabel(state);
  return (
    <span className={`badge ${tone}`}>
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function SyncBadge({ summary }: { summary: SyncSummary | null }): JSX.Element | null {
  if (!summary || summary.state === 'empty') return null;
  const map: Record<SyncSummary['state'], { label: string; tone: string }> = {
    synced: { label: 'Sent to school', tone: 'done' },
    queued: { label: `Waiting to send (${summary.queued})`, tone: 'pending' },
    uploading: { label: 'Sending…', tone: 'pending' },
    needs_attention: { label: 'Needs the teacher', tone: 'warn' },
    empty: { label: '', tone: 'muted' },
  };
  const { label, tone } = map[summary.state];
  return (
    <span className={`badge ${tone}`}>
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Banner({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'ok' | 'warn' | 'danger';
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className={`banner ${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <div style={{ flex: '1 1 auto' }}>
        {title ? <strong>{title} </strong> : null}
        {children}
      </div>
      {action}
    </div>
  );
}

/**
 * Connectivity pill. Says what the student actually needs to know ("No internet — this is
 * normal during the exam"), not a technical status.
 */
export function NetPill({
  state,
  examInProgress,
}: {
  state: ConnectivityState;
  examInProgress?: boolean;
}): JSX.Element {
  const online = state.reachability === 'online';
  const className = `net ${state.probing ? 'probing' : ''} ${online ? 'online' : state.reachability === 'offline' ? 'offline' : ''}`;
  const label = online
    ? 'Internet on'
    : state.reachability === 'offline'
      ? examInProgress
        ? 'No internet (normal during the exam)'
        : 'No internet'
      : 'Checking…';
  return (
    <span className={className} title={state.lastProbeAt ? `Last checked ${new Date(state.lastProbeAt).toLocaleTimeString()}` : undefined}>
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Timer({
  secondsLeft,
  totalSeconds,
}: {
  secondsLeft: number;
  totalSeconds: number;
}): JSX.Element {
  const ratio = totalSeconds > 0 ? secondsLeft / totalSeconds : 0;
  const tone = secondsLeft <= 60 ? 'danger' : ratio <= 0.1 || secondsLeft <= 300 ? 'warn' : '';
  return (
    <span className={`timer ${tone}`} role="timer" aria-live="off">
      <small>Time left</small>
      <span>{formatDuration(secondsLeft)}</span>
    </span>
  );
}

export function ProgressBar({ ratio, label }: { ratio: number; label?: string }): JSX.Element {
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label ?? 'Progress'}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <span className="row" style={{ gap: '0.5rem' }}>
      <span className="spinner" aria-hidden="true" />
      <span>{label ?? 'Working…'}</span>
    </span>
  );
}

/**
 * Modal dialog with a focus trap good enough for a lab: focus moves in on open, Escape
 * closes (when allowed), and the backdrop does not close by accident mid-exam.
 */
export function Dialog({
  title,
  children,
  onClose,
  closable = true,
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  closable?: boolean;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    const focusable = node?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && closable) onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closable, onClose]);

  return (
    <div className="scrim">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="card quiet stack tight">
      <strong>{title}</strong>
      {children ? <div className="muted">{children}</div> : null}
    </div>
  );
}
