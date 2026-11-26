import { describe, expect, it } from 'vitest';
import type { AttemptRecord, ExamBundle, ExamListItem, SyncSummary } from '../types';
import { canStart, mergeExamList, stateLabel } from './examMerge';
import { attemptKey, scopeKey } from './util/ids';

/**
 * What the student sees in the list. The two failure modes that matter: an available exam
 * hidden (a student cannot sit it) and a finished exam offered again (a second attempt).
 */

const KEY = attemptKey('demo', 4812, 91);

function serverItem(partial: Partial<ExamListItem> = {}): ExamListItem {
  return {
    examId: 91,
    title: 'Mid-Term Physics',
    subject: 'Physics',
    subjectId: 12,
    date: '2026-11-25',
    minutes: 45,
    questions: 7,
    totalWeight: 30,
    serverState: 'available',
    resultsReleased: false,
    score: null,
    total: null,
    attempt: null,
    ...partial,
  };
}

function localAttempt(status: AttemptRecord['status'], extra: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    attemptKey: KEY,
    scopeKey: scopeKey('demo', 4812),
    schemaName: 'demo',
    studentId: 4812,
    examId: 91,
    attemptId: 551,
    submissionUuid: 'uuid-1',
    status,
    lockReason: null,
    timer: {
      startedAtWall: Date.now() - 60_000,
      startedAtMono: null,
      monoSessionId: null,
      monoAnchorElapsed: 0,
      elapsedSeconds: 60,
      lastCheckpointWall: Date.now(),
      durationSeconds: 2700,
    },
    submittedAt: null,
    autoSubmitted: false,
    submissionChecksum: null,
    answeredCount: 3,
    questionCount: 7,
    deviceId: 'device-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncedAt: null,
    lastSyncError: null,
    ...extra,
  };
}

function sync(state: SyncSummary['state'], counts: Partial<SyncSummary> = {}): SyncSummary {
  return { queued: 0, uploading: 0, synced: 0, needsAttention: 0, total: 1, state, ...counts };
}

function merge(
  items: ExamListItem[],
  attempts: AttemptRecord[] = [],
  summaries: [string, SyncSummary][] = [],
  bundles: ExamBundle[] = [],
) {
  return mergeExamList({
    serverItems: items,
    attemptsByExamId: new Map(attempts.map((a) => [a.examId, a])),
    bundlesByExamId: new Map(bundles.map((b) => [b.examId, b])),
    syncByAttemptKey: new Map(summaries),
  });
}

describe('exam list merge', () => {
  it('shows an untouched published exam as available', () => {
    const [item] = merge([serverItem()]);
    expect(item?.state).toBe('available');
    expect(canStart(item!)).toBe(true);
  });

  it('never reopens an exam the server says is taken', () => {
    const [item] = merge([serverItem({ serverState: 'submitted' })], [localAttempt('ready')]);
    expect(item?.state).toBe('synced');
    expect(canStart(item!)).toBe(false);
  });

  it('shows a released, taken exam as completed with its mark', () => {
    const [item] = merge([
      serverItem({ serverState: 'submitted', resultsReleased: true, score: 21, total: 30 }),
    ]);
    expect(item?.state).toBe('completed_past');
    expect(item?.score).toBe(21);
    expect(canStart(item!)).toBe(false);
  });

  it('keeps an offline submission visible as submitted even while the server thinks it is open', () => {
    const [item] = merge(
      [serverItem({ serverState: 'in_progress' })],
      [localAttempt('submitted_offline', { submittedAt: Date.now() })],
      [[KEY, sync('queued', { queued: 3, total: 3 })]],
    );

    expect(item?.state).toBe('submitted_offline');
    expect(canStart(item!)).toBe(false);
    expect(item?.syncSummary?.queued).toBe(3);
  });

  it('shows a local in-progress attempt as resumable', () => {
    const [item] = merge([serverItem({ serverState: 'available' })], [localAttempt('in_progress')]);
    expect(item?.state).toBe('in_progress');
    expect(canStart(item!)).toBe(true);
    expect(item?.secondsLeft).toBe(2700 - 60);
  });

  it('surfaces a failed sync as needing the teacher, whatever the server says', () => {
    const [item] = merge(
      [serverItem({ serverState: 'available' })],
      [localAttempt('needs_attention', { lastSyncError: 'HTTP 422' })],
      [[KEY, sync('needs_attention', { needsAttention: 1 })]],
    );
    expect(item?.state).toBe('needs_attention');
    expect(canStart(item!)).toBe(false);
  });

  it('marks an exam the school has confirmed as sent', () => {
    const [item] = merge(
      [serverItem({ serverState: 'submitted' })],
      [localAttempt('synced', { syncedAt: Date.now() })],
      [[KEY, sync('synced', { synced: 3, total: 3 })]],
    );
    expect(item?.state).toBe('synced');
  });

  it('passes through upcoming and not-ready states', () => {
    expect(merge([serverItem({ serverState: 'upcoming' })])[0]?.state).toBe('upcoming');
    expect(merge([serverItem({ serverState: 'not_ready' })])[0]?.state).toBe('not_ready');
    expect(canStart(merge([serverItem({ serverState: 'upcoming' })])[0]!)).toBe(false);
  });

  it('still lists an unsynced attempt for an exam the server no longer sends', () => {
    const merged = merge([], [localAttempt('submitted_offline', { submittedAt: Date.now() })]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.state).toBe('submitted_offline');
    expect(merged[0]?.examId).toBe(91);
  });

  it('orders the list so what needs doing is at the top', () => {
    const merged = merge(
      [
        serverItem({ examId: 1, title: 'Taken', serverState: 'submitted' }),
        serverItem({ examId: 2, title: 'Upcoming', serverState: 'upcoming' }),
        serverItem({ examId: 3, title: 'Available', serverState: 'available' }),
        serverItem({ examId: 4, title: 'Running', serverState: 'in_progress' }),
      ],
      [],
    );

    expect(merged.map((i) => i.title)).toEqual(['Running', 'Available', 'Upcoming', 'Taken']);
  });

  it('gives every state a student-readable label', () => {
    for (const state of [
      'available',
      'upcoming',
      'in_progress',
      'submitted_offline',
      'syncing',
      'synced',
      'completed_past',
      'needs_attention',
      'not_ready',
    ] as const) {
      const label = stateLabel(state);
      expect(label.label.length).toBeGreaterThan(0);
      expect(label.hint.length).toBeGreaterThan(0);
    }
  });
});
