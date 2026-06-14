// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { fetch as undiciFetch } from "undici";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { EffectiveModelSettings, ReasoningEffort } from "@/lib/model-settings";
import { ssrfSafeDispatcher } from "@/lib/ssrf";

/**
 * Per-request timeout (connect + response-body read) for a single outbound model
 * HTTP call. Bounding each request — rather than the whole multi-step
 * generateText run — preserves the old `callModel` semantics now that the SDK
 * drives the loop. Drive tool calls use undici directly and are unaffected.
 */
const MODEL_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Longer per-request timeout for the summarizer role only. Unlike the main/grader
 * calls (small outputs, comfortably under the default), the summarizer generates a
 * single large output (~8k tokens) that at typical provider throughput legitimately
 * runs ~50s+ — so the default 60s leaves almost no margin and serverless
 * tail-latency variance can abort a healthy summary into a truncation fallback
 * (observed in a `.debug` trace: a ~7k-token summary at ~150 tok/s timed out at 60s
 * while a sibling finished at ~48s). This is headroom for a slow-but-healthy call,
 * not a target — it is still a backstop against a genuinely hung request. Tune here.
 */
export const SUMMARIZER_REQUEST_TIMEOUT_MS = 180_000;

/**
 * Anthropic API floor for an extended-thinking budget. Below this the API rejects
 * the request, so it doubles as the "thinking off" threshold: a mapped budget of
 * 0 (reasoning effort unset) stays under it and disables thinking entirely. That
 * OFF default is deliberate — extended thinking is only accepted by
 * thinking-capable Claude models (3.7 / 4+) and forces temperature to 1, so it
 * must stay opt-in (set a reasoning effort to turn it on). The reasoning it then
 * produces is logged and round-tripped through the same unified path
 * (`response.messages`) as every other provider.
 */
const ANTHROPIC_MIN_THINKING_BUDGET_TOKENS = 1024;

/**
 * Headroom added above the thinking budget for the visible answer: Anthropic
 * requires `max_tokens > thinking.budget_tokens`, so we cap output at
 * budget + this margin whenever thinking is enabled.
 */
const ANTHROPIC_ANSWER_TOKEN_MARGIN = 8192;

/**
 * Map our reasoning-effort levels onto an Anthropic extended-thinking *integer*
 * token budget. `"none"` (the explicit provider default) returns 0, which keeps
 * thinking OFF (see {@link ANTHROPIC_MIN_THINKING_BUDGET_TOKENS}).
 *
 * CRITICAL DESIGN DECISION (full rationale: AGENTS.md → "Reasoning effort"):
 * Anthropic exposes two reasoning controls — `thinking.budgetTokens` (this integer
 * budget, supported across thinking-capable models 3.7 → 4.x) and a newer `effort`
 * enum (`low|medium|high|xhigh|max`, Opus 4.5+ only). We deliberately use the
 * budget, NOT the native enum: it covers the broad model set (the enum 4xx's on
 * older ones), our `minimal` has no native-enum equivalent, and the integer makes
 * the `max_tokens > budget` interplay explicit. Trade-off: these numbers are a
 * hand-tuned judgment call, not Anthropic's own calibration — revisit if the
 * deployment standardises on Opus 4.5+ or wants Anthropic-calibrated levels.
 */
function reasoningEffortToAnthropicBudget(effort: ReasoningEffort): number {
  switch (effort) {
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return 16384;
    case "none":
      return 0;
  }
}

/** Low-variance default temperature for the research agent. */
const DEFAULT_TEMPERATURE = 0.2;

type GlobalFetch = typeof globalThis.fetch;

/**
 * Build a fetch wrapper for outbound model calls that:
 *  1. bounds each individual HTTP request with `timeoutMs` (the per-role ceiling —
 *     default {@link MODEL_REQUEST_TIMEOUT_MS}, summarizer
 *     {@link SUMMARIZER_REQUEST_TIMEOUT_MS}), combined with any caller-supplied signal,
 *  2. refuses redirects — a validated host can still answer with a 302 to an
 *     internal/metadata address (e.g. 169.254.169.254), and
 *  3. for user-supplied ("custom") endpoints, validates the resolved IP at
 *     connect time via {@link ssrfSafeDispatcher}, closing the DNS-rebinding
 *     window left by the up-front URL check.
 *
 * The operator default endpoint is trusted and skips the dispatcher (it may
 * legitimately resolve to an internal host). This mirrors the SSRF posture the
 * old hand-rolled `callModel` had before the SDK migration.
 */
function createModelFetch(applySsrfGuard: boolean, timeoutMs: number): GlobalFetch {
  return async (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      signal,
      redirect: "error",
      ...(applySsrfGuard ? { dispatcher: ssrfSafeDispatcher } : {})
    } as Parameters<typeof undiciFetch>[1]);
    return response as unknown as Response;
  };
}

/**
 * A model resolved from {@link EffectiveModelSettings}, ready to hand to
 * `generateText` / `generateObject`, together with the provider-specific options
 * and the call temperature that belong with it.
 */
