// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { resolveModel } from "@/lib/model-provider";
import type { EffectiveModelSettings, ReasoningEffort } from "@/lib/model-settings";

const DEFAULT_TEMPERATURE = 0.2;

function settings(overrides: Partial<EffectiveModelSettings>): EffectiveModelSettings {
  return {
    provider: "openai",
    apiKey: "test-key",
    baseUrl: null,
    model: "test-model",
    reasoningEffort: "none",
    source: "default",
    ...overrides
  };
}

describe("resolveModel — openai (Responses API)", () => {
  it("keeps the stateless reasoning round-trip and omits effort on none", () => {
    const resolved = resolveModel(settings({ provider: "openai", reasoningEffort: "none" }));
    expect(resolved.providerOptions.openai).toEqual({
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoningSummary: "auto"
    });
    expect(resolved.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(resolved.maxOutputTokens).toBeUndefined();
  });

  it("forwards reasoningEffort as-is when set", () => {
    const resolved = resolveModel(settings({ provider: "openai", reasoningEffort: "high" }));
    expect(resolved.providerOptions.openai).toMatchObject({ reasoningEffort: "high" });
    // The stateless round-trip fields are still present.
    expect(resolved.providerOptions.openai).toMatchObject({ store: false });
  });
});

describe("resolveModel — openai-compatible", () => {
  it("omits provider options entirely when effort is none", () => {
    const resolved = resolveModel(
      settings({
        provider: "openai-compatible",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        reasoningEffort: "none"
      })
    );
    expect(resolved.providerOptions).toEqual({});
    expect(resolved.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(resolved.maxOutputTokens).toBeUndefined();
  });

  it("sets reasoningEffort under the name-independent openaiCompatible key", () => {
    const resolved = resolveModel(
      settings({
        provider: "openai-compatible",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        reasoningEffort: "low"
      })
    );
    expect(resolved.providerOptions).toEqual({ openaiCompatible: { reasoningEffort: "low" } });
  });

  it("requires an endpoint URL", () => {
    expect(() =>
      resolveModel(settings({ provider: "openai-compatible", baseUrl: null }))
    ).toThrow(/endpoint URL is required/i);
  });
});

describe("resolveModel — anthropic (effort → thinking budget)", () => {
  it("leaves thinking off and keeps the default temperature when effort is none", () => {
    const resolved = resolveModel(settings({ provider: "anthropic", reasoningEffort: "none" }));
    expect(resolved.providerOptions).toEqual({});
    expect(resolved.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(resolved.maxOutputTokens).toBeUndefined();
  });

  const cases: { effort: ReasoningEffort; budget: number }[] = [
    { effort: "minimal", budget: 1024 },
    { effort: "low", budget: 2048 },
    { effort: "medium", budget: 8192 },
    { effort: "high", budget: 16384 }
  ];

  for (const { effort, budget } of cases) {
    it(`maps "${effort}" to a ${budget}-token thinking budget, drops temperature, and bumps max tokens`, () => {
      const resolved = resolveModel(settings({ provider: "anthropic", reasoningEffort: effort }));
      expect(resolved.providerOptions).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: budget } }
      });
      // Extended thinking forces temperature to 1, so we omit our own.
      expect(resolved.temperature).toBeUndefined();
      // The API requires max_tokens > budget; we leave an 8192-token answer margin.
      expect(resolved.maxOutputTokens).toBe(budget + 8192);
    });
  }
});
