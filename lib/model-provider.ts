// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { fetch as undiciFetch } from "undici";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { EffectiveModelSettings } from "@/lib/model-settings";
import { ssrfSafeDispatcher } from "@/lib/ssrf";

/**
 * Per-request timeout (connect + response-body read) for a single outbound model
 * HTTP call. Bounding each request — rather than the whole multi-step
 * generateText run — preserves the old `callModel` semantics now that the SDK
 * drives the loop. Drive tool calls use undici directly and are unaffected.
 */
const MODEL_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Anthropic extended-thinking budget in tokens. `0` disables thinking, the safe
 * default: extended thinking is only accepted by thinking-capable Claude models
 * (3.7 / 4+) and forces temperature to 1, so enabling it blindly would break
 * other models. Set this to >= 1024 when the configured model supports it; the
 * reasoning it then produces is logged and round-tripped through the same
 * unified path (`response.messages`) as every other provider.
 */
const ANTHROPIC_THINKING_BUDGET_TOKENS = 0;

/** Low-variance default temperature for the research agent. */
const DEFAULT_TEMPERATURE = 0.2;

type GlobalFetch = typeof globalThis.fetch;

/**
 * Build a fetch wrapper for outbound model calls that:
 *  1. bounds each individual HTTP request with {@link MODEL_REQUEST_TIMEOUT_MS}
 *     (combined with any caller-supplied signal),
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
function createModelFetch(applySsrfGuard: boolean): GlobalFetch {
  return async (input, init) => {
    const timeoutSignal = AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS);
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
};

/**
 * Map (default or custom) model settings onto a concrete AI SDK language model.
 * Centralizes provider selection, the SSRF-safe fetch, and per-provider
 * reasoning configuration so the agent loop stays provider-agnostic:
 *  - `openai`            -> Responses API, stateless (`store: false`) with
 *                          encrypted reasoning included so chain-of-thought
 *                          round-trips across tool steps without server-side
 *                          retention.
 *  - `anthropic`         -> Messages API; extended thinking is opt-in (see
 *                          {@link ANTHROPIC_THINKING_BUDGET_TOKENS}).
 *  - `openai-compatible` -> Fireworks / vLLM / custom; reasoning_content is
 *                          surfaced automatically by the provider when present.
 */
export function resolveModel(settings: EffectiveModelSettings): ResolvedModel {
  const fetchImpl = createModelFetch(settings.source === "custom");

  if (settings.provider === "anthropic") {
    const anthropic = createAnthropic({
      apiKey: settings.apiKey,
      ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
      fetch: fetchImpl
    });
    const thinkingEnabled = ANTHROPIC_THINKING_BUDGET_TOKENS >= 1024;
    return {
      model: anthropic.languageModel(settings.model),
      providerOptions: thinkingEnabled
        ? {
            anthropic: {
              thinking: { type: "enabled", budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS }
            }
          }
        : {},
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
      providerOptions: {},
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
        reasoningSummary: "auto"
      }
    },
    temperature: DEFAULT_TEMPERATURE
  };
}
