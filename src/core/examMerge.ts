import type {
  AttemptRecord,
  ExamBundle,
  ExamListItem,
  ExamListState,
  MergedExamItem,
  SyncSummary,
} from '../types';
import { remainingSeconds } from './timer/examTimer';

/**
 * Merging the server's exam list with what this machine knows.
 *
 * This is the function that stops a student from sitting an exam twice and from being
 * confused about which exams are history. Pure, and tested, because getting it wrong in
 * either direction is serious: hiding an available exam blocks a student, showing a taken
 * one invites a second attempt.
 *
 * Precedence:
 *  1. **The server wins on "already taken".** If the backend says `submitted`, no local
 *     state can reopen it.
 *  2. **Local wins on "not yet acknowledged".** An attempt submitted offline here shows as
 *     `submitted_offline` / `syncing` / `needs_attention` until the server confirms, even
 *     though the server may still think it is `in_progress`.
 *  3. A local in-progress attempt shows as `in_progress` so the student can resume.
 *  4. Everything else follows the server's own state.
 */

export interface MergeInputs {
  serverItems: ExamListItem[];
  attemptsByExamId: Map<number, AttemptRecord>;
  bundlesByExamId: Map<number, ExamBundle>;
  syncByAttemptKey: Map<string, SyncSummary>;
}

export function mergeExamList(inputs: MergeInputs): MergedExamItem[] {
  const { serverItems, attemptsByExamId, bundlesByExamId, syncByAttemptKey } = inputs;
  const merged: MergedExamItem[] = [];
  const seen = new Set<number>();

  for (const item of serverItems) {
    seen.add(item.examId);
    const local = attemptsByExamId.get(item.examId) ?? null;
    const bundle = bundlesByExamId.get(item.examId) ?? null;
    const sync = local ? (syncByAttemptKey.get(local.attemptKey) ?? null) : null;
    merged.push({
      ...item,
      state: resolveState(item, local, sync),
      local,
      hasBundle: bundle !== null && bundle.verifiedAt !== null,
      secondsLeft: secondsLeftFor(item, local),
      syncSummary: sync,
    });
  }

  // Attempts on this machine for exams the server did not list (a changed subject
  // allocation, a different shift, or the list fetched while offline) must still be
  // visible — their work has to reach the server.
  for (const [examId, local] of attemptsByExamId) {
    if (seen.has(examId)) continue;
    const bundle = bundlesByExamId.get(examId) ?? null;
    const sync = syncByAttemptKey.get(local.attemptKey) ?? null;
    merged.push({
      examId,
      title: bundle?.exam.title ?? 'Exam on this machine',
      subject: bundle?.exam.subject ?? '',
      subjectId: bundle?.exam.subjectId ?? 0,
      date: bundle?.exam.date ?? null,
      minutes: Math.round((bundle?.durationSeconds ?? local.timer.durationSeconds) / 60),
      questions: local.questionCount,
      totalWeight: bundle?.exam.totalWeight ?? 0,
      serverState: 'available',
      resultsReleased: false,
      score: null,
      total: null,
      attempt: null,
      state: localOnlyState(local, sync),
      local,
      hasBundle: bundle !== null && bundle.verifiedAt !== null,
      secondsLeft: local.status === 'in_progress' ? remainingSeconds(local.timer) : null,
      syncSummary: sync,
    });
  }

  return merged.sort(byDisplayOrder);
}

