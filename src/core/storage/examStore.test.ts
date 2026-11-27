import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttemptRecord, ExamBundle, Question } from '../../types';
import { ExamDatabase } from './db';
import { ExamStore, isEmptyAnswer } from './examStore';
import { FileStore } from './files';
import { attemptKey, scopeKey } from '../util/ids';
import { startTimer } from '../timer/examTimer';
import { fakeClock } from '../util/clock';

/**
 * Persistence and scoping: the two things that decide whether a shared lab machine is safe.
 */

let db: ExamDatabase;
let store: ExamStore;
let files: FileStore;
let counter = 0;

function question(id: number, kind: Question['kind'] = 'written'): Question {
  return {
    questionId: id,
    number: String(id),
    kind,
    text: `Question ${id}`,
    weight: 2,
    imageUrl: null,
    options:
      kind === 'choice'
        ? [
            { optionId: id * 10 + 1, text: 'A' },
            { optionId: id * 10 + 2, text: 'B' },
          ]
        : [],
    maxChars: 1000,
    groupRef: null,
    partLabel: null,
    inputHint: null,
  };
}

function bundleFor(schema: string, studentId: number, examId: number): ExamBundle {
  const key = attemptKey(schema, studentId, examId);
  return {
    attemptKey: key,
    scopeKey: scopeKey(schema, studentId),
    schemaName: schema,
    studentId,
    examId,
    attemptId: examId * 100 + studentId,
    submissionUuid: `uuid-${examId}-${studentId}`,
    exam: {
      examId,
      title: `Exam ${examId}`,
      subject: 'Physics',
      subjectId: 12,
      instructions: 'Answer all.',
      date: '2026-11-25',
      minutes: 30,
      questionCount: 3,
      totalWeight: 6,
    },
    questions: [question(1, 'choice'), question(2), question(3, 'upload')],
    media: [],
    attachmentRules: {
      enabled: true,
      maxFilesPerQuestion: 2,
      maxFileBytes: 1024 * 1024,
      allowedMime: ['image/png'],
    },
    durationSeconds: 1800,
    bundleChecksum: 'sha256:test',
    issuedAt: new Date().toISOString(),
    downloadedAt: Date.now(),
    verifiedAt: Date.now(),
    mediaFileIds: {},
  };
}

function attemptFor(bundle: ExamBundle, status: AttemptRecord['status'] = 'in_progress'): AttemptRecord {
  const { clock } = fakeClock();
  return {
    attemptKey: bundle.attemptKey,
    scopeKey: bundle.scopeKey,
    schemaName: bundle.schemaName,
    studentId: bundle.studentId,
    examId: bundle.examId,
    attemptId: bundle.attemptId,
    submissionUuid: bundle.submissionUuid,
    status,
    lockReason: null,
    timer: startTimer(bundle.durationSeconds, {
      wallNow: clock.wallNow(),
      monoNow: clock.monoNow(),
      monoSessionId: clock.monoSessionId(),
    }),
    submittedAt: null,
    autoSubmitted: false,
    submissionChecksum: null,
    answeredCount: 0,
    questionCount: bundle.questions.length,
    deviceId: 'device-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncedAt: null,
    lastSyncError: null,
  };
}

