import type {
  AttachmentRules,
  ExamListItem,
  ExamMeta,
  MediaRef,
  Question,
  ServerAttempt,
  StudentProfile,
} from '../../types';
import { canonicalJson, sha256OfString } from '../util/checksum';
import { uuid } from '../util/ids';
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
 * An in-memory stand-in for the Laravel backend.
 *
 * It exists for two reasons:
 *  1. The additive `/student/*` routes in `backend-proposal/` are not merged yet, and the
 *     lab flow has to be demonstrable end to end today.
 *  2. The integration tests need a server whose idempotency and failure behaviour are the
 *     same as the real one's, without a PHP process.
 *
 * It is deliberately faithful about the things that bite: `already_synced` on a replayed
 * submission uuid, `duplicate` on a replayed attachment digest, refusal to finalise with a
 * missing attachment, and configurable failures/latency.
 */

export interface MockFailureSwitches {
  /** Probe answers "offline" until this is cleared — simulates the lab switch being off. */
  offline?: boolean;
  /** Fail the next N submission posts with a retryable 503. */
  failSubmissionTimes?: number;
  /** Fail the next N attachment uploads with a retryable 503. */
  failAttachmentTimes?: number;
  /** Fail the next N finalize calls with a retryable 503. */
  failFinalizeTimes?: number;
  /** Reject submissions with a fatal 422 (tests `needs_attention`). */
  fatalSubmission?: boolean;
  /** Artificial latency per call, ms. */
  latencyMs?: number;
}

interface MockStudent {
  profile: StudentProfile;
  password: string;
  token: string;
}

interface MockAttempt {
  attemptId: number;
  examId: number;
  studentId: number;
  submissionUuid: string;
  status: ServerAttempt['status'];
  startedAt: string;
  endsAt: string;
  durationSeconds: number;
  submittedAt: string | null;
  syncedAt: string | null;
  answers: Map<number, { optionId: number | null; text: string | null }>;
  attachments: Map<string, { questionId: number; bytes: number; name: string }>;
  manifest: { questionId: number; sha256: string; bytes: number }[];
  pendingReview: number;
}

interface MockExam {
  meta: ExamMeta;
  questions: Question[];
  media: MediaRef[];
  publishedDate: string | null;
  attachmentRules: AttachmentRules;
}

const DEFAULT_RULES: AttachmentRules = {
  enabled: true,
  maxFilesPerQuestion: 3,
  maxFileBytes: 10 * 1024 * 1024,
  allowedMime: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
};

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function question(partial: Partial<Question> & { questionId: number; number: string }): Question {
  return {
    kind: 'written',
    text: '',
    weight: 1,
    imageUrl: null,
    options: [],
    maxChars: 4000,
    groupRef: null,
    partLabel: null,
    ...partial,
  };
}