export type ResolvedModel = {
  model: LanguageModel;
  providerOptions: ProviderOptions;
  /**
   * Temperature for the call, or `undefined` to use the provider default
   * (omitted for Anthropic when extended thinking is on, which forces temp 1).
   */
  temperature: number | undefined;
  /**
   * Max output tokens, or `undefined` to use the provider default. Set only for
   * Anthropic when extended thinking is on, where the API requires
   * `max_tokens > thinking.budget_tokens`.
   */
  maxOutputTokens: number | undefined;
};

/**
 * Map (default or custom) model settings onto a concrete AI SDK language model.
 * Centralizes provider selection, the SSRF-safe fetch, and per-provider
 * reasoning configuration so the agent loop stays provider-agnostic. The
 * role's `reasoningEffort` (when set) is threaded into each provider's native
 * shape; `null` omits it and uses the provider default:
 *  - `openai`            -> Responses API, stateless (`store: false`) with
 *                          encrypted reasoning included so chain-of-thought
 *                          round-trips across tool steps without server-side
 *                          retention. Effort -> `reasoningEffort`.
 *  - `anthropic`         -> Messages API; no `reasoning_effort` param, so effort
 *                          maps to an extended-thinking budget (off when `none`;
 *                          see {@link reasoningEffortToAnthropicBudget}).
 *  - `openai-compatible` -> Fireworks / vLLM / custom; reasoning_content is
 *                          surfaced automatically by the provider when present.
 *                          Effort -> `reasoning_effort` via the `openaiCompatible`
 *                          provider-options key.
 *
 * `requestTimeoutMs` is the per-HTTP-request ceiling for this model's calls
 * (default {@link MODEL_REQUEST_TIMEOUT_MS}). The summarizer passes
 * {@link SUMMARIZER_REQUEST_TIMEOUT_MS} because its single large output legitimately
 * runs longer than the small main/grader calls.
 */
export function resolveModel(
  settings: EffectiveModelSettings,
  requestTimeoutMs: number = MODEL_REQUEST_TIMEOUT_MS
): ResolvedModel {
  const fetchImpl = createModelFetch(settings.source === "custom", requestTimeoutMs);

  if (settings.provider === "anthropic") {
    const anthropic = createAnthropic({
      apiKey: settings.apiKey,
      ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
      fetch: fetchImpl
    });
    const thinkingBudget = reasoningEffortToAnthropicBudget(settings.reasoningEffort);
    const thinkingEnabled = thinkingBudget >= ANTHROPIC_MIN_THINKING_BUDGET_TOKENS;
    return {
      model: anthropic.languageModel(settings.model),
      providerOptions: thinkingEnabled
        ? {
            anthropic: {
              thinking: { type: "enabled", budgetTokens: thinkingBudget }
            }
          }
        : {},
      // The API requires max_tokens > thinking.budget_tokens; leave headroom for
      // the answer. Omitted (provider default) when thinking is off.
      maxOutputTokens: thinkingEnabled ? thinkingBudget + ANTHROPIC_ANSWER_TOKEN_MARGIN : undefined,
      temperature: thinkingEnabled ? undefined : DEFAULT_TEMPERATURE
    };
  }

  if (settings.provider === "openai-compatible") {
    if (!settings.baseUrl) {
      throw new Error("An endpoint URL is required for the openai-compatible provider");
    }
    const compatible = createOpenAICompatible({
      name: "custom",
      baseURL: settings.baseUrl,
      apiKey: settings.apiKey,
      fetch: fetchImpl
    });
    return {
      model: compatible.chatModel(settings.model),
      // The provider reads the name-independent `openaiCompatible` key and forwards
      // `reasoningEffort` as `reasoning_effort` in the request body. Omitted on
      // "none" so non-reasoning models (and the provider default) are unaffected.
      providerOptions:
        settings.reasoningEffort !== "none"
          ? { openaiCompatible: { reasoningEffort: settings.reasoningEffort } }
          : {},
      maxOutputTokens: undefined,
      temperature: DEFAULT_TEMPERATURE
    };
  }

  // openai (native Responses API)
  const openai = createOpenAI({
    apiKey: settings.apiKey,
    ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
    fetch: fetchImpl
  });
  return {
    model: openai.responses(settings.model),
    providerOptions: {
      openai: {
        // Stateless reasoning round-trip: don't let OpenAI persist the response,
        // but ask for the encrypted reasoning item so the SDK can resend it on
        // the next step. reasoningSummary surfaces a readable summary for logs.
        // All three are ignored by non-reasoning models (e.g. gpt-4.1-mini).
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoningSummary: "auto",
        // Effort is forwarded as-is; omitted on "none" so the model's own default
        // applies (and so non-reasoning models are unaffected).
        ...(settings.reasoningEffort !== "none"
          ? { reasoningEffort: settings.reasoningEffort }
          : {})
      }
    },
    maxOutputTokens: undefined,
    temperature: DEFAULT_TEMPERATURE
  };
}
