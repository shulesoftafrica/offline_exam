import type { AttemptKey, ScopeKey } from '../../types';

/** Separator chosen so it cannot appear in a Postgres schema name or a numeric id. */
const SEP = '::';

export function scopeKey(schemaName: string, studentId: number): ScopeKey {
  return `${schemaName}${SEP}${studentId}`;
}

export function attemptKey(schemaName: string, studentId: number, examId: number): AttemptKey {
  return `${schemaName}${SEP}${studentId}${SEP}${examId}`;
}

export function answerId(key: AttemptKey, questionId: number): string {
  return `${key}${SEP}${questionId}`;
}

export interface ParsedAttemptKey {
  schemaName: string;
  studentId: number;
  examId: number;
  scopeKey: ScopeKey;
}

export function parseAttemptKey(key: AttemptKey): ParsedAttemptKey | null {
  const parts = key.split(SEP);
  if (parts.length !== 3) return null;
  const [schemaName, studentRaw, examRaw] = parts as [string, string, string];
  const studentId = Number(studentRaw);
  const examId = Number(examRaw);
  if (!schemaName || !Number.isInteger(studentId) || !Number.isInteger(examId)) return null;
  return { schemaName, studentId, examId, scopeKey: scopeKey(schemaName, studentId) };
}

export function parseScopeKey(key: ScopeKey): { schemaName: string; studentId: number } | null {
  const parts = key.split(SEP);
  if (parts.length !== 2) return null;
  const [schemaName, studentRaw] = parts as [string, string];
  const studentId = Number(studentRaw);
  if (!schemaName || !Number.isInteger(studentId)) return null;
  return { schemaName, studentId };
}

/** RFC-4122 v4, from `crypto.randomUUID` where available and a CSPRNG fallback elsewhere. */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Short, human-quotable id for log lines and the proctor's diagnostics export. */
export function shortId(): string {
  return uuid().replace(/-/g, '').slice(0, 12);
}

// ── Idempotency keys ────────────────────────────────────────────────────────
// Derived only from server-issued ids and content digests, never from randomness at
// send time, so a retry after a browser restart carries exactly the same key.

export function bundleIdempotencyKey(studentId: number, examId: number): string {
  return `bundle:${studentId}:${examId}`;
}

export function submissionIdempotencyKey(attemptId: number, submissionUuid: string): string {
  return `attempt:${attemptId}:${submissionUuid}`;
}

export function attachmentIdempotencyKey(
  attemptId: number,
  questionId: number,
  sha256: string,
): string {
  return `attach:${attemptId}:${questionId}:${sha256}`;
}

export function finalizeIdempotencyKey(attemptId: number, submissionUuid: string): string {
  return `final:${attemptId}:${submissionUuid}`;
}
