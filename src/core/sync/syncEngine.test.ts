import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExamService } from '../examService';
import { MockExamApi } from '../api/mock';
import { ExamDatabase } from '../storage/db';
import type { SessionRecord } from '../../types';
import { fakeClock } from '../util/clock';
import { config } from '../config';

/**
 * How sync behaves when the network misbehaves — the part of the app that runs unattended
 * after a lab's internet is switched back on.
 */

const MATHS = 92;

let db: ExamDatabase;
let api: MockExamApi;
let service: ExamService;
let clock: ReturnType<typeof fakeClock>;
let session: SessionRecord;
let attemptKey: string;
let counter = 0;

/** Sign in, take the maths exam offline and submit it, leaving a full queue. */
async function submitOfflineExam(): Promise<void> {
  session = await service.login('student', 'student', 'demo');
  await service.prepareExam(session, MATHS);
  attemptKey = service.attemptKeyFor(session.student, MATHS);
  await service.beginAttempt(attemptKey);
  api.setSwitches({ offline: true });
  await service.saveChoice(attemptKey, 8801, 66011);
  await service.saveText(attemptKey, 8802, '1 800 litres must be added.');
  await service.submit(attemptKey, { auto: false });
  await service.settleSync();
  api.setSwitches({ offline: false });
}

