import type {
  AttachmentRules,
  ExamListItem,
  ExamMeta,
  MediaRef,
  Question,
  ServerAttempt,
  StudentProfile,
} from '../../types';
import { config } from '../config';
import {
  bundleIdempotencyKey,
  attachmentIdempotencyKey,
  finalizeIdempotencyKey,
  submissionIdempotencyKey,
} from '../util/ids';
import { log } from '../util/logger';
import {
  ApiError,
  type AttachmentUploadRequest,
  type AttachmentUploadResponse,
  type AttemptStatusItem,
  type BundleRequest,
  type BundleResponse,
  type ExamApi,
  type FinalizeRequest,
  type FinalizeResponse,
  type LoginRequest,
  type LoginResponse,
  type SubmissionRequest,
  type SubmissionResponse,
  type UploadProgress,
} from './types';

/**
 * The real backend driver: ShuleSoft's Laravel API, speaking the envelope the rest of the
 * house already uses (`{ success, data, message[] }`) and the additive `/student/*` routes
 * documented in `docs/API_CONTRACT.md`.
 *
 * Everything snake_case stops here. The rest of the app only ever sees the camelCase domain
 * types from `src/types`.
 */

interface Envelope<T> {
  success?: number | boolean;
  data?: T;
  message?: string[] | string;
}

type Json = Record<string, unknown>;

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function nullableStr(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function messageOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const message = (body as Envelope<unknown>).message;
  if (Array.isArray(message)) return message.filter(Boolean).join(' ') || null;
  return typeof message === 'string' && message !== '' ? message : null;
}

function codeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as Envelope<Json>).data;
  const direct = (body as Json)['code'];
  if (typeof direct === 'string') return direct;
  if (data && typeof data === 'object' && typeof data['code'] === 'string') {
    return data['code'] as string;
  }
  return null;
}

