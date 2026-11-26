/**
 * Domain types shared by `core/` and `ui/`.
 *
 * These mirror the Laravel payloads documented in `docs/API_CONTRACT.md` one-to-one, with
 * `camelCase` on this side of the wire. The mapping lives in `core/api/laravel.ts` so that
 * nothing else in the app ever sees a snake_case key.
 */

// ── Identity / scoping ──────────────────────────────────────────────────────

/** `${schemaName}::${studentId}` — everything a student owns on this machine. */
export type ScopeKey = string;

/** `${schemaName}::${studentId}::${examId}` — one attempt at one exam. */
export type AttemptKey = string;

export interface StudentProfile {
  studentId: number;
  name: string;
  username: string;
  schemaName: string;
  schoolName: string;
  className: string | null;
  section: string | null;
  photoUrl: string | null;
}

export interface SessionRecord {
  scopeKey: ScopeKey;
  student: StudentProfile;
  /** Sanctum bearer token. Kept in IndexedDB so a refresh with the lab offline still works. */
  token: string;
  loggedInAt: number;
  lastSeenAt: number;
  /** Server clock minus device clock at login, in ms. Used to report skew, never to drive the timer. */
  clockSkewMs: number;
}

// ── Exams ───────────────────────────────────────────────────────────────────

/** What the server says about an exam. `ExamGrader::kind()` verbatim, plus `structured`. */
export type QuestionKind = 'choice' | 'written' | 'upload' | 'structured';

export interface QuestionOption {
  optionId: number;
  text: string;
}

export interface Question {
  questionId: number;
  /** Display number; may be `"4a"` for a part of a structured question. */
  number: string;
  kind: Exclude<QuestionKind, 'structured'>;
  text: string;
  weight: number;
  /** Absolute URL as the server gave it; rendered from the local media cache offline. */
  imageUrl: string | null;
  options: QuestionOption[];
  maxChars: number | null;
  /** Questions sharing a `groupRef` are rendered as one structured question. */
  groupRef: string | null;
  /** `(a)`, `(b)`, … within a structured group. */
  partLabel: string | null;
}

/** A structured question is a run of sibling questions grouped for display only. */
export interface QuestionGroup {
  groupRef: string;
  /** Stem shown above the parts (the first part's text when the server sends no stem). */
  stem: string | null;
  parts: Question[];
}

export interface AttachmentRules {
  enabled: boolean;
  maxFilesPerQuestion: number;
  maxFileBytes: number;
  allowedMime: string[];
}

export interface ExamMeta {
  examId: number;
  title: string;
  subject: string;
  subjectId: number;
  instructions: string;
  date: string | null;
  minutes: number;
  questionCount: number;
  totalWeight: number;
}

/** Server-side view of the student's single attempt. */
export interface ServerAttempt {
  attemptId: number;
  submissionUuid: string;
  mode: 'online' | 'offline';
  status: 'in_progress' | 'syncing' | 'submitted' | 'timed_out';
  startedAt: string;
  endsAt: string;
  durationSeconds: number;
  submittedAt: string | null;
  syncedAt: string | null;
}

export interface MediaRef {
  url: string;
  questionId: number;
  bytes: number | null;
}

/** Everything needed to sit one exam with the network physically off. */
export interface ExamBundle {
  attemptKey: AttemptKey;
  scopeKey: ScopeKey;
  schemaName: string;
  studentId: number;
  examId: number;
  attemptId: number;
  submissionUuid: string;
  exam: ExamMeta;
  questions: Question[];
  media: MediaRef[];
  attachmentRules: AttachmentRules;
  durationSeconds: number;
  bundleChecksum: string;
  issuedAt: string;
  downloadedAt: number;
  /** Set once the checksum recomputes and every media file is on disk. */
  verifiedAt: number | null;
  /** fileIds of downloaded question media, by questionId. */
  mediaFileIds: Record<number, string>;
}

/** What the exam list shows. Local state is merged over the server's. */
export type ExamListState =
  | 'available'
  | 'upcoming'
  | 'in_progress'
  | 'submitted_offline'
  | 'syncing'
  | 'synced'
  | 'completed_past'
  | 'needs_attention'
  | 'not_ready';

export interface ExamListItem {
  examId: number;
  title: string;
  subject: string;
  subjectId: number;
  date: string | null;
  minutes: number;
  questions: number;
  totalWeight: number;
  /** State as the server sees it. */
  serverState: 'available' | 'upcoming' | 'in_progress' | 'submitted' | 'not_ready';
  resultsReleased: boolean;
  score: number | null;
  total: number | null;
  attempt: ServerAttempt | null;
}