function seedExams(): MockExam[] {
  const physics: MockExam = {
    meta: {
      examId: 91,
      title: 'Mid-Term Physics',
      subject: 'Physics',
      subjectId: 12,
      instructions:
        'Answer ALL questions. Section A is multiple choice, Section B is written, Section C asks you to photograph your working and attach it. You may not leave the room before submitting.',
      date: new Date().toISOString().slice(0, 10),
      minutes: 45,
      questionCount: 7,
      totalWeight: 30,
    },
    publishedDate: new Date().toISOString().slice(0, 10),
    attachmentRules: DEFAULT_RULES,
    questions: [
      question({
        questionId: 7781,
        number: '1',
        kind: 'choice',
        weight: 2,
        text: 'A body moves 120 m in 40 s at a constant speed. What is its speed?',
        options: [
          { optionId: 55011, text: '0.3 m/s' },
          { optionId: 55012, text: '3 m/s' },
          { optionId: 55013, text: '30 m/s' },
          { optionId: 55014, text: '4800 m/s' },
        ],
      }),
      question({
        questionId: 7782,
        number: '2',
        kind: 'choice',
        weight: 2,
        text: 'Which instrument measures atmospheric pressure?',
        options: [
          { optionId: 55021, text: 'Hydrometer' },
          { optionId: 55022, text: 'Barometer' },
          { optionId: 55023, text: 'Ammeter' },
        ],
      }),
      question({
        questionId: 7783,
        number: '3',
        kind: 'written',
        weight: 5,
        text: 'Explain why a nail sinks in water while a ship made of steel floats.',
        maxChars: 1200,
      }),
      question({
        questionId: 7784,
        number: '4a',
        kind: 'written',
        weight: 3,
        text: "State Hooke's law.",
        groupRef: 'q4',
        partLabel: '(a)',
        maxChars: 600,
      }),
      question({
        questionId: 7785,
        number: '4b',
        kind: 'written',
        weight: 4,
        text: 'A spring extends 4 cm under a load of 2 N. Find its spring constant.',
        groupRef: 'q4',
        partLabel: '(b)',
        maxChars: 600,
      }),
      question({
        questionId: 7786,
        number: '4c',
        kind: 'choice',
        weight: 2,
        text: 'Beyond which point does a spring stop obeying the law in (a)?',
        groupRef: 'q4',
        partLabel: '(c)',
        options: [
          { optionId: 55061, text: 'The elastic limit' },
          { optionId: 55062, text: 'The melting point' },
          { optionId: 55063, text: 'The centre of gravity' },
        ],
      }),
      question({
        questionId: 7787,
        number: '5',
        kind: 'upload',
        weight: 12,
        text: 'Draw the extension-against-load graph for the spring in question 4, then photograph your graph and attach the picture.',
      }),
    ],
    media: [],
  };

  const maths: MockExam = {
    meta: {
      examId: 92,
      title: 'Weekly Mathematics Test',
      subject: 'Basic Mathematics',
      subjectId: 8,
      instructions: 'Answer all questions. Show your working where asked.',
      date: new Date().toISOString().slice(0, 10),
      minutes: 30,
      questionCount: 2,
      totalWeight: 10,
    },
    publishedDate: new Date().toISOString().slice(0, 10),
    attachmentRules: { ...DEFAULT_RULES, enabled: false },
    questions: [
      question({
        questionId: 8801,
        number: '1',
        kind: 'choice',
        weight: 4,
        text: 'Simplify: 3(x + 4) - 2x',
        options: [
          { optionId: 66011, text: 'x + 12' },
          { optionId: 66012, text: '5x + 4' },
          { optionId: 66013, text: 'x + 4' },
        ],
      }),
      question({
        questionId: 8802,
        number: '2',
        kind: 'written',
        weight: 6,
        text: 'A tank holds 4 500 litres. It is 60% full. How many litres must be added to fill it? Show your working.',
        maxChars: 800,
      }),
    ],
    media: [],
  };

  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const biology: MockExam = {
    meta: {
      examId: 93,
      title: 'Biology Practical (Terminal)',
      subject: 'Biology',
      subjectId: 15,
      instructions: 'Opens on the exam date.',
      date: tomorrow,
      minutes: 60,
      questionCount: 1,
      totalWeight: 20,
    },
    publishedDate: tomorrow,
    attachmentRules: DEFAULT_RULES,
    questions: [
      question({ questionId: 9901, number: '1', kind: 'written', weight: 20, text: 'Placeholder.' }),
    ],
    media: [],
  };

  const history: MockExam = {
    meta: {
      examId: 90,
      title: 'History Monthly Test',
      subject: 'History',
      subjectId: 5,
      instructions: 'Already taken.',
      date: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
      minutes: 40,
      questionCount: 1,
      totalWeight: 20,
    },
    publishedDate: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
    attachmentRules: DEFAULT_RULES,
    questions: [
      question({ questionId: 9001, number: '1', kind: 'written', weight: 20, text: 'Taken already.' }),
    ],
    media: [],
  };

  return [physics, maths, biology, history];
}

export class MockExamApi implements ExamApi {
  readonly switches: MockFailureSwitches;
  private readonly students = new Map<string, MockStudent>();
  private readonly exams = seedExams();
  private readonly attempts = new Map<number, MockAttempt>();
  /** idempotency key → the response that key produced, so a replay is a no-op. */
  private readonly idempotency = new Map<string, unknown>();
  private nextAttemptId = 550;

