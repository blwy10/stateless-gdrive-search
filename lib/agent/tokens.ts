// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

/** Rough chars-per-token for the estimate-only fallback (see {@link resolveUsageTokens}). */
const CHARS_PER_TOKEN = 4;
/**
 * Calibration applied ONLY to the char-based estimate fallback, never to real
 * provider usage. char/4 tends to under-count code/structured text; bump this if
 * your no-usage endpoints consistently under-report. Default 1 (no adjustment).
 */
const TOKEN_ESTIMATE_MULTIPLIER = 1;

/** Minimal structural view of the SDK's LanguageModelUsage we read. */
type UsageLike =
  | {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      reasoningTokens?: number;
    }
  | undefined;

function estimateTokensFromText(text: string) {
  return Math.ceil((text.length / CHARS_PER_TOKEN) * TOKEN_ESTIMATE_MULTIPLIER);
}

/**
 * Resolve one model call's token cost for the run-wide total that drives the
 * diminishing-returns budget and cost seatbelt. Order of preference:
 *  1. `totalTokens` — the provider's reported total. On every provider we use this
 *     ALREADY includes reasoning/thinking tokens (they are billed as output), so
 *     we never add `reasoningTokens` on top — that would double-count.
 *  2. `inputTokens + outputTokens` — when only those are reported.
 *  3. a char-based estimate of the visible text (`estimateText`) — only when a
 *     provider reports no usage at all. Pass the assistant text AND reasoning text
 *     so "thinking" is still counted (it isn't invisible to us — it's in
 *     `reasoningText`). Only this path is scaled by TOKEN_ESTIMATE_MULTIPLIER.
 * Returns 0 when there's neither usage nor text, leaving the step backstop as the
 * floor (the documented no-usage-provider case).
 */
export function resolveUsageTokens(usage: UsageLike, estimateText = ""): number {
  if (typeof usage?.totalTokens === "number") return usage.totalTokens;
  const sum = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (sum > 0) return sum;
  return estimateText ? estimateTokensFromText(estimateText) : 0;
}
