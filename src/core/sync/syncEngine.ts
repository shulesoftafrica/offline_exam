import type { AttemptKey, OutboxItem, SessionRecord, SyncSummary } from '../../types';
import { ApiError, type ExamApi } from '../api/types';
import { config } from '../config';
import type { ExamStore } from '../storage/examStore';
import type { FileStore } from '../storage/files';
import { selectDueItems, summarise, type OutboxStore } from '../storage/outbox';
import type { SessionStore } from '../storage/sessions';
import { hasAttemptsLeft, isRetryableStatus, nextDelayMs } from '../util/backoff';
import { describeError, log } from '../util/logger';
import { payloadForSync } from '../exam/submission';

/**
 * The reconnection engine.
 *
 * Drains the outbox whenever the backend is reachable, in stage order per attempt
 * (answers → files → finalize), with exponential backoff and strict idempotency. It runs
 * for **every student on the machine**, not just whoever is signed in, because the lab's
 * last shift must sync even after the next one logs in.
 *
 * An item becomes `synced` only on an explicit 2xx. Anything else either retries or is
 * flagged `needs_attention` with the server's own message kept for the proctor.
 */

export interface SyncProgress {
  running: boolean;
  /** Item currently in flight, if any. */
  currentType: OutboxItem['type'] | null;
  currentAttemptKey: AttemptKey | null;
  uploadedBytes: number;
  totalBytes: number;
  lastRunAt: number | null;
  lastError: string | null;
  summary: SyncSummary;
}

export type SyncListener = (progress: SyncProgress) => void;

export interface SyncRunResult {
  processed: number;
  synced: number;
  retried: number;
  flagged: number;
  /** True when the run stopped because the backend went away again. */
  stoppedOffline: boolean;
}

export interface SyncEngineDeps {
  api: ExamApi;
  examStore: ExamStore;
  fileStore: FileStore;
  outbox: OutboxStore;
  sessions: SessionStore;
  recordEvent?: (type: string, detail?: unknown, keys?: { attemptKey?: AttemptKey }) => void;
  now?: () => number;
  random?: () => number;
}

export class SyncEngine {
  private running = false;
  /** The current drain, so a concurrent caller never starts a second one. */
  private inFlight: Promise<SyncRunResult> | null = null;
  private listeners = new Set<SyncListener>();
  private progress: SyncProgress = {
    running: false,
    currentType: null,
    currentAttemptKey: null,
    uploadedBytes: 0,
    totalBytes: 0,
    lastRunAt: null,
    lastError: null,
    summary: summarise([]),
  };

  constructor(private readonly deps: SyncEngineDeps) {}