  /** Where the fake server keeps its state between page loads (browser only). */
  private readonly persistKey: string | null;

  constructor(switches: MockFailureSwitches = {}, options: { persist?: boolean } = {}) {
    this.switches = { latencyMs: 180, ...switches };
    // In a browser the fake server persists, because a real one does: reloading a lab
    // machine mid-exam must not make the server forget the attempt it issued. Tests opt out
    // (each gets a clean server).
    this.persistKey =
      options.persist !== false && typeof localStorage !== 'undefined'
        ? 'mock_exam_server_state'
        : null;

    const profile: StudentProfile = {
      studentId: 4812,
      name: 'Nassoro Kimaro',
      username: 'student',
      schemaName: 'demo',
      schoolName: 'Mtakuja Secondary School',
      className: 'Form III',
      section: 'A',
      photoUrl: null,
    };
    // Deterministic tokens: a real Sanctum token survives a page reload, and the demo must
    // behave the same way (the session cached in IndexedDB is still valid afterwards).
    this.students.set('student', { profile, password: 'student', token: 'mock-token-student' });

    const second: StudentProfile = {
      ...profile,
      studentId: 4813,
      name: 'Asha Mwinyi',
      username: 'student2',
    };
    this.students.set('student2', {
      profile: second,
      password: 'student',
      token: 'mock-token-student2',
    });

    // One exam is already taken, so the list shows a `completed_past` row from the start.
    this.attempts.set(540, {
      attemptId: 540,
      examId: 90,
      studentId: 4812,
      submissionUuid: uuid(),
      status: 'submitted',
      startedAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() - 7 * 86_400_000 + 2_400_000).toISOString(),
      durationSeconds: 2400,
      submittedAt: new Date(Date.now() - 7 * 86_400_000 + 1_800_000).toISOString(),
      syncedAt: new Date(Date.now() - 7 * 86_400_000 + 1_800_000).toISOString(),
      answers: new Map(),
      attachments: new Map(),
      manifest: [],
      pendingReview: 0,
    });

