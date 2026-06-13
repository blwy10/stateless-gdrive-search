// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

/**
 * In-memory, per-user abuse protection for the agent endpoint.
 *
 * Two independent limiters, both keyed by the authenticated user's `ownerSub`:
 *
 * - {@link TokenBucketRateLimiter} caps how frequently a user may *start* runs.
 *   Each run fans out to a paid AI API and the Google Drive API, so an
 *   unbounded authenticated user could otherwise run up cost/quota.
 * - {@link ConcurrencyLimiter} caps how many runs a single user may have in
 *   flight at once. Each run holds an open SSE stream plus server resources.
 *
 * State is process-local. That is deliberate (and, per the review, "better than
 * nothing"): it fully protects a single-instance deployment and meaningfully
 * raises the bar elsewhere. If this app is ever scaled to multiple replicas,
 * move the state to a shared store (e.g. Redis or Postgres) so the limits are
 * enforced globally instead of per instance.
 */

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

type Bucket = { tokens: number; lastRefillMs: number };

/**
 * Classic token bucket: `capacity` tokens that refill at `refillPerSecond`.
 * Consuming a token is allowed; when empty, the caller is told (roughly) how
 * long until the next token becomes available.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweepMs = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly sweepIntervalMs = 5 * 60 * 1000
  ) {}

  take(key: string, now: number = Date.now()): RateLimitDecision {
    this.maybeSweep(now);

    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefillMs: now };
    const elapsedSeconds = Math.max(0, (now - bucket.lastRefillMs) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.lastRefillMs = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      return { allowed: true };
    }

    this.buckets.set(key, bucket);
    const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerSecond));
    return { allowed: false, retryAfterSeconds };
  }

  /**
   * Drop idle buckets (those that have fully refilled and would be recreated
   * identically on next use) so the map cannot grow without bound. Runs at most
   * once per `sweepIntervalMs` and is triggered by traffic, so there are no
   * timers to leak in serverless/HMR environments.
   */
  private maybeSweep(now: number) {
    if (now - this.lastSweepMs < this.sweepIntervalMs) return;
    this.lastSweepMs = now;
    for (const [key, bucket] of this.buckets) {
      const elapsedSeconds = Math.max(0, (now - bucket.lastRefillMs) / 1000);
      const tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
      if (tokens >= this.capacity) this.buckets.delete(key);
    }
  }
}

/**
 * Caps the number of concurrently held slots per key. {@link tryAcquire}
 * returns `false` when the key is already at its limit; every successful
 * acquire must be paired with exactly one {@link release}.
 */
export class ConcurrencyLimiter {
  private readonly active = new Map<string, number>();

  constructor(private readonly maxPerKey: number) {}

  tryAcquire(key: string): boolean {
    const current = this.active.get(key) ?? 0;
    if (current >= this.maxPerKey) return false;
    this.active.set(key, current + 1);
    return true;
  }

  release(key: string) {
    const current = this.active.get(key);
    if (current === undefined) return;
    if (current <= 1) {
      this.active.delete(key);
    } else {
      this.active.set(key, current - 1);
    }
  }

  activeCount(key: string): number {
    return this.active.get(key) ?? 0;
  }
}

// Process-local singletons. Stored on globalThis so Next.js dev HMR (which
// re-evaluates modules) reuses the same limiter state instead of resetting it
// on every edit — mirroring how lib/db.ts keeps a single pg Pool.
const globalForRateLimit = globalThis as unknown as {
  agentRateLimiter?: TokenBucketRateLimiter;
  agentConcurrencyLimiter?: ConcurrencyLimiter;
};

export function getAgentRateLimiter(): TokenBucketRateLimiter {
  if (!globalForRateLimit.agentRateLimiter) {
    // Defaults are generous enough for normal interactive use while still
    // bounding cost/quota for a single misbehaving account. Tunable via env.
    const burst = readPositiveInt("AGENT_RATE_LIMIT_BURST", 10);
    const perMinute = readPositiveInt("AGENT_RATE_LIMIT_PER_MINUTE", 20);
    globalForRateLimit.agentRateLimiter = new TokenBucketRateLimiter(burst, perMinute / 60);
  }
  return globalForRateLimit.agentRateLimiter;
}

export function getAgentConcurrencyLimiter(): ConcurrencyLimiter {
  if (!globalForRateLimit.agentConcurrencyLimiter) {
    const maxConcurrent = readPositiveInt("AGENT_MAX_CONCURRENT_RUNS", 2);
    globalForRateLimit.agentConcurrencyLimiter = new ConcurrencyLimiter(maxConcurrent);
  }
  return globalForRateLimit.agentConcurrencyLimiter;
}

// Retry-After hint (seconds) for the concurrency cap. Unlike the token bucket
// there is no precise time at which a slot frees up (it depends on when the
// user's other run finishes), so we return a small fixed backoff.
export const CONCURRENCY_RETRY_AFTER_SECONDS = 5;
