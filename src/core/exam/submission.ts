import type {
  AnswerRecord,
  AttemptRecord,
  ExamBundle,
  StoredFileMeta,
} from '../../types';
import type { AttachmentManifestEntry, SubmissionAnswerPayload } from '../api/types';
import { checksumOf } from '../util/checksum';
import {
  attachmentIdempotencyKey,
  finalizeIdempotencyKey,
  submissionIdempotencyKey,
} from '../util/ids';
import type { ExamStore } from '../storage/examStore';
import type { FileStore } from '../storage/files';
import type { OutboxStore } from '../storage/outbox';
import { integrityOf, type ClockReading } from '../timer/examTimer';

/**
 * Submitting an exam with the internet off.
 *
 * The student presses Submit, and before the confirmation screen appears, all of this has
 * happened **locally and transactionally**:
 *
 *  1. the canonical answer payload is built and checksummed;
 *  2. the attempt is locked (`submitted_offline`) with its submission timestamp;
 *  3. one `submission` item, one `attachment` item per answer file and one `finalize` item
 *     are written to the durable outbox.
 *
 * Nothing in this flow touches the network, so it works identically with the lab switch off.
 */

export interface SubmissionPayload {
  answers: SubmissionAnswerPayload[];
  attachmentManifest: AttachmentManifestEntry[];
  /** `fileId` per manifest entry, so the sync engine can find the bytes again. */
  fileIdsByDigest: Record<string, string>;
  answerChecksum: string;
  answeredCount: number;
}

/**
 * Build the exact payload the server will receive. Deterministic: answers sorted by
 * question id, attachments by digest, so the checksum is stable across retries and
 * reproducible on the server.
 */
export async function buildSubmissionPayload(
  answers: AnswerRecord[],
  filesByQuestion: Map<number, StoredFileMeta[]>,
): Promise<SubmissionPayload> {
  const sorted = [...answers].sort((a, b) => a.questionId - b.questionId);
  const payloadAnswers: SubmissionAnswerPayload[] = [];
  const manifest: AttachmentManifestEntry[] = [];
  const fileIdsByDigest: Record<string, string> = {};

  for (const answer of sorted) {
    const files = (filesByQuestion.get(answer.questionId) ?? [])
      .filter((f) => f.role === 'answer' && answer.fileIds.includes(f.fileId))
      .sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));

    const entry: SubmissionAnswerPayload = { questionId: answer.questionId };
    if (answer.optionId != null) entry.optionId = answer.optionId;
    if (answer.text != null && answer.text.trim() !== '') entry.text = answer.text;
    if (files.length > 0) {
      entry.attachments = files.map((f) => ({
        sha256: f.sha256,
        name: f.name,
        mime: f.mimeType,
        bytes: f.size,
      }));
      for (const f of files) {
        manifest.push({ questionId: answer.questionId, sha256: f.sha256, bytes: f.size });
        fileIdsByDigest[f.sha256] = f.fileId;
      }
    }
    payloadAnswers.push(entry);
  }

  manifest.sort((a, b) =>
    a.questionId - b.questionId || (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0),
  );

  const answerChecksum = await checksumOf({
    answers: payloadAnswers,
    attachments: manifest.map((m) => ({ questionId: m.questionId, sha256: m.sha256 })),
  });

  return {
    answers: payloadAnswers,
    attachmentManifest: manifest,
    fileIdsByDigest,
    answerChecksum,
    answeredCount: payloadAnswers.length,
  };
}

export interface SubmitDeps {
  examStore: ExamStore;
  fileStore: FileStore;
  outbox: OutboxStore;
  reading: ClockReading;
  recordEvent?: (type: string, detail?: unknown) => void;
}

export interface SubmitResult {
  attempt: AttemptRecord;
  payload: SubmissionPayload;
  queuedItems: number;
  /** What the confirmation screen shows the student. */
  receipt: {
    submittedAt: number;
    checksum: string;
    answered: number;
    questions: number;
    attachments: number;
    elapsedSeconds: number;
    autoSubmitted: boolean;
  };
}

export class AlreadySubmittedError extends Error {
  constructor() {
    super('This exam has already been submitted on this machine.');
    this.name = 'AlreadySubmittedError';
  }
}

/**
 * Lock the attempt and queue it for sync. Idempotent: calling it twice (double-tap, or a
 * timer expiry racing the student's own click) returns the existing receipt rather than
 * queueing a second submission.
 */