    this.restore();
    log.info('API driver: mock (no backend required)');
  }

  // ── Persistence (browser demo only) ───────────────────────────────────────

  private restore(): void {
    if (!this.persistKey) return;
    try {
      const raw = localStorage.getItem(this.persistKey);
      if (!raw) return;
      const state = JSON.parse(raw) as {
        nextAttemptId?: number;
        attempts?: (Omit<MockAttempt, 'answers' | 'attachments'> & {
          answers: [number, { optionId: number | null; text: string | null }][];
          attachments: [string, { questionId: number; bytes: number; name: string }][];
        })[];
        idempotency?: [string, unknown][];
      };
      if (typeof state.nextAttemptId === 'number') this.nextAttemptId = state.nextAttemptId;
      for (const attempt of state.attempts ?? []) {
        this.attempts.set(attempt.attemptId, {
          ...attempt,
          answers: new Map(attempt.answers ?? []),
          attachments: new Map(attempt.attachments ?? []),
        });
      }
      for (const [key, value] of state.idempotency ?? []) this.idempotency.set(key, value);
    } catch {
      /* a corrupt demo state is simply discarded */
    }
  }

  private persist(): void {
    if (!this.persistKey) return;
    try {
      localStorage.setItem(
        this.persistKey,
        JSON.stringify({
          nextAttemptId: this.nextAttemptId,
          attempts: [...this.attempts.values()].map((attempt) => ({
            ...attempt,
            answers: [...attempt.answers.entries()],
            attachments: [...attempt.attachments.entries()],
          })),
          idempotency: [...this.idempotency.entries()],
        }),
      );
    } catch {
      /* out of quota: the demo degrades to in-memory, which is survivable */
    }
  }

  /** Clears the fake server, so a demo can be started again from nothing. */
  reset(): void {
    this.attempts.clear();
    this.idempotency.clear();
    this.nextAttemptId = 550;
    if (this.persistKey) {
      try {
        localStorage.removeItem(this.persistKey);
      } catch {
        /* ignore */
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async delay(): Promise<void> {
    const ms = this.switches.latencyMs ?? 0;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private requireOnline(): void {
    if (this.switches.offline) {
      throw new ApiError('No connection to the server.', { status: 0 });
    }
  }

  private studentFor(token: string): MockStudent {
    for (const student of this.students.values()) {
      if (student.token === token) return student;
    }
    throw new ApiError('Unauthenticated.', { status: 401 });
  }

  private examFor(examId: number): MockExam {
    const exam = this.exams.find((e) => e.meta.examId === examId);
    if (!exam) throw new ApiError('You do not have access to this exam.', { status: 404 });
    return exam;
  }

  private attemptFor(attemptId: number, studentId: number): MockAttempt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.studentId !== studentId) {
      throw new ApiError('Exam attempt not found.', { status: 404 });
    }
    return attempt;
  }

  private attemptForExam(examId: number, studentId: number): MockAttempt | null {
    for (const attempt of this.attempts.values()) {
      if (attempt.examId === examId && attempt.studentId === studentId) return attempt;
    }
    return null;
  }

  private replay<T>(key: string): T | null {
    return this.idempotency.has(key) ? (this.idempotency.get(key) as T) : null;
  }

  /** Lets a test (or the proctor demo) flip failure behaviour at runtime. */
  setSwitches(next: MockFailureSwitches): void {
    Object.assign(this.switches, next);
  }

  // ── Endpoints ─────────────────────────────────────────────────────────────

  async health(): Promise<boolean> {
    await this.delay();
    return !this.switches.offline;
  }

  async login(request: LoginRequest): Promise<LoginResponse> {
    await this.delay();
    this.requireOnline();
    const student = this.students.get(request.username.trim().toLowerCase());
    if (!student || student.password !== request.password) {
      throw new ApiError('Wrong username or password', { status: 401 });
    }
    return {
      token: student.token,
      student: student.profile,
      serverTime: new Date().toISOString(),
    };
  }

  async me(token: string): Promise<{ student: StudentProfile; serverTime: string }> {
    await this.delay();
    this.requireOnline();
    return { student: this.studentFor(token).profile, serverTime: new Date().toISOString() };
  }

  async logout(token: string): Promise<void> {
    await this.delay();
    this.studentFor(token);
  }

  async listExams(token: string): Promise<ExamListItem[]> {
    await this.delay();
    this.requireOnline();
    const { profile } = this.studentFor(token);
    const today = new Date().toISOString().slice(0, 10);

    return this.exams.map((exam) => {
      const attempt = this.attemptForExam(exam.meta.examId, profile.studentId);
      let serverState: ExamListItem['serverState'] = 'available';
      if (attempt && attempt.status === 'in_progress') serverState = 'in_progress';
      else if (attempt) serverState = 'submitted';
      else if (exam.questions.length === 0) serverState = 'not_ready';
      else if (exam.publishedDate && exam.publishedDate > today) serverState = 'upcoming';

      const taken = attempt !== null && attempt.status !== 'in_progress';
      return {
        examId: exam.meta.examId,
        title: exam.meta.title,
        subject: exam.meta.subject,
        subjectId: exam.meta.subjectId,
        date: exam.meta.date,
        minutes: exam.meta.minutes,
        questions: exam.questions.length,
        totalWeight: exam.meta.totalWeight,
        serverState,
        resultsReleased: exam.meta.examId === 90,
        score: exam.meta.examId === 90 && taken ? 14 : null,
        total: exam.meta.examId === 90 && taken ? 20 : null,
        attempt: attempt ? this.toServerAttempt(attempt) : null,
      };
    });
  }

  private toServerAttempt(attempt: MockAttempt): ServerAttempt {
    return {
      attemptId: attempt.attemptId,
      submissionUuid: attempt.submissionUuid,
      mode: 'offline',
      status: attempt.status,
      startedAt: attempt.startedAt,
      endsAt: attempt.endsAt,
      durationSeconds: attempt.durationSeconds,
      submittedAt: attempt.submittedAt,
      syncedAt: attempt.syncedAt,
    };
  }

  async downloadBundle(token: string, request: BundleRequest): Promise<BundleResponse> {
    await this.delay();
    this.requireOnline();
    const { profile } = this.studentFor(token);
    const exam = this.examFor(request.examId);

    const today = new Date().toISOString().slice(0, 10);
    if (exam.publishedDate && exam.publishedDate > today) {
      throw new ApiError(`This exam opens on ${exam.publishedDate}.`, { status: 409 });
    }

    let attempt = this.attemptForExam(request.examId, profile.studentId);
    if (attempt && attempt.status !== 'in_progress') {
      throw new ApiError('This exam has already been taken.', { status: 409 });
    }
    if (!attempt) {
      const durationSeconds = exam.meta.minutes * 60;
      attempt = {
        attemptId: (this.nextAttemptId += 1),
        examId: request.examId,
        studentId: profile.studentId,
        submissionUuid: uuid(),
        status: 'in_progress',
        startedAt: new Date().toISOString(),
        // Generous server window: the lab is offline, so the client enforces the countdown
        // and the server re-validates the client's timing on sync.
        endsAt: isoIn(durationSeconds + 6 * 3600),
        durationSeconds,
        submittedAt: null,
        syncedAt: null,
        answers: new Map(),
        attachments: new Map(),
        manifest: [],
        pendingReview: 0,
      };
      this.attempts.set(attempt.attemptId, attempt);
      this.persist();
    }

    const questions = exam.questions;
    const bundleChecksum = `sha256:${await sha256OfString(
      canonicalJson({ exam: exam.meta, questions }),
    )}`;

    return {
      attempt: this.toServerAttempt(attempt),
      exam: exam.meta,
      questions,
      media: exam.media,
      attachmentRules: exam.attachmentRules,
      bundleChecksum,
      issuedAt: new Date().toISOString(),
    };
  }

  async fetchMedia(_token: string, url: string): Promise<Blob> {
    await this.delay();
    this.requireOnline();
    // A 1x1 transparent PNG stands in for the real image.
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+AgIAAAAASUVORK5CYII=',
      ),
      (c) => c.charCodeAt(0),
    );
    log.debug('Mock media served', url);
    return new Blob([png], { type: 'image/png' });
  }

  async postSubmission(token: string, request: SubmissionRequest): Promise<SubmissionResponse> {
    await this.delay();
    this.requireOnline();
    const { profile } = this.studentFor(token);
    const key = `attempt:${request.attemptId}:${request.submissionUuid}`;

    const replayed = this.replay<SubmissionResponse>(key);
    if (replayed) return { ...replayed, alreadySynced: true };

    if (this.switches.fatalSubmission) {
      throw new ApiError('The answer payload was rejected.', {
        status: 422,
        serverMessage: 'Question 7781 does not belong to this exam.',
      });
    }
    if ((this.switches.failSubmissionTimes ?? 0) > 0) {
      this.switches.failSubmissionTimes = (this.switches.failSubmissionTimes ?? 0) - 1;
      throw new ApiError('The server is busy.', { status: 503 });
    }

    const attempt = this.attemptFor(request.attemptId, profile.studentId);
    for (const answer of request.answers) {
      attempt.answers.set(answer.questionId, {
        optionId: answer.optionId ?? null,
        text: answer.text ?? null,
      });
    }
    attempt.manifest = request.attachmentManifest;
    attempt.status = 'syncing';

    const response: SubmissionResponse = {
      accepted: request.answers.length,
      attemptStatus: 'syncing',
      missingAttachments: request.attachmentManifest
        .filter((m) => !attempt.attachments.has(m.sha256))
        .map((m) => ({ questionId: m.questionId, sha256: m.sha256 })),
      alreadySynced: false,
    };
    this.idempotency.set(key, response);
    this.persist();
    return response;
  }

  async uploadAttachment(
    token: string,
    request: AttachmentUploadRequest,
    onProgress?: UploadProgress,
  ): Promise<AttachmentUploadResponse> {
    await this.delay();
    this.requireOnline();
    const { profile } = this.studentFor(token);
    const key = `attach:${request.attemptId}:${request.questionId}:${request.sha256}`;

    const replayed = this.replay<AttachmentUploadResponse>(key);
    if (replayed) return { ...replayed, duplicate: true };

    if ((this.switches.failAttachmentTimes ?? 0) > 0) {
      this.switches.failAttachmentTimes = (this.switches.failAttachmentTimes ?? 0) - 1;
      throw new ApiError('Upload interrupted.', { status: 503 });
    }

    const attempt = this.attemptFor(request.attemptId, profile.studentId);
    onProgress?.(Math.floor(request.blob.size / 2), request.blob.size);
    attempt.attachments.set(request.sha256, {
      questionId: request.questionId,
      bytes: request.blob.size,
      name: request.fileName,
    });
    onProgress?.(request.blob.size, request.blob.size);

    const response: AttachmentUploadResponse = {
      stored: true,
      duplicate: false,
      questionId: request.questionId,
      attach: request.fileName,
      attachFileName: `https://mock.shulesoft.africa/storage/uploads/images/attach_${request.sha256.slice(0, 10)}`,
    };
    this.idempotency.set(key, response);
    this.persist();
    return response;
  }

  async finalize(token: string, request: FinalizeRequest): Promise<FinalizeResponse> {
    await this.delay();
    this.requireOnline();
    const { profile } = this.studentFor(token);
    const key = `final:${request.attemptId}:${request.submissionUuid}`;

    const replayed = this.replay<FinalizeResponse>(key);
    if (replayed) return replayed;

    if ((this.switches.failFinalizeTimes ?? 0) > 0) {
      this.switches.failFinalizeTimes = (this.switches.failFinalizeTimes ?? 0) - 1;
      throw new ApiError('The server is busy.', { status: 503 });
    }

    const attempt = this.attemptFor(request.attemptId, profile.studentId);
    const missing = request.attachmentManifest.filter((m) => !attempt.attachments.has(m.sha256));
    if (missing.length > 0) {
      throw new ApiError('Some answer files have not arrived yet.', {
        status: 409,
        code: 'missing_attachments',
        serverMessage: `${missing.length} answer file(s) are still missing.`,
      });
    }

    const exam = this.examFor(attempt.examId);
    attempt.status = 'submitted';
    attempt.submittedAt = new Date().toISOString();
    attempt.syncedAt = new Date().toISOString();
    attempt.pendingReview = exam.questions.filter((q) => q.kind === 'upload').length;

    // Crude "marking", only so the UI has a plausible number to show.
    let autoScore = 0;
    for (const q of exam.questions) {
      const given = attempt.answers.get(q.questionId);
      if (!given) continue;
      if (q.kind === 'choice' && given.optionId) autoScore += Math.round(q.weight * 0.75);
      else if (q.kind === 'written' && (given.text ?? '').length > 20) autoScore += Math.round(q.weight * 0.6);
    }

    const response: FinalizeResponse = {
      attemptStatus: 'submitted',
      syncedAt: attempt.syncedAt,
      autoScore,
      totalWeight: exam.meta.totalWeight,
      pendingReview: attempt.pendingReview,
      resultsReleased: false,
    };
    this.idempotency.set(key, response);
    this.persist();
    return response;
  }

  async attemptStatus(token: string, attemptIds: number[]): Promise<AttemptStatusItem[]> {
    await this.delay();
    this.requireOnline();
    const { profile } = this.studentFor(token);
    const out: AttemptStatusItem[] = [];
    for (const id of attemptIds) {
      const attempt = this.attempts.get(id);
      if (!attempt || attempt.studentId !== profile.studentId) continue;
      out.push({
        attemptId: attempt.attemptId,
        status: attempt.status,
        syncedAt: attempt.syncedAt,
        attachmentsStored: attempt.attachments.size,
        pendingReview: attempt.pendingReview,
      });
    }
    return out;
  }
}

export function createMockApi(switches?: MockFailureSwitches): ExamApi {
  return new MockExamApi(switches);
}
