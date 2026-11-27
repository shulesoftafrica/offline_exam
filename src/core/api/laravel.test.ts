import { describe, expect, it } from 'vitest';

import { verifyBundlePayload } from '../exam/bundle';
import { LaravelExamApi } from './laravel';

/**
 * The real driver against the real wire format.
 *
 * These exist because of a bug that no amount of testing against the mock could have
 * found: the server signs the bundle it sends — snake_case keys, `"options": []` for a
 * written question — while the client used to re-sign its own camel-cased mapping of it.
 * The two digests could never agree, so against the live backend *every* exam failed
 * verification with "the exam download is incomplete or was altered in transit" and no
 * student could start. The payload below is the shape the controller emits, and
 * `GOLDEN_CHECKSUM` was produced by the PHP implementation in
 * `Api\Student\OfflineExamController::canonical()`, so a change to either canonicaliser
 * fails here.
 */
const GOLDEN_CHECKSUM = 'sha256:e7cf1db042986aa11ae68a61c485c6c89e6bd539e98f8fe23c9365f19c9edf64';

const EXAM = {
  exam_id: 42,
  title: 'Mambo / Mazuri',
  minutes: 30,
  question_count: 2,
  total_weight: 15,
  instructions: null,
};

const QUESTIONS = [
  {
    question_id: 7,
    number: '1',
    kind: 'written',
    text: 'Seli zote zinatoka kwa seli zilizotangulia.',
    weight: 10,
    image_url: null,
    max_chars: 4000,
    group_ref: null,
    part_label: null,
    input_hint: 'boolean',
    options: [],
  },
  {
    question_id: 8,
    number: '2',
    kind: 'choice',
    text: 'Pick one',
    weight: 5,
    image_url: 'https://example.test/storage/uploads/attach/a.png',
    max_chars: null,
    group_ref: null,
    part_label: null,
    input_hint: null,
    options: [
      { option_id: 11, text: 'A' },
      { option_id: 12, text: 'B' },
    ],
  },
];

function bundleBody(overrides: { questions?: unknown[]; checksum?: string } = {}): string {
  return JSON.stringify({
    success: 1,
    data: {
      attempt: {
        attempt_id: 7,
        submission_uuid: 'uuid-7',
        mode: 'offline',
        status: 'in_progress',
        started_at: '2026-11-27T08:00:00+00:00',
        ends_at: '2026-11-27T20:00:00+00:00',
        duration_seconds: 1800,
        submitted_at: null,
        synced_at: null,
      },
      exam: EXAM,
      attachment_rules: {
        enabled: false,
        max_files_per_question: 3,
        max_file_bytes: 10485760,
        allowed_mime: ['image/jpeg'],
      },
      questions: overrides.questions ?? QUESTIONS,
      media: [],
      bundle_checksum: overrides.checksum ?? GOLDEN_CHECKSUM,
      issued_at: '2026-11-27T08:00:01+00:00',
    },
  });
}

function apiReturning(body: string): { api: LaravelExamApi; headers: () => Headers | undefined } {
  let seen: Headers | undefined;
  const api = new LaravelExamApi('http://api.test/api', async (_url, init) => {
    seen = new Headers((init as RequestInit | undefined)?.headers);
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { api, headers: () => seen };
}

const REQUEST = { examId: 42, studentId: 300, mode: 'offline' as const, deviceId: 'lab-01' };

describe('LaravelExamApi.downloadBundle', () => {
  it('produces a bundle that verifies against the checksum the server sent', async () => {
    const { api } = apiReturning(bundleBody());

    const response = await api.downloadBundle('token', REQUEST);
    const verification = await verifyBundlePayload(response);

    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
    expect(verification.checksumMatches).toBe(true);
  });

  it('refuses a bundle whose question text was altered in transit', async () => {
    const tampered = [{ ...QUESTIONS[0], text: 'Seli zote ni mpya.' }, QUESTIONS[1]];
    const { api } = apiReturning(bundleBody({ questions: tampered }));

    const verification = await verifyBundlePayload(await api.downloadBundle('token', REQUEST));

    expect(verification.checksumMatches).toBe(false);
    expect(verification.problems).toContain(
      'The exam download is incomplete or was altered in transit.',
    );
  });

  it('maps the input hint, so a true/false question is not shown as an empty box', async () => {
    const { api } = apiReturning(bundleBody());

    const response = await api.downloadBundle('token', REQUEST);

    expect(response.questions[0]?.inputHint).toBe('boolean');
    expect(response.questions[0]?.kind).toBe('written');
    expect(response.questions[1]?.inputHint).toBeNull();
  });

  it('sends an idempotency key derived from the student and the exam', async () => {
    const { api, headers } = apiReturning(bundleBody());

    await api.downloadBundle('token', REQUEST);

    expect(headers()?.get('Idempotency-Key')).toBe('bundle:300:42');
    expect(headers()?.get('Authorization')).toBe('Bearer token');
  });
});
