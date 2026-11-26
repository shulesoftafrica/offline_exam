import type {
  AttemptRecord,
  ExamBundle,
  MediaRef,
  Question,
  QuestionGroup,
  StudentProfile,
} from '../../types';
import type { BundleResponse, ExamApi } from '../api/types';
import type { ExamStore } from '../storage/examStore';
import type { FileStore } from '../storage/files';
import { canonicalJson, sha256OfString } from '../util/checksum';
import { attemptKey as makeAttemptKey, scopeKey as makeScopeKey } from '../util/ids';
import { describeError, log } from '../util/logger';
import { startTimer, type ClockReading } from '../timer/examTimer';

/**
 * Downloading and verifying an exam bundle — the last thing that needs the network before
 * the lab switch goes off.
 *
 * "Verified" means three separate things, all of which must hold before a student is let
 * into the runner:
 *  1. every question the server said the exam has is present locally;
 *  2. the recomputed checksum over the canonical exam payload matches the server's;
 *  3. every piece of question media has been fetched and written to the local file store.
 *
 * A bundle that fails any of them is kept (so the proctor can see what happened) but the
 * attempt stays `bundling` and the UI refuses to start.
 */

export interface BundleProgress {
  phase: 'requesting' | 'verifying' | 'media' | 'done';
  /** 0..1 */
  ratio: number;
  message: string;
}

export type BundleProgressFn = (progress: BundleProgress) => void;

export interface BundleResult {
  bundle: ExamBundle;
  attempt: AttemptRecord;
}

/** Checksum over exactly what both sides can agree on: exam metadata + questions. */
export async function computeBundleChecksum(
  exam: BundleResponse['exam'],
  questions: Question[],
): Promise<string> {
  return `sha256:${await sha256OfString(canonicalJson({ exam, questions }))}`;
}

export interface BundleVerification {
  ok: boolean
  problems: string[];
  checksumMatches: boolean;
  questionCountMatches: boolean;
}

export async function verifyBundlePayload(response: BundleResponse): Promise<BundleVerification> {
  const problems: string[] = [];

  const expected = response.exam.questionCount;
  const questionCountMatches = expected <= 0 || expected === response.questions.length;
  if (!questionCountMatches) {
    problems.push(
      `The exam says it has ${expected} questions but ${response.questions.length} arrived.`,
    );
  }
  if (response.questions.length === 0) {
    problems.push('The exam has no questions.');
  }

  const recomputed = await computeBundleChecksum(response.exam, response.questions);
  const checksumMatches =
    response.bundleChecksum === '' || recomputed === response.bundleChecksum;
  if (!checksumMatches) {
    problems.push('The exam download is incomplete or was altered in transit.');
  }

  for (const q of response.questions) {
    if (q.kind === 'choice' && q.options.length < 2) {
      problems.push(`Question ${q.number} has no options to choose from.`);
    }
  }

  return { ok: problems.length === 0, problems, checksumMatches, questionCountMatches };
}

export interface DownloadBundleDeps {
  api: ExamApi;
  examStore: ExamStore;
  fileStore: FileStore;
  reading: ClockReading;
  onProgress?: BundleProgressFn;
  recordEvent?: (type: string, detail?: unknown) => void;
}

/**
 * Fetch, verify and persist everything for one exam, then create the local attempt in
 * `ready` state. Safe to call again: the server returns the same attempt (its unique key is
 * `schema + exam + student`), and local rows are replaced rather than duplicated.
 */
