import type {
  AnswerRecord,
  AttemptKey,
  AttemptRecord,
  ExamBundle,
  ExamListItem,
  MergedExamItem,
  SessionRecord,
  StoredFileMeta,
  StudentProfile,
  SyncSummary,
} from '../types';
import { examApi } from './api';
import { ApiError, type ExamApi } from './api/types';
import { config } from './config';
import { mergeExamList } from './examMerge';
import { downloadBundle, type BundleProgressFn, type BundleResult } from './exam/bundle';
import { submitOffline, type SubmitResult } from './exam/submission';
import {
  db,
  requestPersistentStorage,
  storageEstimate,
  type ExamDatabase,
  type StorageEstimate,
} from './storage/db';
import { EventLog } from './storage/events';
import { ExamStore } from './storage/examStore';
import { FileStore, validateFile, type StorageBackend } from './storage/files';
import { OutboxStore, summarise } from './storage/outbox';
import { SessionStore } from './storage/sessions';
import {
  ConnectivityWatcher,
  defaultConnectivityOptions,
  type ConnectivityListener,
  type ConnectivityState,
} from './sync/connectivity';
import { SyncEngine, type SyncListener } from './sync/syncEngine';
import { isExpired, readClock, remainingSeconds, resumeTimer, startTimer, tick } from './timer/examTimer';
import { systemClock, type Clock } from './util/clock';
import { describeError, log } from './util/logger';
import { attemptKey as makeAttemptKey, scopeKey as makeScopeKey } from './util/ids';

/**
 * The single object the React layer talks to.
 *
 * Everything below it is framework-agnostic and separately testable; everything above it is
 * presentation. The service owns the wiring (database, stores, API driver, sync engine,
 * connectivity watcher) and the few workflows that span them: login, start exam, autosave,
 * submit, drain.
 */
export class ExamService {
  readonly sessions: SessionStore;
  readonly exams: ExamStore;
  readonly files: FileStore;
  readonly outbox: OutboxStore;
  readonly events: EventLog;
  readonly sync: SyncEngine;
  readonly connectivity: ConnectivityWatcher;

  private started = false;

  /**
   * Background work (drains kicked off by a submission or by the lab coming back online) is
   * chained rather than fired loose, so it is serialised and `settleSync()` can wait for it.
   */
  private background: Promise<unknown> = Promise.resolve();

  constructor(
    database: ExamDatabase = db,
    private readonly api: ExamApi = examApi(),
    private readonly clock: Clock = systemClock,
  ) {
    this.sessions = new SessionStore(database);
    this.exams = new ExamStore(database);
    this.files = new FileStore(database);
    this.outbox = new OutboxStore(database, () => this.clock.wallNow());
    this.events = new EventLog(database);

    const recordEvent = (
      type: string,
      detail?: unknown,
      keys?: { attemptKey?: AttemptKey },
    ): void => {
      void this.events.record(type, detail, keys);
    };

    this.sync = new SyncEngine({
      api: this.api,
      examStore: this.exams,
      fileStore: this.files,
      outbox: this.outbox,
      sessions: this.sessions,
      recordEvent,
      now: () => this.clock.wallNow(),
    });

    this.connectivity = new ConnectivityWatcher(this.api, defaultConnectivityOptions);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Boot: ask for persistent storage, detect the file backend, start watching
   * connectivity, and drain anything the last shift left behind as soon as the backend is
   * reachable.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const persisted = await requestPersistentStorage();
    const backend = await this.files.detectBackend();
    await this.events.record('app_started', { persisted, backend, driver: config.apiDriver });

    this.connectivity.subscribe((state) => {
      if (state.reachability === 'online') this.inBackground(() => this.drain('connectivity'));
    });
    this.connectivity.start();
    await this.sync.refreshSummary();
  }

  stop(): void {
    this.connectivity.stop();
    this.started = false;
  }

  onConnectivity(listener: ConnectivityListener): () => void {
    return this.connectivity.subscribe(listener);
  }

  onSync(listener: SyncListener): () => void {
    return this.sync.subscribe(listener);
  }

