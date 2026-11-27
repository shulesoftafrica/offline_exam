import type {
  AttachmentRules,
  ExamListItem,
  ExamMeta,
  MediaRef,
  Question,
  ServerAttempt,
  StudentProfile,
} from '../../types';

/**
 * The transport contract. Two implementations: `laravel.ts` (the real backend, documented in
 * `docs/API_CONTRACT.md`) and `mock.ts` (an in-memory stand-in with the same idempotency
 * rules, so the lab flow and the tests run without a server).
 *
 * Every method either resolves with data or throws `ApiError`. Nothing here knows about
 * IndexedDB, React or the outbox.
 */

export class ApiError extends Error {
  /** `0` means no response at all: the lab switch is off, DNS failed, or we timed out. */
  readonly status: number;
  /** Laravel's `message[]`, joined — shown verbatim to the proctor. */
  readonly serverMessage: string | null;
  /** Machine-readable `data.code` where the backend sends one (e.g. `already_synced`). */
  readonly code: string | null;
  readonly body: unknown;

  constructor(
    message: string,
    options: { status: number; serverMessage?: string | null; code?: string | null; body?: unknown },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.serverMessage = options.serverMessage ?? null;
    this.code = options.code ?? null;
    this.body = options.body ?? null;
  }

  /** True when there was no usable response — the common case in an offline lab. */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

export interface LoginRequest {
  username: string;
  password: string;
  /** Postgres schema name, i.e. the school. Omitted on single-tenant deployments. */
  school?: string | null;
}

export interface LoginResponse {
  token: string;
  student: StudentProfile;
  /** ISO-8601; used to report the machine's clock skew, never to drive the exam timer. */
  serverTime: string;
}

export interface BundleRequest {
  examId: number;
  /** Only used to build the idempotency key; the server trusts the token, not this. */
  studentId: number;
  deviceId: string;
  mode: 'offline' | 'online';
}

export interface BundleResponse {
  attempt: ServerAttempt;
  exam: ExamMeta;
  questions: Question[];
  media: MediaRef[];
  attachmentRules: AttachmentRules;
  bundleChecksum: string;
  issuedAt: string;
  /**
   * The exact `{ exam, questions }` the server sent, before any mapping into the types
   * above. `bundleChecksum` is a digest of *that*, in the server's own key names, so
   * verification has to canonicalise what came off the wire rather than our camel-cased
   * view of it. A driver with no wire format of its own (the mock) leaves this undefined
   * and the checksum is recomputed over the mapped payload instead.
   */
  checksumSource?: unknown;
}

export interface SubmissionAnswerPayload {
  questionId: number;
  optionId?: number | null;
  text?: string | null;
  attachments?: { sha256: string; name: string; mime: string; bytes: number }[];
}

export interface AttachmentManifestEntry {
  questionId: number;
  sha256: string;
  bytes: number;
}

export interface SubmissionRequest {
  attemptId: number;
  submissionUuid: string;
  deviceId: string;
  clientStartedAt: string;
  clientSubmittedAt: string;
  clientElapsedSeconds: number;
  answerChecksum: string;
  answers: SubmissionAnswerPayload[];
  attachmentManifest: AttachmentManifestEntry[];
}

export interface SubmissionResponse {
  accepted: number;
  attemptStatus: ServerAttempt['status'];
  missingAttachments: { questionId: number; sha256: string }[];
  alreadySynced: boolean;
}

export interface AttachmentUploadRequest {
  attemptId: number;
  submissionUuid: string;
  questionId: number;
  sha256: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
}

export interface AttachmentUploadResponse {
  stored: boolean;
  duplicate: boolean;
  questionId: number;
  attach: string;
  attachFileName: string | null;
}

export interface FinalizeRequest {
  attemptId: number;
  submissionUuid: string;
  answerChecksum: string;
  attachmentManifest: { questionId: number; sha256: string }[];
}

export interface FinalizeResponse {
  attemptStatus: ServerAttempt['status'];
  syncedAt: string;
  autoScore: number | null;
  totalWeight: number | null;
  pendingReview: number;
  resultsReleased: boolean;
}

export interface AttemptStatusItem {
  attemptId: number;
  status: ServerAttempt['status'];
  syncedAt: string | null;
  attachmentsStored: number;
  pendingReview: number;
}

/** Progress callback for chunked uploads, so the UI can show a real bar. */
export type UploadProgress = (sentBytes: number, totalBytes: number) => void;

export interface ExamApi {
  /** Unauthenticated reachability probe. Resolves `true` only on a 2xx. */
  health(): Promise<boolean>;
  login(request: LoginRequest): Promise<LoginResponse>;
  me(token: string): Promise<{ student: StudentProfile; serverTime: string }>;
  logout(token: string): Promise<void>;
  listExams(token: string): Promise<ExamListItem[]>;
  downloadBundle(token: string, request: BundleRequest): Promise<BundleResponse>;
  /** Fetches question media as bytes so it can be cached for the offline window. */
  fetchMedia(token: string, url: string): Promise<Blob>;
  postSubmission(token: string, request: SubmissionRequest): Promise<SubmissionResponse>;
  uploadAttachment(
    token: string,
    request: AttachmentUploadRequest,
    onProgress?: UploadProgress,
  ): Promise<AttachmentUploadResponse>;
  finalize(token: string, request: FinalizeRequest): Promise<FinalizeResponse>;
  attemptStatus(token: string, attemptIds: number[]): Promise<AttemptStatusItem[]>;
}