export async function submitOffline(
  bundle: ExamBundle,
  options: { auto: boolean },
  deps: SubmitDeps,
): Promise<SubmitResult> {
  const { examStore, fileStore, outbox, reading, recordEvent } = deps;
  const key = bundle.attemptKey;

  const current = await examStore.getAttempt(key);
  if (!current) throw new Error('There is no attempt to submit on this machine.');

  const answers = await examStore.answersForAttempt(key);
  const files = await fileStore.listForAttempt(key, 'answer');
  const filesByQuestion = new Map<number, StoredFileMeta[]>();
  for (const file of files) {
    const list = filesByQuestion.get(file.questionId);
    if (list) list.push(file);
    else filesByQuestion.set(file.questionId, [file]);
  }

  const payload = await buildSubmissionPayload(answers, filesByQuestion);

  // Already submitted: rebuild the receipt from what is stored and leave the queue alone.
  if (current.status !== 'in_progress' && current.submittedAt !== null) {
    return {
      attempt: current,
      payload,
      queuedItems: (await outbox.forAttempt(key)).length,
      receipt: {
        submittedAt: current.submittedAt,
        checksum: current.submissionChecksum ?? payload.answerChecksum,
        answered: current.answeredCount,
        questions: current.questionCount,
        attachments: payload.attachmentManifest.length,
        elapsedSeconds: Math.round(current.timer.elapsedSeconds),
        autoSubmitted: current.autoSubmitted,
      },
    };
  }

  const submittedAt = reading.wallNow;
  await examStore.patchAttempt(key, {
    status: 'submitted_offline',
    lockReason: options.auto ? 'time_expired' : 'submitted',
    submittedAt,
    autoSubmitted: options.auto,
    submissionChecksum: payload.answerChecksum,
    answeredCount: payload.answeredCount,
    questionCount: bundle.questions.length,
  });

  // ── Queue: submission → attachments → finalize ──────────────────────────
  const base = {
    attemptKey: key,
    scopeKey: bundle.scopeKey,
    schemaName: bundle.schemaName,
    studentId: bundle.studentId,
    examId: bundle.examId,
    attemptId: bundle.attemptId,
    submissionUuid: bundle.submissionUuid,
  };

  let queuedItems = 0;
  await outbox.enqueue({
    ...base,
    type: 'submission',
    idempotencyKey: submissionIdempotencyKey(bundle.attemptId, bundle.submissionUuid),
  });
  queuedItems += 1;

  for (const entry of payload.attachmentManifest) {
    const fileId = payload.fileIdsByDigest[entry.sha256];
    if (!fileId) continue;
    await outbox.enqueue({
      ...base,
      type: 'attachment',
      idempotencyKey: attachmentIdempotencyKey(bundle.attemptId, entry.questionId, entry.sha256),
      fileId,
      questionId: entry.questionId,
    });
    queuedItems += 1;
  }

  await outbox.enqueue({
    ...base,
    type: 'finalize',
    idempotencyKey: finalizeIdempotencyKey(bundle.attemptId, bundle.submissionUuid),
  });
  queuedItems += 1;

  const integrity = integrityOf(current.timer, reading);
  recordEvent?.('submitted_offline', {
    examId: bundle.examId,
    attemptId: bundle.attemptId,
    auto: options.auto,
    answered: payload.answeredCount,
    questions: bundle.questions.length,
    attachments: payload.attachmentManifest.length,
    checksum: payload.answerChecksum,
    elapsedSeconds: Math.round(current.timer.elapsedSeconds),
    integrity,
  });

  const attempt = (await examStore.getAttempt(key)) as AttemptRecord;
  return {
    attempt,
    payload,
    queuedItems,
    receipt: {
      submittedAt,
      checksum: payload.answerChecksum,
      answered: payload.answeredCount,
      questions: bundle.questions.length,
      attachments: payload.attachmentManifest.length,
      elapsedSeconds: Math.round(current.timer.elapsedSeconds),
      autoSubmitted: options.auto,
    },
  };
}

/** Rebuilds the payload for a queued attempt at sync time (bytes are read lazily). */
export async function payloadForSync(
  attemptKey: string,
  deps: { examStore: ExamStore; fileStore: FileStore },
): Promise<SubmissionPayload> {
  const answers = await deps.examStore.answersForAttempt(attemptKey);
  const files = await deps.fileStore.listForAttempt(attemptKey, 'answer');
  const filesByQuestion = new Map<number, StoredFileMeta[]>();
  for (const file of files) {
    const list = filesByQuestion.get(file.questionId);
    if (list) list.push(file);
    else filesByQuestion.set(file.questionId, [file]);
  }
  return buildSubmissionPayload(answers, filesByQuestion);
}