  /** Drain the outbox if the backend is reachable. Returns null when it is not. */
  async drain(reason: string): Promise<ReturnType<SyncEngine['run']> | null> {
    const pending = await this.outbox.pending();
    if (pending.length === 0) {
      await this.sync.refreshSummary();
      return null;
    }
    log.info('Sync run requested', { reason, pending: pending.length });
    return this.sync.run();
  }

  /** The proctor's "Sync Now": probe first so the button reports the truth. */
  async syncNow(): Promise<{ reachable: boolean; result: Awaited<ReturnType<SyncEngine['run']>> | null }> {
    const reachable = await this.connectivity.probe();
    if (!reachable) return { reachable, result: null };
    // Wait out any background drain, so the button's report covers this press and not an
    // empty result because something else was already running.
    await this.sync.settle();
    const result = await this.sync.run();
    return { reachable, result };
  }

  /** Resolves once no background drain is queued or in flight. */
  async settleSync(): Promise<void> {
    await this.background;
    await this.sync.settle();
  }

  private inBackground(task: () => Promise<unknown>): void {
    this.background = this.background.then(task).catch(() => undefined);
  }

  async retryFlagged(): Promise<void> {
    await this.sync.retryAllFlagged();
  }

  /**
   * Requeue the items of one student that were flagged only because their sign-in had
   * expired (HTTP 401/403). Their attempts go back to `submitted_offline` so the student
   * sees "waiting for internet" rather than "needs the teacher".
   *
   * @returns how many items were released
   */
  private async releaseAfterReauth(scopeKey: string): Promise<number> {
    const items = await this.outbox.forScope(scopeKey);
    const stale = items.filter(
      (item) =>
        item.status === 'needs_attention' &&
        (item.lastHttpStatus === 401 || item.lastHttpStatus === 403),
    );
    for (const item of stale) {
      if (item.id !== undefined) await this.outbox.requeue(item.id);
    }

    const touched = new Set(stale.map((item) => item.attemptKey));
    for (const attemptKey of touched) {
      const attempt = await this.exams.getAttempt(attemptKey);
      if (attempt && attempt.status === 'needs_attention') {
        await this.exams.setStatus(attemptKey, 'submitted_offline', { lastSyncError: null });
      }
    }

    return stale.length;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async login(username: string, password: string, school?: string | null): Promise<SessionRecord> {
    const response = await this.api.login({ username, password, school: school ?? null });
    const serverMs = Date.parse(response.serverTime);
    const skew = Number.isFinite(serverMs) ? serverMs - this.clock.wallNow() : 0;
    const session = await this.sessions.save(response.student, response.token, skew);
    await this.events.record('login', { studentId: response.student.studentId, skewMs: skew }, {
      scopeKey: session.scopeKey,
    });

    // Anything of this student's that was flagged because their token had expired is now
    // sendable again — signing in is exactly the fix that queue was waiting for.
    const released = await this.releaseAfterReauth(session.scopeKey);
    if (released > 0) {
      await this.events.record('reauth_released', { items: released }, { scopeKey: session.scopeKey });
      this.inBackground(() => this.drain('after_login'));
    }

    return session;
  }

  /**
   * Sign back in without the network, for a refresh during the offline window. Only
   * succeeds for a student whose session is cached on this machine.
   */
  async resumeOffline(username: string): Promise<SessionRecord | null> {
    const wanted = username.trim().toLowerCase();
    const all = await this.sessions.all();
    const match = all.find((s) => s.student.username.toLowerCase() === wanted);
    if (!match) return null;
    await this.sessions.setActive(match.scopeKey);
    await this.sessions.touch(match.scopeKey);
    await this.events.record('offline_resume', { studentId: match.student.studentId }, {
      scopeKey: match.scopeKey,
    });
    return match;
  }

  async activeSession(): Promise<SessionRecord | null> {
    return this.sessions.active();
  }

  /**
   * Sign out of the UI. Exam data, the outbox and other students' sessions are untouched —
   * see `docs/ARCHITECTURE.md` §7.
   */
  async logout(): Promise<void> {
    const session = await this.sessions.active();
    if (session) {
      await this.events.record('logout', null, { scopeKey: session.scopeKey });
      // Best-effort token revoke; failing offline is expected and harmless.
      try {
        await this.api.logout(session.token);
      } catch {
        /* offline: the token simply expires server-side */
      }
    }
    await this.sessions.clearActive();
  }

  // ── Exam list ─────────────────────────────────────────────────────────────

  /**
   * The exam list, merged from the server (when reachable) and this machine.
   *
   * With the lab offline this still returns everything local, which is what a student who
   * refreshed mid-exam needs to see.
   */
  async examList(session: SessionRecord): Promise<{ items: MergedExamItem[]; fromServer: boolean; error: string | null }> {
    let serverItems: ExamListItem[] = [];
    let fromServer = false;
    let error: string | null = null;

    try {
      serverItems = await this.api.listExams(session.token);
      fromServer = true;
    } catch (err) {
      error =
        err instanceof ApiError && err.isOffline
          ? 'Showing exams saved on this computer (no internet).'
          : describeError(err);
    }

    const attempts = await this.exams.attemptsForScope(session.scopeKey);
    const bundles = await this.exams.bundlesForScope(session.scopeKey);

    const attemptsByExamId = new Map(attempts.map((a) => [a.examId, a]));
    const bundlesByExamId = new Map(bundles.map((b) => [b.examId, b]));
    const syncByAttemptKey = new Map<string, SyncSummary>();
    for (const attempt of attempts) {
      syncByAttemptKey.set(attempt.attemptKey, await this.outbox.summaryFor(attempt.attemptKey));
    }

    return {
      items: mergeExamList({ serverItems, attemptsByExamId, bundlesByExamId, syncByAttemptKey }),
      fromServer,
      error,
    };
  }

  // ── Starting an exam ──────────────────────────────────────────────────────

  /** Downloads and verifies the bundle. Requires the network — this is step 2 of the lab flow. */
  async prepareExam(
    session: SessionRecord,
    examId: number,
    onProgress?: BundleProgressFn,
  ): Promise<BundleResult> {
    const deviceId = await this.sessions.deviceId();
    return downloadBundle(session.token, session.student, examId, deviceId, {
      api: this.api,
      examStore: this.exams,
      fileStore: this.files,
      reading: readClock(this.clock),
      onProgress,
      recordEvent: (type, detail) =>
        void this.events.record(type, detail, {
          attemptKey: makeAttemptKey(session.student.schemaName, session.student.studentId, examId),
          scopeKey: session.scopeKey,
        }),
    });
  }

  /**
   * Begin (or resume) the attempt. Starting the clock is a separate, explicit step from
   * downloading, so a student is never charged time for a slow download.
   */
  async beginAttempt(key: AttemptKey): Promise<AttemptRecord> {
    const attempt = await this.exams.getAttempt(key);
    if (!attempt) throw new Error('This exam has not been downloaded on this machine.');
    const reading = readClock(this.clock);

    if (attempt.status === 'ready' || attempt.status === 'bundling') {
      const bundle = await this.exams.getBundle(key);
      const duration = bundle?.durationSeconds ?? attempt.timer.durationSeconds;
      const timer = startTimer(duration, reading);
      await this.exams.patchAttempt(key, { status: 'in_progress', timer, lockReason: null });
      await this.events.record('attempt_started', { durationSeconds: duration }, { attemptKey: key });
      return (await this.exams.getAttempt(key)) as AttemptRecord;
    }

    if (attempt.status === 'in_progress') {
      // Resume: account for the time the page was not running.
      const timer = resumeTimer(attempt.timer, reading);
      await this.exams.checkpointTimer(key, timer);
      await this.events.record(
        'attempt_resumed',
        { elapsedSeconds: Math.round(timer.elapsedSeconds), remaining: remainingSeconds(timer) },
        { attemptKey: key },
      );
      return (await this.exams.getAttempt(key)) as AttemptRecord;
    }

    return attempt;
  }

  async loadRunner(key: AttemptKey): Promise<{
    bundle: ExamBundle;
    attempt: AttemptRecord;
    answers: AnswerRecord[];
    files: StoredFileMeta[];
  } | null> {
    const bundle = await this.exams.getBundle(key);
    const attempt = await this.exams.getAttempt(key);
    if (!bundle || !attempt) return null;
    return {
      bundle,
      attempt,
      answers: await this.exams.answersForAttempt(key),
      files: await this.files.listForAttempt(key, 'answer'),
    };
  }

  // ── During the exam ───────────────────────────────────────────────────────

  async saveChoice(key: AttemptKey, questionId: number, optionId: number | null): Promise<boolean> {
    const { saved } = await this.exams.saveAnswer(key, questionId, 'choice', { optionId });
    return saved;
  }

  async saveText(key: AttemptKey, questionId: number, text: string): Promise<boolean> {
    const { saved } = await this.exams.saveAnswer(key, questionId, 'written', { text });
    return saved;
  }

  /** Validate, store the bytes locally, then attach to the answer. All offline. */
  async addAnswerFile(
    key: AttemptKey,
    questionId: number,
    file: File,
  ): Promise<{ ok: true; meta: StoredFileMeta } | { ok: false; reason: string }> {
    const bundle = await this.exams.getBundle(key);
    const rules = bundle?.attachmentRules ?? {
      enabled: true,
      maxFilesPerQuestion: config.limits.maxFilesPerQuestion,
      maxFileBytes: config.limits.maxFileBytes,
      allowedMime: config.limits.allowedMime,
    };
    if (!rules.enabled) {
      return { ok: false, reason: 'This exam does not accept attachments.' };
    }

    const existing = await this.files.listForQuestion(key, questionId);
    const answerFiles = existing.filter((f) => f.role === 'answer');
    if (answerFiles.length >= rules.maxFilesPerQuestion) {
      return {
        ok: false,
        reason: `You may attach at most ${rules.maxFilesPerQuestion} file(s) to this question.`,
      };
    }

    const check = validateFile(file, {
      maxFileBytes: rules.maxFileBytes,
      allowedMime: rules.allowedMime,
    });
    if (!check.ok) return { ok: false, reason: check.reason };

    const meta = await this.files.save({
      attemptKey: key,
      questionId,
      role: 'answer',
      name: file.name,
      blob: file,
    });
    const attached = await this.exams.attachFile(key, questionId, meta.fileId);
    if (!attached) {
      // The attempt was locked between the checks and the write: do not leave bytes behind.
      await this.files.remove(meta.fileId);
      return { ok: false, reason: 'This exam is already submitted.' };
    }
    await this.events.record(
      'answer_file_added',
      { questionId, bytes: meta.size, sha256: meta.sha256 },
      { attemptKey: key },
    );
    return { ok: true, meta };
  }

  async removeAnswerFile(key: AttemptKey, questionId: number, fileId: string): Promise<boolean> {
    const detached = await this.exams.detachFile(key, questionId, fileId);
    if (detached) {
      await this.files.remove(fileId);
      await this.events.record('answer_file_removed', { questionId, fileId }, { attemptKey: key });
    }
    return detached;
  }

  async fileUrl(fileId: string): Promise<string | null> {
    const blob = await this.files.read(fileId);
    return blob ? URL.createObjectURL(blob) : null;
  }

  /** Called on an interval by the runner; persists the clock and reports expiry. */
  async checkpoint(key: AttemptKey): Promise<{ attempt: AttemptRecord; expired: boolean } | null> {
    const attempt = await this.exams.getAttempt(key);
    if (!attempt || attempt.status !== 'in_progress') return null;
    const timer = tick(attempt.timer, readClock(this.clock));
    await this.exams.checkpointTimer(key, timer);
    return { attempt: { ...attempt, timer }, expired: isExpired(timer) };
  }

  // ── Submitting ────────────────────────────────────────────────────────────

  async submit(key: AttemptKey, options: { auto: boolean }): Promise<SubmitResult> {
    const bundle = await this.exams.getBundle(key);
    if (!bundle) throw new Error('This exam is not on this machine.');

    // Settle the clock before locking, so the receipt's elapsed time is the real one.
    const attempt = await this.exams.getAttempt(key);
    if (attempt && attempt.status === 'in_progress') {
      await this.exams.checkpointTimer(key, tick(attempt.timer, readClock(this.clock)));
    }

    const result = await submitOffline(bundle, options, {
      examStore: this.exams,
      fileStore: this.files,
      outbox: this.outbox,
      reading: readClock(this.clock),
      recordEvent: (type, detail) => void this.events.record(type, detail, { attemptKey: key }),
    });

    await this.sync.refreshSummary();
    // If the internet happens to be on already, this sends immediately; offline it is a
    // no-op and the queue waits. Never awaited: a student must not wait for a network that
    // is switched off.
    this.inBackground(() => this.drain('after_submit'));
    return result;
  }

  // ── Machine-wide status (the proctor screen) ──────────────────────────────

  async machineStatus(): Promise<{
    attempts: (AttemptRecord & { sync: SyncSummary; studentName: string | null; examTitle: string | null })[];
    summary: SyncSummary;
    storage: StorageEstimate;
    backend: StorageBackend;
    deviceId: string;
  }> {
    const attempts = await this.exams.allAttempts();
    const sessions = await this.sessions.all();
    const nameByScope = new Map(sessions.map((s) => [s.scopeKey, s.student.name]));

    const rows = [] as (AttemptRecord & {
      sync: SyncSummary;
      studentName: string | null;
      examTitle: string | null;
    })[];
    for (const attempt of attempts) {
      const bundle = await this.exams.getBundle(attempt.attemptKey);
      rows.push({
        ...attempt,
        sync: await this.outbox.summaryFor(attempt.attemptKey),
        studentName: nameByScope.get(attempt.scopeKey) ?? null,
        examTitle: bundle?.exam.title ?? null,
      });
    }

    return {
      attempts: rows,
      summary: summarise(await this.outbox.all()),
      storage: await storageEstimate(),
      backend: await this.files.detectBackend(),
      deviceId: await this.sessions.deviceId(),
    };
  }

  /** How many attempts belonging to *other* students still need to reach the server. */
  async pendingForOtherStudents(scopeKey: string): Promise<number> {
    const unsynced = await this.exams.unsyncedAttempts();
    return unsynced.filter((a) => a.scopeKey !== scopeKey).length;
  }

  /**
   * Everything an ICT officer needs to explain a machine, as one JSON blob. No answer text
   * and no files — it is a diagnostic, not a copy of the exam.
   */
  async exportDiagnostics(): Promise<string> {
    const status = await this.machineStatus();
    const outbox = await this.outbox.all();
    const events = await this.events.recent(300);
    return JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        deviceId: status.deviceId,
        storage: status.storage,
        fileBackend: status.backend,
        apiDriver: config.apiDriver,
        apiBaseUrl: config.apiBaseUrl,
        connectivity: this.connectivity.current(),
        summary: status.summary,
        attempts: status.attempts.map((a) => ({
          attemptKey: a.attemptKey,
          attemptId: a.attemptId,
          examId: a.examId,
          examTitle: a.examTitle,
          studentId: a.studentId,
          studentName: a.studentName,
          status: a.status,
          answered: a.answeredCount,
          questions: a.questionCount,
          submittedAt: a.submittedAt,
          syncedAt: a.syncedAt,
          elapsedSeconds: Math.round(a.timer.elapsedSeconds),
          durationSeconds: a.timer.durationSeconds,
          checksum: a.submissionChecksum,
          lastSyncError: a.lastSyncError,
          sync: a.sync,
        })),
        outbox: outbox.map((o) => ({
          id: o.id,
          type: o.type,
          attemptKey: o.attemptKey,
          status: o.status,
          attempts: o.attempts,
          lastHttpStatus: o.lastHttpStatus,
          lastError: o.lastError,
          nextAttemptAt: o.nextAttemptAt,
        })),
        events,
      },
      null,
      2,
    );
  }

  scopeKeyFor(student: StudentProfile): string {
    return makeScopeKey(student.schemaName, student.studentId);
  }

  attemptKeyFor(student: StudentProfile, examId: number): AttemptKey {
    return makeAttemptKey(student.schemaName, student.studentId, examId);
  }

  connectivityState(): ConnectivityState {
    return this.connectivity.current();
  }
}

let service: ExamService | null = null;

export function examService(): ExamService {
  if (!service) service = new ExamService();
  return service;
}

export function setExamService(next: ExamService | null): void {
  service = next;
}