export async function downloadBundle(
  token: string,
  student: StudentProfile,
  examId: number,
  deviceId: string,
  deps: DownloadBundleDeps,
): Promise<BundleResult> {
  const { api, examStore, fileStore, reading, onProgress, recordEvent } = deps;
  const scopeKey = makeScopeKey(student.schemaName, student.studentId);
  const attemptKey = makeAttemptKey(student.schemaName, student.studentId, examId);

  onProgress?.({ phase: 'requesting', ratio: 0.05, message: 'Asking the server for the exam…' });

  const response = await api.downloadBundle(token, {
    examId,
    studentId: student.studentId,
    deviceId,
    mode: 'offline',
  });

  onProgress?.({ phase: 'verifying', ratio: 0.35, message: 'Checking the download is complete…' });

  const verification = await verifyBundlePayload(response);

  const durationSeconds =
    response.attempt.durationSeconds > 0
      ? response.attempt.durationSeconds
      : Math.max(60, response.exam.minutes * 60);

  const bundle: ExamBundle = {
    attemptKey,
    scopeKey,
    schemaName: student.schemaName,
    studentId: student.studentId,
    examId,
    attemptId: response.attempt.attemptId,
    submissionUuid: response.attempt.submissionUuid,
    exam: response.exam,
    questions: response.questions,
    media: response.media,
    attachmentRules: response.attachmentRules,
    durationSeconds,
    bundleChecksum: response.bundleChecksum,
    issuedAt: response.issuedAt,
    downloadedAt: Date.now(),
    verifiedAt: null,
    mediaFileIds: {},
  };

  await examStore.putBundle(bundle);

  // An existing attempt is never clobbered: a student who refreshed the intro screen keeps
  // whatever they had already answered.
  const existing = await examStore.getAttempt(attemptKey);
  const attempt: AttemptRecord = existing ?? {
    attemptKey,
    scopeKey,
    schemaName: student.schemaName,
    studentId: student.studentId,
    examId,
    attemptId: response.attempt.attemptId,
    submissionUuid: response.attempt.submissionUuid,
    status: 'bundling',
    lockReason: null,
    timer: startTimer(durationSeconds, reading),
    submittedAt: null,
    autoSubmitted: false,
    submissionChecksum: null,
    answeredCount: 0,
    questionCount: response.questions.length,
    deviceId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncedAt: null,
    lastSyncError: null,
  };
  if (!existing) await examStore.putAttempt(attempt);

  // ── Media ───────────────────────────────────────────────────────────────
  const mediaFileIds: Record<number, string> = { ...bundle.mediaFileIds };
  const mediaToFetch = dedupeMedia(response.media, response.questions);
  let fetched = 0;
  const mediaProblems: string[] = [];

  for (const item of mediaToFetch) {
    onProgress?.({
      phase: 'media',
      ratio: 0.4 + (0.55 * fetched) / Math.max(1, mediaToFetch.length),
      message: `Downloading pictures (${fetched + 1} of ${mediaToFetch.length})…`,
    });
    try {
      const blob = await api.fetchMedia(token, item.url);
      const saved = await fileStore.save({
        attemptKey,
        questionId: item.questionId,
        role: 'media',
        name: item.url.split('/').pop() ?? `media-${item.questionId}`,
        blob,
      });
      mediaFileIds[item.questionId] = saved.fileId;
    } catch (error) {
      const message = `Picture for question ${item.questionId} could not be downloaded: ${describeError(error)}`;
      mediaProblems.push(message);
      log.warn('Bundle media download failed', { url: item.url, error });
    }
    fetched += 1;
  }

  const problems = [...verification.problems, ...mediaProblems];
  const ok = problems.length === 0;

  if (ok) {
    await examStore.markBundleVerified(attemptKey, mediaFileIds);
    if (attempt.status === 'bundling') {
      await examStore.setStatus(attemptKey, 'ready');
      attempt.status = 'ready';
    }
    recordEvent?.('bundle_verified', {
      examId,
      attemptId: response.attempt.attemptId,
      questions: response.questions.length,
      media: mediaToFetch.length,
    });
  } else {
    await examStore.putBundle({ ...bundle, mediaFileIds });
    recordEvent?.('bundle_incomplete', { examId, problems });
  }

  onProgress?.({ phase: 'done', ratio: 1, message: ok ? 'Exam ready.' : problems.join(' ') });

  if (!ok) {
    throw new BundleIncompleteError(problems);
  }

  const stored = await examStore.getBundle(attemptKey);
  const storedAttempt = await examStore.getAttempt(attemptKey);
  return {
    bundle: stored ?? { ...bundle, mediaFileIds, verifiedAt: Date.now() },
    attempt: storedAttempt ?? attempt,
  };
}

export class BundleIncompleteError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems[0] ?? 'The exam download is incomplete.');
    this.name = 'BundleIncompleteError';
    this.problems = problems;
  }
}

/** One fetch per URL; questions can share an image. */
function dedupeMedia(media: MediaRef[], questions: Question[]): MediaRef[] {
  const all: MediaRef[] = [...media];
  for (const q of questions) {
    if (q.imageUrl && !all.some((m) => m.url === q.imageUrl)) {
      all.push({ url: q.imageUrl, questionId: q.questionId, bytes: null });
    }
  }
  const seen = new Set<string>();
  return all.filter((m) => {
    if (!m.url || seen.has(m.url)) return false;
    seen.add(m.url);
    return true;
  });
}

/**
 * Group a flat question list for display: consecutive questions sharing a `groupRef` become
 * one structured question with lettered parts. Pure, so the runner's layout is testable.
 */
export function groupQuestions(questions: Question[]): (Question | QuestionGroup)[] {
  const out: (Question | QuestionGroup)[] = [];
  let current: QuestionGroup | null = null;

  for (const q of questions) {
    if (!q.groupRef) {
      current = null;
      out.push(q);
      continue;
    }
    if (current && current.groupRef === q.groupRef) {
      current.parts.push(q);
      continue;
    }
    current = { groupRef: q.groupRef, stem: null, parts: [q] };
    out.push(current);
  }
  return out;
}

export function isQuestionGroup(item: Question | QuestionGroup): item is QuestionGroup {
  return (item as QuestionGroup).parts !== undefined;
}

/** Flattened, ordered question list — what the navigator and the progress count use. */
export function flattenQuestions(items: (Question | QuestionGroup)[]): Question[] {
  return items.flatMap((item) => (isQuestionGroup(item) ? item.parts : [item]));
}
