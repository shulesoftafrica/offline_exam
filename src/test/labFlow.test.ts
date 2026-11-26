import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExamService } from '../core/examService';
import { MockExamApi } from '../core/api/mock';
import { ExamDatabase } from '../core/storage/db';
import type { SessionRecord } from '../types';
import { fakeClock } from '../core/util/clock';

/**
 * The whole lab day, end to end, through the real service: login, bundle, answer offline,
 * submit offline, internet back, sync.
 *
 * This is the test that would have caught every bug that matters in this app, so it is
 * written as the sequence an invigilator actually performs.
 */

const PHYSICS = 91; // seeded in the mock backend: 7 questions, one of them an upload
const MATHS = 92;

let db: ExamDatabase;
let api: MockExamApi;
let service: ExamService;
let clock: ReturnType<typeof fakeClock>;
let counter = 0;

function png(bytes: number[]): File {
  return new File([new Uint8Array(bytes)], 'graph.png', { type: 'image/png' });
}

async function signIn(): Promise<SessionRecord> {
  return service.login('student', 'student', 'demo');
}

/** Download, verify and start an exam, as the intro screen does. */
async function startExam(session: SessionRecord, examId: number): Promise<string> {
  await service.prepareExam(session, examId);
  const key = service.attemptKeyFor(session.student, examId);
  await service.beginAttempt(key);
  return key;
}

beforeEach(async () => {
  counter += 1;
  db = new ExamDatabase(`test_lab_flow_${counter}`);
  await db.open();
  api = new MockExamApi({ latencyMs: 0 }, { persist: false });
  clock = fakeClock();
  service = new ExamService(db, api, clock.clock);
});

afterEach(async () => {
  service.stop();
  db.close();
  await db.delete();
});