export class LaravelExamApi implements ExamApi {
  constructor(
    private readonly baseUrl: string = config.apiBaseUrl,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  // ── Plumbing ──────────────────────────────────────────────────────────────

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private headers(token?: string, extra?: Record<string, string>): Headers {
    const headers = new Headers({ Accept: 'application/json' });
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return headers;
  }

  /**
   * One request. Network failures and timeouts become `ApiError` with `status: 0`, which is
   * what the sync engine treats as "still offline, try later" rather than a real rejection.
   */
  private async request<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      init.timeoutMs ?? config.requestTimeoutMs,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), { ...init, signal: controller.signal });
    } catch (error) {
      throw new ApiError(
        error instanceof Error && error.name === 'AbortError'
          ? 'The request timed out.'
          : 'No connection to the server.',
        { status: 0, body: null },
      );
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      throw new ApiError(messageOf(body) ?? `Request failed (HTTP ${response.status}).`, {
        status: response.status,
        serverMessage: messageOf(body),
        code: codeOf(body),
        body,
      });
    }

    const envelope = body as Envelope<T> | null;
    // The house envelope can carry `success: 0` with HTTP 200 on some legacy routes.
    if (envelope && typeof envelope === 'object' && 'success' in envelope) {
      if (envelope.success === 0 || envelope.success === false) {
        throw new ApiError(messageOf(body) ?? 'The server rejected the request.', {
          status: response.status,
          serverMessage: messageOf(body),
          code: codeOf(body),
          body,
        });
      }
      return (envelope.data ?? ({} as T)) as T;
    }
    return body as T;
  }

  private async postJson<T>(
    path: string,
    payload: unknown,
    options: { token?: string; idempotencyKey?: string } = {},
  ): Promise<T> {
    const extra: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.idempotencyKey) extra['Idempotency-Key'] = options.idempotencyKey;
    return this.request<T>(path, {
      method: 'POST',
      headers: this.headers(options.token, extra),
      body: JSON.stringify(payload),
    });
  }

  // ── Endpoints ─────────────────────────────────────────────────────────────

  async health(): Promise<boolean> {
    try {
      await this.request<{ ok?: boolean }>('/health', {
        method: 'GET',
        headers: this.headers(),
        cache: 'no-store',
        timeoutMs: config.healthTimeoutMs,
      });
      return true;
    } catch (error) {
      if (error instanceof ApiError && !error.isOffline) {
        // A 4xx/5xx still proves the server is reachable, which is all this probe asks.
        return error.status < 500;
      }
      return false;
    }
  }

  async login(request: LoginRequest): Promise<LoginResponse> {
    const data = await this.postJson<Json>('/student/login', {
      username: request.username,
      password: request.password,
      school: request.school ?? config.defaultSchool ?? undefined,
    });
    return {
      token: str(data['token']),
      student: toProfile(data['student']),
      serverTime: str(data['server_time'], new Date().toISOString()),
    };
  }

  async me(token: string): Promise<{ student: StudentProfile; serverTime: string }> {
    const data = await this.request<Json>('/student/me', {
      method: 'GET',
      headers: this.headers(token),
    });
    return {
      student: toProfile(data['student'] ?? data),
      serverTime: str(data['server_time'], new Date().toISOString()),
    };
  }

  async logout(token: string): Promise<void> {
    await this.postJson('/student/logout', {}, { token });
  }

  async listExams(token: string): Promise<ExamListItem[]> {
    const data = await this.request<Json>('/student/exams', {
      method: 'GET',
      headers: this.headers(token),
    });
    const items = Array.isArray(data['items']) ? (data['items'] as Json[]) : [];
    return items.map(toExamListItem);
  }

  async downloadBundle(token: string, request: BundleRequest): Promise<BundleResponse> {
    const data = await this.postJson<Json>(
      `/student/exams/${request.examId}/bundle`,
      {
        mode: request.mode,
        device_id: request.deviceId,
        client_time: new Date().toISOString(),
      },
      { token, idempotencyKey: bundleIdempotencyKey(request.studentId, request.examId) },
    );

    const questionsRaw = Array.isArray(data['questions']) ? (data['questions'] as Json[]) : [];
    const mediaRaw = Array.isArray(data['media']) ? (data['media'] as Json[]) : [];

    return {
      attempt: toServerAttempt(data['attempt']),
      exam: toExamMeta(data['exam']),
      questions: questionsRaw.map(toQuestion),
      media: mediaRaw.map(toMediaRef),
      attachmentRules: toAttachmentRules(data['attachment_rules']),
      bundleChecksum: str(data['bundle_checksum']),
      issuedAt: str(data['issued_at'], new Date().toISOString()),
    };
  }

  async fetchMedia(token: string, url: string): Promise<Blob> {
    const absolute = /^https?:\/\//i.test(url) ? url : this.url(url);
    let response: Response;
    try {
      response = await this.fetchImpl(absolute, {
        headers: this.headers(token),
        cache: 'no-store',
      });
    } catch {
      throw new ApiError('Could not download exam media.', { status: 0 });
    }
    if (!response.ok) {
      throw new ApiError(`Could not download exam media (HTTP ${response.status}).`, {
        status: response.status,
      });
    }
    return response.blob();
  }

  async postSubmission(token: string, request: SubmissionRequest): Promise<SubmissionResponse> {
    const data = await this.postJson<Json>(
      `/student/attempts/${request.attemptId}/submission`,
      {
        submission_uuid: request.submissionUuid,
        device_id: request.deviceId,
        client_started_at: request.clientStartedAt,
        client_submitted_at: request.clientSubmittedAt,
        client_elapsed_seconds: request.clientElapsedSeconds,
        answer_checksum: request.answerChecksum,
        answers: request.answers.map((a) => ({
          question_id: a.questionId,
          option_id: a.optionId ?? null,
          text: a.text ?? null,
          attachments: (a.attachments ?? []).map((f) => ({
            sha256: f.sha256,
            name: f.name,
            mime: f.mime,
            bytes: f.bytes,
          })),
        })),
        attachment_manifest: request.attachmentManifest.map((m) => ({
          question_id: m.questionId,
          sha256: m.sha256,
          bytes: m.bytes,
        })),
      },
      {
        token,
        idempotencyKey: submissionIdempotencyKey(request.attemptId, request.submissionUuid),
      },
    );

    const missing = Array.isArray(data['missing_attachments'])
      ? (data['missing_attachments'] as Json[])
      : [];
    return {
      accepted: num(data['accepted']),
      attemptStatus: (str(data['attempt_status'], 'syncing') as ServerAttempt['status']) ?? 'syncing',
      missingAttachments: missing.map((m) => ({
        questionId: num(m['question_id']),
        sha256: str(m['sha256']),
      })),
      alreadySynced: bool(data['already_synced']),
    };
  }

  /**
   * Multipart upload of one answer file.
   *
   * `XMLHttpRequest` is used rather than `fetch` purely for upload progress, which matters
   * when a lab of 40 machines is pushing photographs through one ADSL line. The digest is
   * both sent as a field and used as the idempotency key, so the server can recognise a
   * duplicate before reading the body.
   */
  async uploadAttachment(
    token: string,
    request: AttachmentUploadRequest,
    onProgress?: UploadProgress,
  ): Promise<AttachmentUploadResponse> {
    const form = new FormData();
    form.set('question_id', String(request.questionId));
    form.set('submission_uuid', request.submissionUuid);
    form.set('sha256', request.sha256);
    form.set('file', request.blob, request.fileName);

    const url = this.url(`/student/attempts/${request.attemptId}/attachments`);
    const idempotencyKey = attachmentIdempotencyKey(
      request.attemptId,
      request.questionId,
      request.sha256,
    );

    const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      if (typeof XMLHttpRequest === 'undefined') {
        // Test/worker environments without XHR fall back to fetch, losing only progress.
        this.fetchImpl(url, {
          method: 'POST',
          headers: this.headers(token, { 'Idempotency-Key': idempotencyKey }),
          body: form,
        })
          .then(async (r) => resolve({ status: r.status, text: await r.text() }))
          .catch(() => reject(new ApiError('No connection to the server.', { status: 0 })));
        return;
      }

      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Idempotency-Key', idempotencyKey);
      xhr.timeout = Math.max(config.requestTimeoutMs, 120_000);
      if (onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) onProgress(event.loaded, event.total);
        };
      }
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => reject(new ApiError('No connection to the server.', { status: 0 }));
      xhr.ontimeout = () => reject(new ApiError('The upload timed out.', { status: 0 }));
      xhr.send(form);
    });

    let parsed: unknown = null;
    try {
      parsed = body.text ? JSON.parse(body.text) : null;
    } catch {
      parsed = body.text;
    }

    if (body.status < 200 || body.status >= 300) {
      throw new ApiError(messageOf(parsed) ?? `Upload failed (HTTP ${body.status}).`, {
        status: body.status,
        serverMessage: messageOf(parsed),
        code: codeOf(parsed),
        body: parsed,
      });
    }

    const data = ((parsed as Envelope<Json>)?.data ?? {}) as Json;
    return {
      stored: bool(data['stored']) || !bool(data['duplicate']),
      duplicate: bool(data['duplicate']),
      questionId: num(data['question_id'], request.questionId),
      attach: str(data['attach'], request.fileName),
      attachFileName: nullableStr(data['attach_file_name']),
    };
  }

  async finalize(token: string, request: FinalizeRequest): Promise<FinalizeResponse> {
    const data = await this.postJson<Json>(
      `/student/attempts/${request.attemptId}/finalize`,
      {
        submission_uuid: request.submissionUuid,
        answer_checksum: request.answerChecksum,
        attachment_manifest: request.attachmentManifest.map((m) => ({
          question_id: m.questionId,
          sha256: m.sha256,
        })),
      },
      {
        token,
        idempotencyKey: finalizeIdempotencyKey(request.attemptId, request.submissionUuid),
      },
    );

    return {
      attemptStatus: str(data['attempt_status'], 'submitted') as ServerAttempt['status'],
      syncedAt: str(data['synced_at'], new Date().toISOString()),
      autoScore: data['auto_score'] == null ? null : num(data['auto_score']),
      totalWeight: data['total_weight'] == null ? null : num(data['total_weight']),
      pendingReview: num(data['pending_review']),
      resultsReleased: bool(data['results_released']),
    };
  }

  async attemptStatus(token: string, attemptIds: number[]): Promise<AttemptStatusItem[]> {
    if (attemptIds.length === 0) return [];
    const query = `attempt_ids=${attemptIds.join(',')}`;
    const data = await this.request<Json>(`/student/attempts/status?${query}`, {
      method: 'GET',
      headers: this.headers(token),
    });
    const items = Array.isArray(data['items']) ? (data['items'] as Json[]) : [];
    return items.map((item) => ({
      attemptId: num(item['attempt_id']),
      status: str(item['status'], 'submitted') as ServerAttempt['status'],
      syncedAt: nullableStr(item['synced_at']),
      attachmentsStored: num(item['attachments_stored']),
      pendingReview: num(item['pending_review']),
    }));
  }
}

