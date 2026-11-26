import { describe, expect, it } from 'vitest';
import { hasAttemptsLeft, isRetryableStatus, nextDelayMs, type BackoffPolicy } from './backoff';
import { canonicalJson, checksumOf, sha256Bytes, sha256OfString } from './checksum';
import {
  attachmentIdempotencyKey,
  attemptKey,
  finalizeIdempotencyKey,
  parseAttemptKey,
  parseScopeKey,
  scopeKey,
  submissionIdempotencyKey,
  uuid,
} from './ids';

const POLICY: BackoffPolicy = { baseDelayMs: 2_000, maxDelayMs: 300_000, maxAttempts: 10, jitter: 0 };

describe('retry policy', () => {
  it('doubles the delay and then caps it', () => {
    expect(nextDelayMs(1, POLICY)).toBe(2_000);
    expect(nextDelayMs(2, POLICY)).toBe(4_000);
    expect(nextDelayMs(3, POLICY)).toBe(8_000);
    expect(nextDelayMs(8, POLICY)).toBe(256_000);
    expect(nextDelayMs(9, POLICY)).toBe(300_000);
    expect(nextDelayMs(50, POLICY)).toBe(300_000);
  });

  it('spreads retries with jitter so a whole lab does not reconnect in lockstep', () => {
    const jittered: BackoffPolicy = { ...POLICY, jitter: 0.2 };

    expect(nextDelayMs(1, jittered, () => 0)).toBe(1_600); // -20%
    expect(nextDelayMs(1, jittered, () => 1)).toBe(2_400); // +20%
    expect(nextDelayMs(1, jittered, () => 0.5)).toBe(2_000);
  });

  it('runs out of attempts at the policy limit', () => {
    expect(hasAttemptsLeft(0, POLICY)).toBe(true);
    expect(hasAttemptsLeft(9, POLICY)).toBe(true);
    expect(hasAttemptsLeft(10, POLICY)).toBe(false);
  });

  it('retries transport failures and server errors, not rejections', () => {
    expect(isRetryableStatus(0)).toBe(true); // no response: the lab is still offline
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);

    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(409)).toBe(false);
    expect(isRetryableStatus(422)).toBe(false);
  });
});

describe('checksums', () => {
  it('matches the SHA-256 of known input', async () => {
    // The canonical test vector; proves the pure implementation is a real SHA-256.
    expect(sha256Bytes(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Bytes(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256OfString('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('handles input spanning several blocks', async () => {
    const long = 'a'.repeat(1_000);
    expect(await sha256OfString(long)).toBe(sha256Bytes(new TextEncoder().encode(long)));
  });

  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([{ z: 1, y: 2 }])).toBe('[{"y":2,"z":1}]');
  });

  it('a checksum is stable for equivalent payloads and changes with content', async () => {
    const one = await checksumOf({ answers: [{ questionId: 1, text: 'x' }] });
    const same = await checksumOf({ answers: [{ text: 'x', questionId: 1 }] });
    const different = await checksumOf({ answers: [{ questionId: 1, text: 'y' }] });

    expect(one).toBe(same);
    expect(one).not.toBe(different);
    expect(one.startsWith('sha256:')).toBe(true);
  });
});

describe('keys', () => {
  it('scopes and attempt keys round-trip', () => {
    expect(scopeKey('demo', 4812)).toBe('demo::4812');
    expect(attemptKey('demo', 4812, 91)).toBe('demo::4812::91');
    expect(parseAttemptKey('demo::4812::91')).toEqual({
      schemaName: 'demo',
      studentId: 4812,
      examId: 91,
      scopeKey: 'demo::4812',
    });
    expect(parseScopeKey('demo::4812')).toEqual({ schemaName: 'demo', studentId: 4812 });
    expect(parseAttemptKey('rubbish')).toBeNull();
  });

  it('idempotency keys are derived only from server ids and digests', () => {
    expect(submissionIdempotencyKey(551, 'uuid-1')).toBe('attempt:551:uuid-1');
    expect(attachmentIdempotencyKey(551, 7783, 'abc')).toBe('attach:551:7783:abc');
    expect(finalizeIdempotencyKey(551, 'uuid-1')).toBe('final:551:uuid-1');

    // Same inputs after a browser restart must give the same key.
    expect(submissionIdempotencyKey(551, 'uuid-1')).toBe(submissionIdempotencyKey(551, 'uuid-1'));
  });

  it('generates distinct v4 uuids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => uuid()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});