describe('the lab day', () => {
  it('runs login → bundle → offline answers → offline submit → reconnect → sync', async () => {
    // ── 1. Online: sign in and see the exams ──────────────────────────────
    const session = await signIn();
    expect(session.student.name).toBe('Nassoro Kimaro');

    const list = await service.examList(session);
    expect(list.fromServer).toBe(true);
    const physics = list.items.find((i) => i.examId === PHYSICS);
    expect(physics?.state).toBe('available');
    // The history exam was already taken: it must not be startable.
    expect(list.items.find((i) => i.examId === 90)?.state).toBe('completed_past');

    // ── 2. Online: download the bundle and verify it ──────────────────────
    const key = await startExam(session, PHYSICS);
    const bundle = await service.exams.getBundle(key);
    expect(bundle?.verifiedAt).not.toBeNull();
    expect(bundle?.questions).toHaveLength(7);
    expect((await service.exams.getAttempt(key))?.status).toBe('in_progress');

    // ── 3. The invigilator switches the internet off ──────────────────────
    api.setSwitches({ offline: true });
    expect(await service.connectivity.probe()).toBe(false);

    // ── 4. The student answers, entirely offline ──────────────────────────
    expect(await service.saveChoice(key, 7781, 55012)).toBe(true);
    expect(await service.saveChoice(key, 7782, 55022)).toBe(true);
    expect(
      await service.saveText(key, 7783, 'Steel floats because the hull displaces enough water.'),
    ).toBe(true);
    expect(await service.saveText(key, 7784, 'Extension is proportional to the load.')).toBe(true);

    const attached = await service.addAnswerFile(key, 7787, png([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(attached.ok).toBe(true);

    const answers = await service.exams.answersForAttempt(key);
    expect(answers).toHaveLength(5);
    expect((await service.exams.getAttempt(key))?.answeredCount).toBe(5);

    // ── 5. A power cut: the service is rebuilt on the same database ───────
    clock.advanceWall(120_000); // the machine was off for two minutes
    const revived = new ExamService(db, api, clock.clock);
    const resumed = await revived.beginAttempt(key);
    expect(resumed.status).toBe('in_progress');
    expect(resumed.timer.elapsedSeconds).toBeGreaterThanOrEqual(120);
    expect(await revived.exams.answersForAttempt(key)).toHaveLength(5);

    // ── 6. Submit, with the internet still off ────────────────────────────
    const result = await revived.submit(key, { auto: false });
    await revived.settleSync();
    expect(result.receipt.answered).toBe(5);
    expect(result.receipt.attachments).toBe(1);
    expect(result.receipt.checksum.startsWith('sha256:')).toBe(true);
    // submission + one attachment + finalize
    expect(result.queuedItems).toBe(3);

    const submitted = await revived.exams.getAttempt(key);
    expect(submitted?.status).toBe('submitted_offline');
    expect(submitted?.submittedAt).not.toBeNull();

    // Locked: a late autosave must not change anything.
    expect(await revived.saveText(key, 7783, 'sneaky edit')).toBe(false);
    expect((await revived.exams.getAnswer(key, 7783))?.text).toContain('Steel floats');

    // The student's list says "submitted, waiting for internet", offline and all.
    const offlineList = await revived.examList(session);
    expect(offlineList.fromServer).toBe(false);
    expect(offlineList.items.find((i) => i.examId === PHYSICS)?.state).toBe('submitted_offline');

    // Nothing reached the server while the lab was off.
    expect((await revived.outbox.summaryAll()).queued).toBe(3);

    // ── 7. The internet comes back ────────────────────────────────────────
    api.setSwitches({ offline: false });
    const sync = await revived.syncNow();
    expect(sync.reachable).toBe(true);
    expect(sync.result?.synced).toBe(3);

    const synced = await revived.exams.getAttempt(key);
    expect(synced?.status).toBe('synced');
    expect(synced?.syncedAt).not.toBeNull();
    expect((await revived.outbox.summaryFor(key)).state).toBe('synced');

    // ── 8. And the server agrees ──────────────────────────────────────────
    const serverStatus = await api.attemptStatus(session.token, [synced?.attemptId ?? 0]);
    expect(serverStatus[0]?.status).toBe('submitted');
    expect(serverStatus[0]?.attachmentsStored).toBe(1);

    const finalList = await revived.examList(session);
    expect(finalList.items.find((i) => i.examId === PHYSICS)?.state).toBe('synced');
    revived.stop();
  });

  it('auto-submits when the time runs out and still syncs later', async () => {
    const session = await signIn();
    const key = await startExam(session, MATHS); // 30 minutes in the seed
    api.setSwitches({ offline: true });

    await service.saveChoice(key, 8801, 66011);

    // Time passes past the duration; the runner's checkpoint reports expiry.
    clock.advance(31 * 60 * 1000);
    const checkpoint = await service.checkpoint(key);
    expect(checkpoint?.expired).toBe(true);

    const result = await service.submit(key, { auto: true });

    await service.settleSync();
    expect(result.receipt.autoSubmitted).toBe(true);

    const attempt = await service.exams.getAttempt(key);
    expect(attempt?.status).toBe('submitted_offline');
    expect(attempt?.lockReason).toBe('time_expired');
    expect(attempt?.timer.elapsedSeconds).toBe(attempt?.timer.durationSeconds);

    api.setSwitches({ offline: false });
    const sync = await service.syncNow();
    expect(sync.result?.flagged).toBe(0);
    expect((await service.exams.getAttempt(key))?.status).toBe('synced');
  });

  it('pressing submit twice does not queue a second submission', async () => {
    const session = await signIn();
    const key = await startExam(session, MATHS);
    api.setSwitches({ offline: true });
    await service.saveChoice(key, 8801, 66011);

    const first = await service.submit(key, { auto: false });

    await service.settleSync();
    const second = await service.submit(key, { auto: false });
    await service.settleSync();

    expect(first.receipt.submittedAt).toBe(second.receipt.submittedAt);
    expect(first.receipt.checksum).toBe(second.receipt.checksum);
    // No attachments in this exam: submission + finalize only, counted once.
    expect(await service.outbox.forAttempt(key)).toHaveLength(2);
  });

  it('keeps two students on one machine completely separate', async () => {
    const first = await service.login('student', 'student', 'demo');
    const firstKey = await startExam(first, MATHS);
    api.setSwitches({ offline: true });
    await service.saveChoice(firstKey, 8801, 66011);
    await service.saveText(firstKey, 8802, '1 800 litres');
    await service.submit(firstKey, { auto: false });
    await service.settleSync();

    // Shift change: the next student signs in on the same machine (internet back on).
    api.setSwitches({ offline: false });
    const second = await service.login('student2', 'student', 'demo');
    expect(second.scopeKey).not.toBe(first.scopeKey);

    const secondList = await service.examList(second);
    // The second student sees Maths as available: the first student's attempt is not theirs.
    expect(secondList.items.find((i) => i.examId === MATHS)?.state).toBe('available');
    expect(secondList.items.find((i) => i.examId === MATHS)?.local).toBeNull();

    // The first student's answers are untouched and still queued for their own attempt.
    expect(await service.exams.answersForAttempt(firstKey)).toHaveLength(2);
    expect(await service.pendingForOtherStudents(second.scopeKey)).toBe(1);

    const secondKey = await startExam(second, MATHS);
    expect(secondKey).not.toBe(firstKey);
    await service.saveChoice(secondKey, 8801, 66012);

    expect((await service.exams.getAnswer(firstKey, 8801))?.optionId).toBe(66011);
    expect((await service.exams.getAnswer(secondKey, 8801))?.optionId).toBe(66012);

    // Signing out must not throw away either student's work.
    await service.logout();
    expect((await service.exams.allAttempts()).length).toBe(2);
    expect((await service.outbox.all()).length).toBeGreaterThan(0);
  });

  it('refuses attachments that break the exam’s own rules', async () => {
    const session = await signIn();
    const key = await startExam(session, PHYSICS);
    api.setSwitches({ offline: true });

    const tooBig = new File([new Uint8Array(11 * 1024 * 1024)], 'huge.png', { type: 'image/png' });
    const rejectedSize = await service.addAnswerFile(key, 7787, tooBig);
    expect(rejectedSize.ok).toBe(false);

    const wrongType = new File([new Uint8Array([1, 2])], 'notes.txt', { type: 'text/plain' });
    const rejectedType = await service.addAnswerFile(key, 7787, wrongType);
    expect(rejectedType.ok).toBe(false);

    // Up to three per question in the seeded rules; the fourth is refused.
    for (let i = 0; i < 3; i += 1) {
      const ok = await service.addAnswerFile(key, 7787, png([i, i + 1, i + 2]));
      expect(ok.ok).toBe(true);
    }
    const fourth = await service.addAnswerFile(key, 7787, png([9, 9, 9]));
    expect(fourth.ok).toBe(false);
    expect(await service.files.listForQuestion(key, 7787)).toHaveLength(3);
  });

  it('cannot start an exam that is already taken', async () => {
    const session = await signIn();
    await expect(service.prepareExam(session, 90)).rejects.toThrow(/already been taken/i);
  });

  it('cannot start an exam before its date', async () => {
    const session = await signIn();
    await expect(service.prepareExam(session, 93)).rejects.toThrow(/opens on/i);
  });

  it('cannot download a bundle with the internet off', async () => {
    const session = await signIn();
    api.setSwitches({ offline: true });
    await expect(service.prepareExam(session, PHYSICS)).rejects.toMatchObject({ status: 0 });
  });
});