function resolveState(
  item: ExamListItem,
  local: AttemptRecord | null,
  sync: SyncSummary | null,
): ExamListState {
  // Rule 2: local work the server has not confirmed outranks everything but a server
  // "already taken" that also carries a sync acknowledgement.
  if (local) {
    if (local.status === 'needs_attention' || sync?.state === 'needs_attention') {
      return 'needs_attention';
    }
    if (local.status === 'synced') {
      return item.resultsReleased || item.score !== null ? 'completed_past' : 'synced';
    }
    if (local.status === 'syncing') return 'syncing';
    if (local.status === 'submitted_offline') return 'submitted_offline';
  }

  // Rule 1.
  if (item.serverState === 'submitted') {
    return item.resultsReleased || item.score !== null ? 'completed_past' : 'synced';
  }

  if (local && (local.status === 'in_progress' || local.status === 'ready')) {
    return local.status === 'in_progress' ? 'in_progress' : 'available';
  }

  if (item.serverState === 'in_progress') return 'in_progress';
  if (item.serverState === 'upcoming') return 'upcoming';
  if (item.serverState === 'not_ready') return 'not_ready';
  return 'available';
}

function localOnlyState(local: AttemptRecord, sync: SyncSummary | null): ExamListState {
  if (local.status === 'needs_attention' || sync?.state === 'needs_attention') {
    return 'needs_attention';
  }
  if (local.status === 'synced') return 'synced';
  if (local.status === 'syncing') return 'syncing';
  if (local.status === 'submitted_offline') return 'submitted_offline';
  if (local.status === 'in_progress') return 'in_progress';
  return 'available';
}

function secondsLeftFor(item: ExamListItem, local: AttemptRecord | null): number | null {
  if (local && local.status === 'in_progress') return remainingSeconds(local.timer);
  if (item.attempt && item.attempt.status === 'in_progress') {
    const ends = Date.parse(item.attempt.endsAt);
    if (Number.isFinite(ends)) return Math.max(0, Math.round((ends - Date.now()) / 1000));
  }
  return null;
}

/** What a student should see first, top to bottom. */
const ORDER: Record<ExamListState, number> = {
  in_progress: 0,
  needs_attention: 1,
  available: 2,
  submitted_offline: 3,
  syncing: 4,
  upcoming: 5,
  synced: 6,
  completed_past: 7,
  not_ready: 8,
};

function byDisplayOrder(a: MergedExamItem, b: MergedExamItem): number {
  const rank = ORDER[a.state] - ORDER[b.state];
  if (rank !== 0) return rank;
  const dateA = a.date ?? '';
  const dateB = b.date ?? '';
  if (dateA !== dateB) return dateA < dateB ? 1 : -1; // newest first
  return a.title.localeCompare(b.title);
}

/** Which states the student may open and sit. */
export function canStart(item: MergedExamItem): boolean {
  return item.state === 'available' || item.state === 'in_progress';
}

/** Human label + tone for the badge, so every screen says the same thing. */
export interface StateLabel {
  label: string;
  tone: 'live' | 'ready' | 'pending' | 'done' | 'warn' | 'muted';
  hint: string;
}

export function stateLabel(state: ExamListState): StateLabel {
  switch (state) {
    case 'in_progress':
      return { label: 'In progress', tone: 'live', hint: 'You started this exam. Continue it.' };
    case 'available':
      return { label: 'Available now', tone: 'ready', hint: 'Download and start while you are online.' };
    case 'upcoming':
      return { label: 'Upcoming', tone: 'muted', hint: 'Opens on its exam date.' };
    case 'submitted_offline':
      return {
        label: 'Submitted — waiting for internet',
        tone: 'pending',
        hint: 'Your answers are saved on this computer and will be sent when the internet is back.',
      };
    case 'syncing':
      return { label: 'Sending…', tone: 'pending', hint: 'Your answers are being sent to the school.' };
    case 'synced':
      return { label: 'Sent to school', tone: 'done', hint: 'The school has your answers. Results come later.' };
    case 'completed_past':
      return { label: 'Completed', tone: 'done', hint: 'Already taken. You cannot sit it again.' };
    case 'needs_attention':
      return {
        label: 'Needs the teacher',
        tone: 'warn',
        hint: 'Your answers are safe on this computer but could not be sent. Tell the invigilator.',
      };
    case 'not_ready':
      return { label: 'Not ready', tone: 'muted', hint: 'The teacher has not finished setting the questions.' };
    default:
      return { label: 'Unknown', tone: 'muted', hint: '' };
  }
}
