import type {
  AnswerRecord,
  AttemptKey,
  AttemptRecord,
  AttemptStatus,
  ExamBundle,
  ScopeKey,
  TimerState,
} from '../../types';
import { answerId } from '../util/ids';
import type { ExamDatabase } from './db';

/**
 * Bundles, attempts and answers — the three stores that move together.
 *
 * Every public method is scoped: callers pass an `attemptKey`, which encodes
 * `schema + student + exam`, so one lab machine holding three shifts of students cannot
 * leak or overwrite across them. Nothing here does any network I/O.
 */
export class ExamStore {
  constructor(private readonly db: ExamDatabase) {}

  // ── Bundles ───────────────────────────────────────────────────────────────

  async putBundle(bundle: ExamBundle): Promise<void> {
    await this.db.bundles.put(bundle);
  }

  async getBundle(key: AttemptKey): Promise<ExamBundle | null> {
    return (await this.db.bundles.get(key)) ?? null;
  }

  async markBundleVerified(key: AttemptKey, mediaFileIds: Record<number, string>): Promise<void> {
    await this.db.bundles.update(key, { verifiedAt: Date.now(), mediaFileIds });
  }

  async bundlesForScope(scopeKey: ScopeKey): Promise<ExamBundle[]> {
    return this.db.bundles.where('scopeKey').equals(scopeKey).toArray();
  }

  // ── Attempts ──────────────────────────────────────────────────────────────

  async getAttempt(key: AttemptKey): Promise<AttemptRecord | null> {
    return (await this.db.attempts.get(key)) ?? null;
  }

  async putAttempt(attempt: AttemptRecord): Promise<void> {
    await this.db.attempts.put(attempt);
  }

  async attemptsForScope(scopeKey: ScopeKey): Promise<AttemptRecord[]> {
    return this.db.attempts.where('scopeKey').equals(scopeKey).toArray();
  }

  async allAttempts(): Promise<AttemptRecord[]> {
    return this.db.attempts.orderBy('updatedAt').reverse().toArray();
  }

  /** Attempts on this machine that are not yet confirmed by the server, across all students. */
  async unsyncedAttempts(): Promise<AttemptRecord[]> {
    const pending: AttemptStatus[] = ['submitted_offline', 'syncing', 'needs_attention'];
    return this.db.attempts.where('status').anyOf(pending).toArray();
  }

  async patchAttempt(key: AttemptKey, patch: Partial<AttemptRecord>): Promise<void> {
    await this.db.attempts.update(key, { ...patch, updatedAt: Date.now() });
  }

  async setStatus(
    key: AttemptKey,
    status: AttemptStatus,
    extra: Partial<AttemptRecord> = {},
  ): Promise<void> {
    await this.patchAttempt(key, { status, ...extra });
  }

  async checkpointTimer(key: AttemptKey, timer: TimerState): Promise<void> {
    // A checkpoint must never resurrect a submitted attempt's clock.
    await this.db.transaction('rw', this.db.attempts, async () => {
      const current = await this.db.attempts.get(key);
      if (!current || current.status !== 'in_progress') return;
      await this.db.attempts.update(key, { timer, updatedAt: Date.now() });
    });
  }

  // ── Answers ───────────────────────────────────────────────────────────────

  async getAnswer(key: AttemptKey, questionId: number): Promise<AnswerRecord | null> {
    return (await this.db.answers.get(answerId(key, questionId))) ?? null;
  }

  async answersForAttempt(key: AttemptKey): Promise<AnswerRecord[]> {
    const rows = await this.db.answers.where('attemptKey').equals(key).toArray();
    return rows.sort((a, b) => a.questionId - b.questionId);
  }

  /**
   * Upsert one answer and refresh the attempt's answered count in the same transaction, so
   * the progress the student sees can never disagree with what is stored.
   *
   * Refuses to write once the attempt is locked (submitted or expired) — the guard lives
   * here rather than in the UI so a stray autosave timer firing after submission is inert.
   */
  async saveAnswer(
    key: AttemptKey,
    questionId: number,
    kind: AnswerRecord['kind'],
    value: { optionId?: number | null; text?: string | null; fileIds?: string[] },
  ): Promise<{ saved: boolean; record: AnswerRecord | null }> {
    // Mutated inside the transaction callback; an object keeps TypeScript's narrowing honest.
    const out: { saved: boolean; record: AnswerRecord | null } = { saved: false, record: null };

    await this.db.transaction('rw', this.db.attempts, this.db.answers, async () => {
      const attempt = await this.db.attempts.get(key);
      if (!attempt) return;
      if (attempt.status !== 'in_progress') return;

      const id = answerId(key, questionId);
      const existing = await this.db.answers.get(id);
      const next: AnswerRecord = {
        id,
        attemptKey: key,
        questionId,
        kind,
        optionId: value.optionId !== undefined ? value.optionId : (existing?.optionId ?? null),
        text: value.text !== undefined ? value.text : (existing?.text ?? null),
        fileIds: value.fileIds !== undefined ? value.fileIds : (existing?.fileIds ?? []),
        updatedAt: Date.now(),
        revision: (existing?.revision ?? 0) + 1,
      };

      if (isEmptyAnswer(next)) {
        if (existing) await this.db.answers.delete(id);
        out.record = null;
      } else {
        await this.db.answers.put(next);
        out.record = next;
      }

      const answeredCount = await this.db.answers.where('attemptKey').equals(key).count();
      await this.db.attempts.update(key, { answeredCount, updatedAt: Date.now() });
      out.saved = true;
    });

    return out;
  }

  /** Adds a file to an upload answer. Returns false when the attempt is locked. */
  async attachFile(key: AttemptKey, questionId: number, fileId: string): Promise<boolean> {
    const existing = await this.getAnswer(key, questionId);
    const fileIds = [...(existing?.fileIds ?? [])];
    if (!fileIds.includes(fileId)) fileIds.push(fileId);
    const { saved } = await this.saveAnswer(key, questionId, 'upload', { fileIds });
    return saved;
  }

  async detachFile(key: AttemptKey, questionId: number, fileId: string): Promise<boolean> {
    const existing = await this.getAnswer(key, questionId);
    if (!existing) return false;
    const fileIds = existing.fileIds.filter((id) => id !== fileId);
    const { saved } = await this.saveAnswer(key, questionId, 'upload', { fileIds });
    return saved;
  }

  // ── Teardown (proctor only) ───────────────────────────────────────────────

  /**
   * Removes everything about one attempt. The caller must have checked that the attempt is
   * `synced` and its outbox is empty; this method does not second-guess that, but it is the
   * only path that deletes exam work, and it is never called automatically.
   */
  async purgeAttempt(key: AttemptKey): Promise<void> {
    await this.db.transaction(
      'rw',
      this.db.attempts,
      this.db.answers,
      this.db.bundles,
      this.db.outbox,
      async () => {
        await this.db.answers.where('attemptKey').equals(key).delete();
        await this.db.outbox.where('attemptKey').equals(key).delete();
        await this.db.bundles.delete(key);
        await this.db.attempts.delete(key);
      },
    );
  }
}

export function isEmptyAnswer(answer: AnswerRecord): boolean {
  const hasText = typeof answer.text === 'string' && answer.text.trim() !== '';
  const hasOption = typeof answer.optionId === 'number' && answer.optionId > 0;
  const hasFiles = answer.fileIds.length > 0;
  return !hasText && !hasOption && !hasFiles;
}