beforeEach(async () => {
  counter += 1;
  db = new ExamDatabase(`test_exam_store_${counter}`);
  await db.open();
  store = new ExamStore(db);
  files = new FileStore(db);
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe('bundles and attempts', () => {
  it('round-trips a bundle and its attempt', async () => {
    const bundle = bundleFor('demo', 4812, 91);
    await store.putBundle(bundle);
    await store.putAttempt(attemptFor(bundle));

    const loaded = await store.getBundle(bundle.attemptKey);
    expect(loaded?.questions).toHaveLength(3);
    expect(loaded?.exam.title).toBe('Exam 91');
    expect((await store.getAttempt(bundle.attemptKey))?.status).toBe('in_progress');
  });

  it('lists only the signed-in student’s work on a shared machine', async () => {
    const mine = bundleFor('demo', 4812, 91);
    const theirs = bundleFor('demo', 4813, 91); // same exam, different student, same machine
    await store.putBundle(mine);
    await store.putBundle(theirs);
    await store.putAttempt(attemptFor(mine));
    await store.putAttempt(attemptFor(theirs));

    const mineOnly = await store.attemptsForScope(scopeKey('demo', 4812));
    expect(mineOnly).toHaveLength(1);
    expect(mineOnly[0]?.studentId).toBe(4812);

    // And both are still there for the sync engine to push.
    expect(await store.allAttempts()).toHaveLength(2);
  });

  it('keeps two schools apart even with the same student id', async () => {
    const a = bundleFor('school_a', 1, 5);
    const b = bundleFor('school_b', 1, 5);
    await store.putAttempt(attemptFor(a));
    await store.putAttempt(attemptFor(b));

    expect(await store.attemptsForScope(scopeKey('school_a', 1))).toHaveLength(1);
    expect(await store.attemptsForScope(scopeKey('school_b', 1))).toHaveLength(1);
  });

  it('checkpointing the timer does nothing once the attempt is submitted', async () => {
    const bundle = bundleFor('demo', 4812, 91);
    const attempt = attemptFor(bundle, 'submitted_offline');
    await store.putAttempt(attempt);

    await store.checkpointTimer(bundle.attemptKey, { ...attempt.timer, elapsedSeconds: 999 });

    expect((await store.getAttempt(bundle.attemptKey))?.timer.elapsedSeconds).toBe(0);
  });
});

describe('answers', () => {
  it('autosaves and overwrites one answer per question, counting as it goes', async () => {
    const bundle = bundleFor('demo', 4812, 91);
    await store.putBundle(bundle);
    await store.putAttempt(attemptFor(bundle));
    const key = bundle.attemptKey;

    await store.saveAnswer(key, 1, 'choice', { optionId: 11 });
    await store.saveAnswer(key, 2, 'written', { text: 'first draft' });
    await store.saveAnswer(key, 2, 'written', { text: 'second draft' });

    const answers = await store.answersForAttempt(key);
    expect(answers).toHaveLength(2);
    expect(answers.find((a) => a.questionId === 2)?.text).toBe('second draft');
    expect(answers.find((a) => a.questionId === 2)?.revision).toBe(2);
    expect((await store.getAttempt(key))?.answeredCount).toBe(2);
  });

  it('clearing an answer removes it and updates the count', async () => {
    const bundle = bundleFor('demo', 4812, 91);
    await store.putAttempt(attemptFor(bundle));
    const key = bundle.attemptKey;

    await store.saveAnswer(key, 1, 'choice', { optionId: 11 });
    expect((await store.getAttempt(key))?.answeredCount).toBe(1);

    await store.saveAnswer(key, 1, 'choice', { optionId: null });

    expect(await store.getAnswer(key, 1)).toBeNull();
    expect((await store.getAttempt(key))?.answeredCount).toBe(0);
  });

  it('refuses to write once the attempt is locked', async () => {
    const bundle = bundleFor('demo', 4812, 91);
    await store.putAttempt(attemptFor(bundle, 'submitted_offline'));

    const result = await store.saveAnswer(bundle.attemptKey, 2, 'written', { text: 'too late' });

    expect(result.saved).toBe(false);
    expect(await store.getAnswer(bundle.attemptKey, 2)).toBeNull();
  });

  it('answers for one student are invisible to another on the same machine', async () => {
    const mine = bundleFor('demo', 4812, 91);
    const theirs = bundleFor('demo', 4813, 91);
    await store.putAttempt(attemptFor(mine));
    await store.putAttempt(attemptFor(theirs));

    await store.saveAnswer(mine.attemptKey, 2, 'written', { text: 'my answer' });

    expect(await store.answersForAttempt(theirs.attemptKey)).toHaveLength(0);
    expect(await store.getAnswer(theirs.attemptKey, 2)).toBeNull();
  });

  it('treats blank text and a zero option as "not answered"', () => {
    const base = {
      id: 'x',
      attemptKey: 'k',
      questionId: 1,
      kind: 'written' as const,
      updatedAt: 0,
      revision: 1,
    };
    expect(isEmptyAnswer({ ...base, optionId: null, text: '   ', fileIds: [] })).toBe(true);
    expect(isEmptyAnswer({ ...base, optionId: 0, text: null, fileIds: [] })).toBe(true);
    expect(isEmptyAnswer({ ...base, optionId: null, text: 'a', fileIds: [] })).toBe(false);
    expect(isEmptyAnswer({ ...base, optionId: null, text: null, fileIds: ['f1'] })).toBe(false);
  });
});

describe('answer files', () => {
  it('stores bytes locally, hashes them and attaches them to the answer', async () => {
    const bundle = bundleFor('demo', 4812, 91);
    await store.putBundle(bundle);
    await store.putAttempt(attemptFor(bundle));
    const key = bundle.attemptKey;

    const meta = await files.save({
      attemptKey: key,
      questionId: 3,
      role: 'answer',
      name: 'graph.png',
      blob: new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/png' }),
    });
    await store.attachFile(key, 3, meta.fileId);

    expect(meta.sha256).toHaveLength(64);
    expect(meta.size).toBe(5);
    expect((await store.getAnswer(key, 3))?.fileIds).toEqual([meta.fileId]);

    const readBack = await files.read(meta.fileId);
    expect(await readBack?.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3, 4, 5]).buffer);
  });

  it('removing a file detaches it and deletes the bytes', async () => {
    const bundle = bundleFor('demo', 4812, 91);
    await store.putAttempt(attemptFor(bundle));
    const key = bundle.attemptKey;

    const meta = await files.save({
      attemptKey: key,
      questionId: 3,
      role: 'answer',
      name: 'a.png',
      blob: new Blob([new Uint8Array([9])], { type: 'image/png' }),
    });
    await store.attachFile(key, 3, meta.fileId);
    await store.detachFile(key, 3, meta.fileId);
    await files.remove(meta.fileId);

    expect(await store.getAnswer(key, 3)).toBeNull();
    expect(await files.meta(meta.fileId)).toBeNull();
  });

  it('identical bytes produce an identical digest (the upload idempotency key)', async () => {
    const key = attemptKey('demo', 4812, 91);
    const bytes = () => new Blob([new Uint8Array([7, 7, 7])], { type: 'image/png' });

    const a = await files.save({ attemptKey: key, questionId: 3, role: 'answer', name: 'a', blob: bytes() });
    const b = await files.save({ attemptKey: key, questionId: 3, role: 'answer', name: 'b', blob: bytes() });

    expect(a.sha256).toBe(b.sha256);
    expect(a.fileId).not.toBe(b.fileId);
  });
});