// ── Mappers (snake_case → domain) ───────────────────────────────────────────

function toProfile(raw: unknown): StudentProfile {
  const d = (raw ?? {}) as Json;
  return {
    studentId: num(d['student_id']),
    name: str(d['name'], 'Student'),
    username: str(d['username']),
    schemaName: str(d['schema_name']),
    schoolName: str(d['school_name'], str(d['sname'])),
    className: nullableStr(d['class']) ?? nullableStr(d['classes']),
    section: nullableStr(d['section']),
    photoUrl: nullableStr(d['photo']),
  };
}

function toServerAttempt(raw: unknown): ServerAttempt {
  const d = (raw ?? {}) as Json;
  return {
    attemptId: num(d['attempt_id'] ?? d['id']),
    submissionUuid: str(d['submission_uuid']),
    mode: str(d['mode'], 'offline') === 'online' ? 'online' : 'offline',
    status: str(d['status'], 'in_progress') as ServerAttempt['status'],
    startedAt: str(d['started_at']),
    endsAt: str(d['ends_at']),
    durationSeconds: num(d['duration_seconds']),
    submittedAt: nullableStr(d['submitted_at']),
    syncedAt: nullableStr(d['synced_at']),
  };
}

function toExamMeta(raw: unknown): ExamMeta {
  const d = (raw ?? {}) as Json;
  return {
    examId: num(d['exam_id'] ?? d['id']),
    title: str(d['title'], 'Online exam'),
    subject: str(d['subject']),
    subjectId: num(d['subject_id']),
    instructions: str(d['instructions'] ?? d['note']),
    date: nullableStr(d['date']),
    minutes: num(d['minutes'], 60),
    questionCount: num(d['question_count'] ?? d['questions']),
    totalWeight: num(d['total_weight']),
  };
}

