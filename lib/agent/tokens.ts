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

function estimateTokensFromChars(chars: number) {
  return Math.ceil((chars / CHARS_PER_TOKEN) * TOKEN_ESTIMATE_MULTIPLIER);
}

/**
 * Char count of a step's INPUT — the messages about to be sent to the model — for
 * the input side of the no-usage estimate in {@link resolveUsageTokens}. Every
 * step re-sends the whole context, and on a multi-step run the prompt (the
 * accumulated tool results and, dominant, the file content read so far) is the
 * bulk of what a provider bills as input tokens: in a typical `.debug` trace
 * per-step input grows 1.5k -> 30k tokens while output stays a few hundred. An
 * output-only estimate therefore under-counts ~8x and silently softens the token
 * budget guards — counting the input is what keeps them meaningful on a provider
 * that reports no usage.
 *
 * `JSON.stringify` captures every message part (text, tool-call args, tool
 * results) in one pass; its structural punctuation over-counts a little, which is
 * the safe direction for a seatbelt. Returns 0 if the value can't be serialised
 * (e.g. a cycle), degrading to the output-only estimate (the prior behaviour).
 */
export function estimateMessagesChars(messages: unknown): number {
  try {
    return JSON.stringify(messages)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Resolve one model call's token cost for the run-wide total that drives the
 * diminishing-returns budget and cost seatbelt. Order of preference:
 *  1. `totalTokens` — the provider's reported total. On every provider we use this
 *     ALREADY includes reasoning/thinking tokens (they are billed as output), so
 *     we never add `reasoningTokens` on top — that would double-count.
 *  2. `inputTokens + outputTokens` — when only those are reported.
 *  3. a char-based estimate — only when a provider reports no usage at all. Pass
 *     the assistant text AND reasoning text (`estimateText`) so "thinking" is
 *     counted, plus the input char count (`estimateChars`, from
 *     {@link estimateMessagesChars}) so the dominant prompt side is counted too —
 *     omitting it is what made the fallback under-count ~8x. Only this path is
 *     scaled by TOKEN_ESTIMATE_MULTIPLIER.
 * Returns 0 when there's neither usage nor any estimate basis, leaving the step
 * backstop as the floor (the documented no-usage-provider case).
 */
export function resolveUsageTokens(
  usage: UsageLike,
  estimateText = "",
  estimateChars = 0
): number {
  if (typeof usage?.totalTokens === "number") return usage.totalTokens;
  const sum = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (sum > 0) return sum;
  const chars = estimateText.length + estimateChars;
  return chars > 0 ? estimateTokensFromChars(chars) : 0;
}
