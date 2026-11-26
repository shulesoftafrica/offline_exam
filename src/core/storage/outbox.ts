import {
  OUTBOX_STAGE,
  type AttemptKey,
  type OutboxItem,
  type OutboxItemType,
  type ScopeKey,
  type SyncSummary,
} from '../../types';
import type { ExamDatabase } from './db';

/**
 * The durable sync queue.
 *
 * Items are created at submission time (with the internet off) and survive browser
 * restarts, lab power cuts and shift changes. An item is only ever `synced` after the
 * server returned 2xx; everything else leaves it queued or flags it for the proctor.
 */
export interface NewOutboxItem {
  attemptKey: AttemptKey;
  scopeKey: ScopeKey;
  schemaName: string;
  studentId: number;
  examId: number;
  attemptId: number;
  submissionUuid: string;
  type: OutboxItemType;
  idempotencyKey: string;
  fileId?: string | null;
  questionId?: number | null;
}

export class OutboxStore {
  /**
   * `now` is injected because every timestamp here is scheduling-relevant: the sync engine
   * compares `nextAttemptAt` against the same clock, so the two must never disagree.
   */
  constructor(
    private readonly db: ExamDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Enqueue, or return the existing item with the same idempotency key.
   *
   * Idempotency keys are derived from server ids and content digests, so "the same work"
   * is always recognised — pressing Submit twice, or re-running bundle verification, cannot
   * create a second queue entry.
   */
  async enqueue(input: NewOutboxItem): Promise<OutboxItem> {
    const existing = await this.db.outbox
      .where('idempotencyKey')
      .equals(input.idempotencyKey)
      .first();
    if (existing) return existing;

    const now = this.now();
    const item: OutboxItem = {
      attemptKey: input.attemptKey,
      scopeKey: input.scopeKey,
      schemaName: input.schemaName,
      studentId: input.studentId,
      examId: input.examId,
      attemptId: input.attemptId,
      submissionUuid: input.submissionUuid,
      type: input.type,
      stage: OUTBOX_STAGE[input.type],
      idempotencyKey: input.idempotencyKey,
      status: 'queued',
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      lastHttpStatus: null,
      createdAt: now,
      updatedAt: now,
      fileId: input.fileId ?? null,
      questionId: input.questionId ?? null,
    };
    const id = await this.db.outbox.add(item);
    return { ...item, id };
  }

  async get(id: number): Promise<OutboxItem | null> {
    return (await this.db.outbox.get(id)) ?? null;
  }

  /**
   * Work that could still move: what `drain()` uses to decide whether a run is worth
   * starting at all. Flagged items are excluded on purpose — they need a person.
   */
  async pending(): Promise<OutboxItem[]> {
    const rows = await this.db.outbox
      .where('status')
      .anyOf(['queued', 'uploading'])
      .toArray();
    return rows.sort(compareForProcessing);
  }

  /**
   * Everything not yet acknowledged by the server, **including flagged items**.
   *
   * This is what the scheduler must see: `selectDueItems` parks a whole attempt when one of
   * its items needs attention, and it can only do that if the flagged item is in the list.
   * Feeding it `pending()` instead would hide the flagged item and let a later stage (the
   * finalize) go out on top of an incomplete submission.
   */
  async outstanding(): Promise<OutboxItem[]> {
    const rows = await this.db.outbox
      .where('status')
      .anyOf(['queued', 'uploading', 'needs_attention'])
      .toArray();
    return rows.sort(compareForProcessing);
  }

  async all(): Promise<OutboxItem[]> {
    return (await this.db.outbox.toArray()).sort(compareForProcessing);
  }

  async forAttempt(key: AttemptKey): Promise<OutboxItem[]> {
    const rows = await this.db.outbox.where('attemptKey').equals(key).toArray();
    return rows.sort(compareForProcessing);
  }

  async forScope(scopeKey: ScopeKey): Promise<OutboxItem[]> {
    const rows = await this.db.outbox.where('scopeKey').equals(scopeKey).toArray();
    return rows.sort(compareForProcessing);
  }

  async patch(id: number, patch: Partial<OutboxItem>): Promise<void> {
    await this.db.outbox.update(id, { ...patch, updatedAt: this.now() });
  }

  async markUploading(id: number): Promise<void> {
    await this.patch(id, { status: 'uploading' });
  }

  async markSynced(id: number, httpStatus: number): Promise<void> {
    await this.patch(id, {
      status: 'synced',
      lastError: null,
      lastHttpStatus: httpStatus,
      nextAttemptAt: 0,
    });
  }

  async markRetry(
    id: number,
    attempts: number,
    nextAttemptAt: number,
    error: string,
    httpStatus: number | null,
  ): Promise<void> {
    await this.patch(id, {
      status: 'queued',
      attempts,
      nextAttemptAt,
      lastError: error,
      lastHttpStatus: httpStatus,
    });
  }

  async markNeedsAttention(
    id: number,
    attempts: number,
    error: string,
    httpStatus: number | null,
  ): Promise<void> {
    await this.patch(id, {
      status: 'needs_attention',
      attempts,
      lastError: error,
      lastHttpStatus: httpStatus,
    });
  }

  /**
   * Items whose last failure was a transport failure (`lastHttpStatus === 0`) were only ever
   * waiting for a network, not for a server to calm down. A sync run is started because we
   * believe the backend is reachable again, so their backoff is released first — otherwise a
   * queue that failed two seconds before the lab came back would sit idle until the next
   * connectivity poll. If we are wrong, the first item fails the same way and the run stops.
   *
   * @returns how many items were released
   */
  async releaseTransportWaits(): Promise<number> {
    const now = this.now();
    const rows = await this.db.outbox.where('status').equals('queued').toArray();
    const waiting = rows.filter((row) => row.lastHttpStatus === 0 && row.nextAttemptAt > now);
    for (const row of waiting) {
      if (row.id !== undefined) await this.patch(row.id, { nextAttemptAt: now });
    }
    return waiting.length;
  }

  /** The proctor's "Retry" button: give a flagged item its attempts back. */
  async requeue(id: number): Promise<void> {
    await this.patch(id, { status: 'queued', attempts: 0, nextAttemptAt: this.now() });
  }

  async requeueAllNeedingAttention(): Promise<number> {
    const rows = await this.db.outbox.where('status').equals('needs_attention').toArray();
    for (const row of rows) if (row.id !== undefined) await this.requeue(row.id);
    return rows.length;
  }

  async summaryFor(key: AttemptKey): Promise<SyncSummary> {
    return summarise(await this.forAttempt(key));
  }

  async summaryAll(): Promise<SyncSummary> {
    return summarise(await this.all());
  }
}

/** FIFO within a stage, stages in order; the engine filters by readiness separately. */
export function compareForProcessing(a: OutboxItem, b: OutboxItem): number {
  if (a.stage !== b.stage) return a.stage - b.stage;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return (a.id ?? 0) - (b.id ?? 0);
}

export function summarise(items: OutboxItem[]): SyncSummary {
  const summary: SyncSummary = {
    queued: 0,
    uploading: 0,
    synced: 0,
    needsAttention: 0,
    total: items.length,
    state: 'empty',
  };
  for (const item of items) {
    if (item.status === 'queued') summary.queued += 1;
    else if (item.status === 'uploading') summary.uploading += 1;
    else if (item.status === 'synced') summary.synced += 1;
    else summary.needsAttention += 1;
  }
  if (summary.total === 0) summary.state = 'empty';
  else if (summary.needsAttention > 0) summary.state = 'needs_attention';
  else if (summary.uploading > 0) summary.state = 'uploading';
  else if (summary.queued > 0) summary.state = 'queued';
  else summary.state = 'synced';
  return summary;
}

/**
 * Which items may be sent right now — the whole scheduling policy, as a pure function so
 * the ordering guarantees are asserted by tests rather than hoped for.
 *
 * Rules:
 *  1. Only `queued` items whose backoff has elapsed.
 *  2. Per attempt, only the **lowest incomplete stage**: answers land before files, and an
 *     attempt is finalised only once every file it declared has been acknowledged.
 *  3. An attempt with a `needs_attention` item at or below the stage in question is parked
 *     entirely — pushing later stages would finalise an incomplete submission.
 *  4. FIFO within a stage, so a long queue drains predictably.
 */
export function selectDueItems(items: OutboxItem[], now: number, limit = 4): OutboxItem[] {
  const byAttempt = new Map<AttemptKey, OutboxItem[]>();
  for (const item of items) {
    const list = byAttempt.get(item.attemptKey);
    if (list) list.push(item);
    else byAttempt.set(item.attemptKey, [item]);
  }

  const due: OutboxItem[] = [];
  for (const group of byAttempt.values()) {
    const sorted = [...group].sort(compareForProcessing);
    const stages = [...new Set(sorted.map((i) => i.stage))].sort((a, b) => a - b);

    for (const stage of stages) {
      const atStage = sorted.filter((i) => i.stage === stage);
      const unfinished = atStage.filter((i) => i.status !== 'synced');
      if (unfinished.length === 0) continue; // whole stage done, look at the next one

      // Rule 3: never step over a flagged item in the current stage.
      if (unfinished.some((i) => i.status === 'needs_attention')) break;

      const ready = unfinished.filter((i) => i.status === 'queued' && i.nextAttemptAt <= now);
      due.push(...ready);
      break; // Rule 2: this attempt contributes only its lowest incomplete stage
    }
  }

  return due.sort(compareForProcessing).slice(0, limit);
}