function toQuestion(raw: Json): Question {
  const optionsRaw = Array.isArray(raw['options']) ? (raw['options'] as Json[]) : [];
  const kind = str(raw['kind'], 'written');
  return {
    questionId: num(raw['question_id'] ?? raw['id']),
    number: str(raw['number'], String(num(raw['question_id'] ?? raw['id']))),
    kind: kind === 'choice' || kind === 'upload' ? kind : 'written',
    text: str(raw['text'] ?? raw['question']),
    weight: num(raw['weight']),
    imageUrl: nullableStr(raw['image_url']),
    options: optionsRaw.map((o) => ({
      optionId: num(o['option_id'] ?? o['id']),
      text: str(o['text'] ?? o['answer']),
    })),
    maxChars: raw['max_chars'] == null ? null : num(raw['max_chars']),
    groupRef: nullableStr(raw['group_ref']),
    partLabel: nullableStr(raw['part_label']),
  };
}

function toMediaRef(raw: Json): MediaRef {
  return {
    url: str(raw['url']),
    questionId: num(raw['question_id']),
    bytes: raw['bytes'] == null ? null : num(raw['bytes']),
  };
}

function toAttachmentRules(raw: unknown): AttachmentRules {
  const d = (raw ?? {}) as Json;
  const allowed = Array.isArray(d['allowed_mime'])
    ? (d['allowed_mime'] as unknown[]).map((m) => str(m)).filter(Boolean)
    : config.limits.allowedMime;
  return {
    enabled: d['enabled'] == null ? true : bool(d['enabled']),
    maxFilesPerQuestion: num(d['max_files_per_question'], config.limits.maxFilesPerQuestion),
    maxFileBytes: num(d['max_file_bytes'], config.limits.maxFileBytes),
    allowedMime: allowed,
  };
}

function toExamListItem(raw: Json): ExamListItem {
  const serverState = str(raw['state'], 'available');
  const attempt = raw['attempt'] ? toServerAttempt(raw['attempt']) : null;
  return {
    examId: num(raw['exam_id'] ?? raw['id']),
    title: str(raw['title'], 'Online exam'),
    subject: str(raw['subject']),
    subjectId: num(raw['subject_id']),
    date: nullableStr(raw['date']),
    minutes: num(raw['minutes'], 60),
    questions: num(raw['questions']),
    totalWeight: num(raw['total_weight']),
    serverState: (['available', 'upcoming', 'in_progress', 'submitted', 'not_ready'] as const).includes(
      serverState as 'available',
    )
      ? (serverState as ExamListItem['serverState'])
      : 'available',
    resultsReleased: bool(raw['results_released']),
    score: raw['score'] == null ? null : num(raw['score']),
    total: raw['total'] == null ? null : num(raw['total']),
    attempt,
  };
}

export function createLaravelApi(baseUrl?: string): ExamApi {
  log.info('API driver: laravel', { baseUrl: baseUrl ?? config.apiBaseUrl });
  return new LaravelExamApi(baseUrl ?? config.apiBaseUrl);
}