/** An exam row after local state has been merged in — what the UI renders. */
export interface MergedExamItem extends ExamListItem {
  state: ExamListState;
  /** Present when this machine holds a bundle/attempt for the exam. */
  local: AttemptRecord | null;
  hasBundle: boolean;
  secondsLeft: number | null;
  syncSummary: SyncSummary | null;
}

// ── Local attempt state ─────────────────────────────────────────────────────

export type AttemptStatus =
  | 'bundling'
  | 'ready'
  | 'in_progress'
  | 'submitted_offline'
  | 'syncing'
  | 'synced'
  | 'needs_attention';

export type AttemptLockReason = 'submitted' | 'time_expired' | null;

/** Serialisable timer state; see `core/timer/examTimer.ts` for the rules. */
export interface TimerState {
  /** Wall clock (ms) when the attempt was started on this machine. */
  startedAtWall: number;
  /** `performance.now()` when this page session took over, only valid within `monoSessionId`. */
  startedAtMono: number | null;
  /** Identifies the page session that produced `startedAtMono`. */
  monoSessionId: string | null;
  /** Elapsed seconds at the moment `startedAtMono` was recorded (0 on a fresh start). */
  monoAnchorElapsed: number;
  /** Non-decreasing seconds consumed. */
  elapsedSeconds: number;
  /** Wall clock of the last checkpoint, used to account for time while the page was dead. */
  lastCheckpointWall: number;
  durationSeconds: number;
}

export interface AttemptRecord {
  attemptKey: AttemptKey;
  scopeKey: ScopeKey;
  schemaName: string;
  studentId: number;
  examId: number;
  attemptId: number;
  submissionUuid: string;
  status: AttemptStatus;
  lockReason: AttemptLockReason;
  timer: TimerState;
  /** Set when the student (or the timer) submitted. */
  submittedAt: number | null;
  autoSubmitted: boolean;
  /** SHA-256 over the canonical answer payload, recorded at submission. */
  submissionChecksum: string | null;
  answeredCount: number;
  questionCount: number;
  deviceId: string;
  createdAt: number;
  updatedAt: number;
  /** Server acknowledgement of the whole attempt. */
  syncedAt: number | null;
  lastSyncError: string | null;
}

export interface AnswerRecord {
  /** `${attemptKey}::${questionId}` */
  id: string;
  attemptKey: AttemptKey;
  questionId: number;
  kind: Exclude<QuestionKind, 'structured'>;
  optionId: number | null;
  text: string | null;
  /** fileIds in the `files` store, in the order the student added them. */
  fileIds: string[];
  updatedAt: number;
  /** Bumped on every local write; lets the UI show "saved" without re-reading. */
  revision: number;
}

export type FileRole = 'answer' | 'media';
export type FileUploadState = 'local' | 'uploading' | 'uploaded' | 'failed';

export interface StoredFileMeta {
  fileId: string;
  attemptKey: AttemptKey;
  questionId: number;
  role: FileRole;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  storage: 'opfs' | 'idb';
  /** OPFS relative path when `storage === 'opfs'`. */
  path: string | null;
  createdAt: number;
  uploadState: FileUploadState;
  /** Server path once uploaded (`student_assessment.attach_file_name`). */
  serverPath: string | null;
}

// ── Sync ────────────────────────────────────────────────────────────────────

export type OutboxItemType = 'submission' | 'attachment' | 'finalize';
export type OutboxStatus = 'queued' | 'uploading' | 'synced' | 'needs_attention';

/** Stage ordering within one attempt: answers, then files, then finalize. */
export const OUTBOX_STAGE: Record<OutboxItemType, number> = {
  submission: 0,
  attachment: 1,
  finalize: 2,
};

export interface OutboxItem {
  id?: number;
  attemptKey: AttemptKey;
  scopeKey: ScopeKey;
  schemaName: string;
  studentId: number;
  examId: number;
  attemptId: number;
  submissionUuid: string;
  type: OutboxItemType;
  stage: number;
  /** Stable across restarts: derived from server ids and content digests. */
  idempotencyKey: string;
  status: OutboxStatus;
  attempts: number;
  /** Earliest time (ms) this item may be tried again. */
  nextAttemptAt: number;
  lastError: string | null;
  lastHttpStatus: number | null;
  createdAt: number;
  updatedAt: number;
  /** `attachment` items only. */
  fileId: string | null;
  questionId: number | null;
}

export interface SyncSummary {
  queued: number;
  uploading: number;
  synced: number;
  needsAttention: number;
  total: number;
  /** Overall state of the attempt's queue, for a single badge. */
  state: 'synced' | 'queued' | 'uploading' | 'needs_attention' | 'empty';
}

export interface AuditEvent {
  id?: number;
  attemptKey: AttemptKey | null;
  scopeKey: ScopeKey | null;
  at: number;
  type: string;
  detail: string | null;
}