beforeEach(async () => {
  counter += 1;
  db = new ExamDatabase(`test_sync_${counter}`);
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

describe('sync engine', () => {
  it('marks items synced only after a 2xx, in stage order', async () => {
    await submitOfflineExam();

    const before = await service.outbox.forAttempt(attemptKey);
    expect(before.map((i) => i.type)).toEqual(['submission', 'finalize']);
    expect(before.every((i) => i.status === 'queued')).toBe(true);

    const run = await service.sync.run();

    expect(run.synced).toBe(2);
    expect(run.flagged).toBe(0);
    const after = await service.outbox.forAttempt(attemptKey);
    expect(after.every((i) => i.status === 'synced')).toBe(true);
    expect((await service.exams.getAttempt(attemptKey))?.status).toBe('synced');
  });

  it('retries a 503 with backoff instead of losing the submission', async () => {
    await submitOfflineExam();
    api.setSwitches({ failSubmissionTimes: 1 });

    const first = await service.sync.run();
    expect(first.retried).toBe(1);
    expect(first.synced).toBe(0);

    const queued = (await service.outbox.forAttempt(attemptKey))[0];
    expect(queued?.status).toBe('queued');
    expect(queued?.attempts).toBe(1);
    expect(queued?.lastHttpStatus).toBe(503);
    expect(queued?.nextAttemptAt).toBeGreaterThan(clock.wall);
    // Nothing from a later stage slipped through while stage 0 was failing.
    expect((await service.outbox.forAttempt(attemptKey))[1]?.status).toBe('queued');

    // Once the backoff has elapsed, the same item goes through.
    clock.advance(config.retry.baseDelayMs * 4);
    const second = await service.sync.run();
    expect(second.synced).toBe(2);
    expect((await service.exams.getAttempt(attemptKey))?.status).toBe('synced');
  });

  it('stops the run when the lab goes offline again, and keeps everything queued', async () => {
    await submitOfflineExam();
    api.setSwitches({ offline: true });

    const run = await service.sync.run();

    expect(run.stoppedOffline).toBe(true);
    expect(run.synced).toBe(0);
    const items = await service.outbox.forAttempt(attemptKey);
    expect(items.every((i) => i.status === 'queued')).toBe(true);
    expect(items[0]?.lastHttpStatus).toBe(0);
  });

  it('flags a fatal rejection for the proctor and does not retry it', async () => {
    await submitOfflineExam();
    api.setSwitches({ fatalSubmission: true });

    const run = await service.sync.run();

    expect(run.flagged).toBe(1);
    const items = await service.outbox.forAttempt(attemptKey);
    expect(items[0]?.status).toBe('needs_attention');
    expect(items[0]?.lastHttpStatus).toBe(422);
    expect(items[0]?.lastError).toMatch(/does not belong/i);

    const attempt = await service.exams.getAttempt(attemptKey);
    expect(attempt?.status).toBe('needs_attention');
    expect(attempt?.lastSyncError).toMatch(/does not belong/i);

    // A second run must not retry a flagged item.
    const again = await service.sync.run();
    expect(again.processed).toBe(0);

    // The proctor's retry clears it once the backend is healthy again.
    api.setSwitches({ fatalSubmission: false });
    const retried = await service.sync.retryAllFlagged();
    expect(retried.synced).toBe(2);
    expect((await service.exams.getAttempt(attemptKey))?.status).toBe('synced');
  });

  it('gives up after the policy’s attempts and flags the item', async () => {
    await submitOfflineExam();
    api.setSwitches({ failSubmissionTimes: config.retry.maxAttempts + 5 });

    for (let i = 0; i < config.retry.maxAttempts + 1; i += 1) {
      await service.sync.run();
      clock.advance(config.retry.maxDelayMs * 2);
    }

    const items = await service.outbox.forAttempt(attemptKey);
    expect(items[0]?.status).toBe('needs_attention');
    expect(items[0]?.attempts).toBeGreaterThanOrEqual(config.retry.maxAttempts);
  });

  it('never duplicates a submission the server already has (idempotency replay)', async () => {
    await submitOfflineExam();

    await service.sync.run();
    expect((await service.exams.getAttempt(attemptKey))?.status).toBe('synced');

    // Force the queue back to "queued" as a crash mid-acknowledgement would, then rerun.
    for (const item of await service.outbox.forAttempt(attemptKey)) {
      if (item.id !== undefined) await service.outbox.requeue(item.id);
    }

    const replay = await service.sync.run();
    expect(replay.synced).toBe(2);
    expect(replay.flagged).toBe(0);

    const serverStatus = await api.attemptStatus(session.token, [
      (await service.exams.getAttempt(attemptKey))?.attemptId ?? 0,
    ]);
    // One attempt, submitted once.
    expect(serverStatus).toHaveLength(1);
    expect(serverStatus[0]?.status).toBe('submitted');
  });

  it('uploads answer files before finalising, and reports progress', async () => {
    session = await service.login('student', 'student', 'demo');
    await service.prepareExam(session, 91); // the physics exam has an upload question
    attemptKey = service.attemptKeyFor(session.student, 91);
    await service.beginAttempt(attemptKey);

    api.setSwitches({ offline: true });
    await service.saveChoice(attemptKey, 7781, 55012);
    await service.addAnswerFile(
      attemptKey,
      7787,
      new File([new Uint8Array([1, 2, 3, 4])], 'graph.png', { type: 'image/png' }),
    );
    await service.submit(attemptKey, { auto: false });
    await service.settleSync();
    api.setSwitches({ offline: false });

    const types: string[] = [];
    const unsubscribe = service.sync.subscribe((progress) => {
      // Progress is emitted several times per item (upload bytes); only the stage order matters.
      if (progress.currentType && types[types.length - 1] !== progress.currentType) {
        types.push(progress.currentType);
      }
    });

    await service.sync.run();
    unsubscribe();

    expect(types).toEqual(['submission', 'attachment', 'finalize']);
    const files = await service.files.listForAttempt(attemptKey, 'answer');
    expect(files[0]?.uploadState).toBe('uploaded');
    expect(files[0]?.serverPath).toContain('attach_');
  });

  it('will not finalise an attempt whose file never arrived', async () => {
    session = await service.login('student', 'student', 'demo');
    await service.prepareExam(session, 91);
    attemptKey = service.attemptKeyFor(session.student, 91);
    await service.beginAttempt(attemptKey);

    api.setSwitches({ offline: true });
    await service.addAnswerFile(
      attemptKey,
      7787,
      new File([new Uint8Array([5, 6, 7])], 'graph.png', { type: 'image/png' }),
    );
    await service.submit(attemptKey, { auto: false });
    await service.settleSync();

    // The upload keeps failing; finalize must never be attempted.
    api.setSwitches({ offline: false, failAttachmentTimes: config.retry.maxAttempts + 5 });

    for (let i = 0; i < config.retry.maxAttempts + 1; i += 1) {
      await service.sync.run();
      clock.advance(config.retry.maxDelayMs * 2);
    }

    const items = await service.outbox.forAttempt(attemptKey);
    const attachment = items.find((i) => i.type === 'attachment');
    const finalize = items.find((i) => i.type === 'finalize');

    expect(items.find((i) => i.type === 'submission')?.status).toBe('synced');
    expect(attachment?.status).toBe('needs_attention');
    expect(finalize?.status).toBe('queued'); // parked, never sent
    expect(finalize?.attempts).toBe(0);
    expect((await service.exams.getAttempt(attemptKey))?.status).toBe('needs_attention');
  });

  it('an expired sign-in parks the queue and signing in again releases it', async () => {
    await submitOfflineExam();

    // The lab was offline for hours and the token did not survive it.
    const expired = { ...session, token: 'no-longer-valid' };
    await service.sessions.save(expired.student, expired.token, 0);

    const run = await service.sync.run();
    expect(run.flagged).toBe(1);

    const parked = (await service.outbox.forAttempt(attemptKey))[0];
    expect(parked?.status).toBe('needs_attention');
    expect(parked?.lastHttpStatus).toBe(401);
    expect(parked?.lastError).toMatch(/sign in again/i);
    // The retry budget is not spent on something only a sign-in can fix.
    expect(parked?.attempts).toBe(0);

    // The student signs in again on the same machine; nothing else is asked of them.
    await service.login('student', 'student', 'demo');
    await service.settleSync();

    expect((await service.outbox.summaryFor(attemptKey)).state).toBe('synced');
    expect((await service.exams.getAttempt(attemptKey))?.status).toBe('synced');
  });

  it('drains every student on the machine, not just whoever is signed in', async () => {
    await submitOfflineExam();
    const firstKey = attemptKey;

    const second = await service.login('student2', 'student', 'demo');
    await service.prepareExam(second, MATHS);
    const secondKey = service.attemptKeyFor(second.student, MATHS);
    await service.beginAttempt(secondKey);
    api.setSwitches({ offline: true });
    await service.saveChoice(secondKey, 8801, 66012);
    await service.submit(secondKey, { auto: false });
    await service.settleSync();
    api.setSwitches({ offline: false });

    const run = await service.sync.run();

    expect(run.synced).toBe(4); // two submissions + two finalizes
    expect((await service.exams.getAttempt(firstKey))?.status).toBe('synced');
    expect((await service.exams.getAttempt(secondKey))?.status).toBe('synced');
  });

  it('a concurrent run does not send anything twice', async () => {
    await submitOfflineExam();

    const [a, b] = await Promise.all([service.sync.run(), service.sync.run()]);

    expect(a.synced + b.synced).toBe(2);
    const items = await service.outbox.forAttempt(attemptKey);
    expect(items.every((i) => i.status === 'synced')).toBe(true);
  });

  it('syncNow reports honestly when the server is still unreachable', async () => {
    await submitOfflineExam();
    api.setSwitches({ offline: true });

    const result = await service.syncNow();

    expect(result.reachable).toBe(false);
    expect(result.result).toBeNull();
    expect((await service.outbox.summaryAll()).queued).toBe(2);
  });

  it('records an audit trail a proctor can read back', async () => {
    await submitOfflineExam();
    await service.sync.run();

    const events = await service.events.recent(50);
    const types = events.map((e) => e.type);

    expect(types).toContain('submitted_offline');
    expect(types).toContain('sync_submission_accepted');
    expect(types).toContain('attempt_synced');

    const diagnostics = JSON.parse(await service.exportDiagnostics()) as {
      attempts: { status: string; checksum: string | null }[];
      outbox: { status: string }[];
    };
    expect(diagnostics.attempts[0]?.status).toBe('synced');
    expect(diagnostics.attempts[0]?.checksum).toMatch(/^sha256:/);
    expect(diagnostics.outbox.every((o) => o.status === 'synced')).toBe(true);
  });
});