  private get now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    listener({ ...this.progress });
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<SyncProgress> = {}): void {
    this.progress = { ...this.progress, ...patch };
    const snapshot = { ...this.progress };
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        log.warn('Sync listener threw', error);
      }
    }
  }

  async refreshSummary(): Promise<SyncSummary> {
    const summary = await this.deps.outbox.summaryAll();
    this.emit({ summary });
    return summary;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Drain whatever is due. Re-entrant-safe: a second call while a run is in flight does
   * nothing rather than sending anything twice.
   */
  async run(): Promise<SyncRunResult> {
    if (this.inFlight) {
      return { processed: 0, synced: 0, retried: 0, flagged: 0, stoppedOffline: false };
    }
    const promise = this.execute();
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Resolves once no run is in flight.
   *
   * Submitting an exam kicks off a drain without waiting for it (the student must never be
   * made to wait for a network that is switched off), so anything that needs the queue to be
   * settled — a test, or "is it safe to shut this machine down?" — awaits this.
   */
  async settle(): Promise<void> {
    while (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* the run reports its own failures through the outbox */
      }
    }
  }

  private async execute(): Promise<SyncRunResult> {
    const result: SyncRunResult = {
      processed: 0,
      synced: 0,
      retried: 0,
      flagged: 0,
      stoppedOffline: false,
    };

    this.running = true;
    this.emit({ running: true, lastError: null });

    try {
      // A run is only started when the backend looks reachable, so anything that was merely
      // waiting for a network is due again now.
      await this.deps.outbox.releaseTransportWaits();

      // Keep taking the next due batch until nothing is left, so a 40-file attempt drains
      // in one visit rather than one item per tick.
      for (;;) {
        const outstanding = await this.deps.outbox.outstanding();
        const due = selectDueItems(outstanding, this.now);
        if (due.length === 0) break;

        for (const item of due) {
          result.processed += 1;
          const outcome = await this.processItem(item);
          if (outcome === 'synced') result.synced += 1;
          else if (outcome === 'retry') result.retried += 1;
          else if (outcome === 'flagged') result.flagged += 1;
          else if (outcome === 'offline') {
            result.stoppedOffline = true;
            break;
          }
        }
        if (result.stoppedOffline) break;
      }
    } finally {
      this.running = false;
      const summary = await this.deps.outbox.summaryAll();
      this.emit({
        running: false,
        currentType: null,
        currentAttemptKey: null,
        lastRunAt: this.now,
        summary,
      });
    }

    return result;
  }

  private async sessionFor(item: OutboxItem): Promise<SessionRecord | null> {
    return this.deps.sessions.get(item.scopeKey);
  }

  private async processItem(
    item: OutboxItem,
  ): Promise<'synced' | 'retry' | 'flagged' | 'offline' | 'skipped'> {
    if (item.id === undefined) return 'skipped';

    const session = await this.sessionFor(item);
    if (!session) {
      // The student's session row is gone but their work is not: flag it rather than
      // dropping an exam on the floor.
      await this.fail(item, 'No saved login for this student on this machine.', null);
      return 'flagged';
    }

    this.emit({ currentType: item.type, currentAttemptKey: item.attemptKey });
    await this.deps.outbox.markUploading(item.id);
    await this.deps.examStore.setStatus(item.attemptKey, 'syncing');

    try {
      switch (item.type) {
        case 'submission':
          await this.sendSubmission(item, session);
          break;
        case 'attachment':
          await this.sendAttachment(item, session);
          break;
        case 'finalize':
          await this.sendFinalize(item, session);
          break;
        default:
          throw new Error(`Unknown outbox item type: ${String(item.type)}`);
      }

      await this.deps.outbox.markSynced(item.id, 200);
      await this.afterItemSynced(item);
      return 'synced';
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      const status = apiError?.status ?? 0;
      const message = apiError?.serverMessage ?? describeError(error);

      // An expired or revoked token is not a broken submission: the work is fine, the
      // sign-in is not. A lab that was offline for hours can easily outlive a token, so this
      // gets its own message and is released automatically the next time that student signs
      // in on this machine (see ExamService.login).
      if (status === 401 || status === 403) {
        await this.fail(
          item,
          'The sign-in for this student has expired on this computer. Sign in again to send this exam.',
          status,
          item.attempts,
        );
        return 'flagged';
      }

      // A replayed submission the server already has is a success, not a failure.
      if (apiError?.code === 'already_synced') {
        await this.deps.outbox.markSynced(item.id, status);
        await this.afterItemSynced(item);
        return 'synced';
      }

      // A transport failure (`status === 0`) means there was no server to answer: the lab
      // switch is still off, or the gateway is down. That must NOT consume the retry budget
      // — otherwise an app left running through a two-hour offline window would flag every
      // queued exam as `needs_attention` before the internet even came back. Only a real
      // server response counts as an attempt.
      const transportFailure = status === 0;
      const attempts = transportFailure ? item.attempts : item.attempts + 1;
      const retryable =
        isRetryableStatus(status) &&
        (transportFailure || hasAttemptsLeft(item.attempts, config.retry));

      if (retryable) {
        const delay = transportFailure
          ? config.retry.baseDelayMs
          : nextDelayMs(attempts, config.retry, this.deps.random ?? Math.random);
        await this.deps.outbox.markRetry(item.id, attempts, this.now + delay, message, status);
        await this.deps.examStore.patchAttempt(item.attemptKey, { lastSyncError: message });
        this.deps.recordEvent?.(
          'sync_retry',
          { type: item.type, status, attempts, delayMs: delay, message },
          { attemptKey: item.attemptKey },
        );
        if (transportFailure) {
          // Nothing left this machine, so the attempt must not keep saying "Sending…" to a
          // student whose lab is simply still offline. It goes back to the state its
          // confirmation screen describes, unless part of it did get through earlier.
          await this.restoreOfflineStatus(item);
        }
        this.emit({ lastError: message });
        // No response at all means the lab is offline again: stop the run.
        return transportFailure ? 'offline' : 'retry';
      }

      await this.fail(item, message, status, attempts);
      return 'flagged';
    }
  }

  /**
   * After a transport failure: `submitted_offline` when nothing of this attempt has reached
   * the server yet, `syncing` when part of it has (so the proctor can see it is half-sent).
   */
  private async restoreOfflineStatus(item: OutboxItem): Promise<void> {
    const items = await this.deps.outbox.forAttempt(item.attemptKey);
    const partlySent = items.some((i) => i.status === 'synced');
    await this.deps.examStore.setStatus(
      item.attemptKey,
      partlySent ? 'syncing' : 'submitted_offline',
    );
  }

  private async fail(
    item: OutboxItem,
    message: string,
    status: number | null,
    attempts = item.attempts + 1,
  ): Promise<void> {
    if (item.id === undefined) return;
    await this.deps.outbox.markNeedsAttention(item.id, attempts, message, status);
    await this.deps.examStore.setStatus(item.attemptKey, 'needs_attention', {
      lastSyncError: message,
    });
    this.deps.recordEvent?.(
      'sync_failed',
      { type: item.type, status, attempts, message },
      { attemptKey: item.attemptKey },
    );
    this.emit({ lastError: message });
    log.error('Sync item needs attention', { type: item.type, status, message });
  }

  /** When an attempt's whole queue is synced, the attempt itself is `synced`. */
  private async afterItemSynced(item: OutboxItem): Promise<void> {
    const items = await this.deps.outbox.forAttempt(item.attemptKey);
    const summary = summarise(items);
    if (summary.state === 'synced') {
      await this.deps.examStore.setStatus(item.attemptKey, 'synced', {
        syncedAt: this.now,
        lastSyncError: null,
      });
      this.deps.recordEvent?.('attempt_synced', { attemptId: item.attemptId }, {
        attemptKey: item.attemptKey,
      });
      log.info('Attempt fully synced', { attemptKey: item.attemptKey });
    }
    await this.refreshSummary();
  }

  // ── Senders ───────────────────────────────────────────────────────────────

  private async sendSubmission(item: OutboxItem, session: SessionRecord): Promise<void> {
    const attempt = await this.deps.examStore.getAttempt(item.attemptKey);
    if (!attempt) throw new ApiError('The attempt is missing locally.', { status: 422 });

    const payload = await payloadForSync(item.attemptKey, {
      examStore: this.deps.examStore,
      fileStore: this.deps.fileStore,
    });

    const response = await this.deps.api.postSubmission(session.token, {
      attemptId: item.attemptId,
      submissionUuid: item.submissionUuid,
      deviceId: attempt.deviceId,
      clientStartedAt: new Date(attempt.timer.startedAtWall).toISOString(),
      clientSubmittedAt: new Date(attempt.submittedAt ?? this.now).toISOString(),
      clientElapsedSeconds: Math.round(attempt.timer.elapsedSeconds),
      answerChecksum: attempt.submissionChecksum ?? payload.answerChecksum,
      answers: payload.answers,
      attachmentManifest: payload.attachmentManifest,
    });

    this.deps.recordEvent?.(
      'sync_submission_accepted',
      { accepted: response.accepted, alreadySynced: response.alreadySynced },
      { attemptKey: item.attemptKey },
    );
  }

  private async sendAttachment(item: OutboxItem, session: SessionRecord): Promise<void> {
    if (!item.fileId || item.questionId == null) {
      throw new ApiError('The queued file reference is incomplete.', { status: 422 });
    }
    const meta = await this.deps.fileStore.meta(item.fileId);
    if (!meta) {
      throw new ApiError('The answer file is no longer on this machine.', { status: 422 });
    }
    const blob = await this.deps.fileStore.read(item.fileId);
    if (!blob) {
      throw new ApiError('The answer file could not be read from this machine.', { status: 422 });
    }

    await this.deps.fileStore.setUploadState(item.fileId, 'uploading');
    this.emit({ uploadedBytes: 0, totalBytes: meta.size });

    try {
      const response = await this.deps.api.uploadAttachment(
        session.token,
        {
          attemptId: item.attemptId,
          submissionUuid: item.submissionUuid,
          questionId: item.questionId,
          sha256: meta.sha256,
          fileName: meta.name,
          mimeType: meta.mimeType,
          blob,
        },
        (sent, total) => this.emit({ uploadedBytes: sent, totalBytes: total }),
      );
      await this.deps.fileStore.setUploadState(
        item.fileId,
        'uploaded',
        response.attachFileName ?? null,
      );
    } catch (error) {
      await this.deps.fileStore.setUploadState(item.fileId, 'failed');
      throw error;
    } finally {
      this.emit({ uploadedBytes: 0, totalBytes: 0 });
    }
  }

  private async sendFinalize(item: OutboxItem, session: SessionRecord): Promise<void> {
    const attempt = await this.deps.examStore.getAttempt(item.attemptKey);
    const payload = await payloadForSync(item.attemptKey, {
      examStore: this.deps.examStore,
      fileStore: this.deps.fileStore,
    });

    const response = await this.deps.api.finalize(session.token, {
      attemptId: item.attemptId,
      submissionUuid: item.submissionUuid,
      answerChecksum: attempt?.submissionChecksum ?? payload.answerChecksum,
      attachmentManifest: payload.attachmentManifest.map((m) => ({
        questionId: m.questionId,
        sha256: m.sha256,
      })),
    });

    this.deps.recordEvent?.(
      'sync_finalized',
      {
        attemptStatus: response.attemptStatus,
        autoScore: response.autoScore,
        pendingReview: response.pendingReview,
      },
      { attemptKey: item.attemptKey },
    );
  }

  /** Proctor action: give every flagged item its attempts back and drain again. */
  async retryAllFlagged(): Promise<SyncRunResult> {
    const requeued = await this.deps.outbox.requeueAllNeedingAttention();
    log.info('Sync: requeued flagged items', { requeued });
    for (const attempt of await this.deps.examStore.unsyncedAttempts()) {
      if (attempt.status === 'needs_attention') {
        await this.deps.examStore.setStatus(attempt.attemptKey, 'syncing', { lastSyncError: null });
      }
    }
    return this.run();
  }
}
