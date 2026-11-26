/**
 * Retry timing for the sync outbox. Pure so the policy can be asserted in tests instead of
 * being discovered in a lab at 8am.
 */

export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  /** Fraction of the delay applied as random spread, e.g. 0.2 for +/-20%. */
  jitter: number;
}

/**
 * Exponential: base * 2^(attempt-1), capped, then jittered. `attempt` is 1 for the first
 * failure. `random` is injectable so tests get a deterministic delay.
 */
export function nextDelayMs(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = policy.baseDelayMs * 2 ** (n - 1);
  const capped = Math.min(policy.maxDelayMs, raw);
  if (policy.jitter <= 0) return Math.round(capped);
  const spread = capped * policy.jitter;
  // random() in [0,1) maps to [-spread, +spread)
  return Math.max(0, Math.round(capped + (random() * 2 - 1) * spread));
}

export function hasAttemptsLeft(attempt: number, policy: BackoffPolicy): boolean {
  return attempt < policy.maxAttempts;
}

/**
 * Which HTTP outcomes are worth trying again.
 *
 * `0` stands for "no response at all" (the lab switch is still off, DNS failed, the request
 * timed out) which is the common case here and always retryable.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 0) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status <= 599;
}
