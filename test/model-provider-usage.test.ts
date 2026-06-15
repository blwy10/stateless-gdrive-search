// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the config handed to the openai-compatible factory so we can assert the
// usage-streaming flag. vi.hoisted makes the spy exist before vi.mock is applied.
const { createOpenAICompatible } = vi.hoisted(() => ({
  createOpenAICompatible: vi.fn((_config: Record<string, unknown>) => ({
    chatModel: vi.fn((_modelId: string) => ({}))
  }))
}));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));

import { resolveModel } from "@/lib/model-provider";
import type { EffectiveModelSettings } from "@/lib/model-settings";

function settings(overrides: Partial<EffectiveModelSettings> = {}): EffectiveModelSettings {
  return {
    provider: "openai-compatible",
    apiKey: "test-key",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    model: "accounts/fireworks/models/deepseek-v4-pro",
    reasoningEffort: "none",
    source: "default",
    ...overrides
  };
}

describe("resolveModel — openai-compatible streams token usage", () => {
  beforeEach(() => {
    createOpenAICompatible.mockClear();
  });

  it("builds the provider with includeUsage so streamText reports usage (keeps the budget guards live)", () => {
    // Regression: the main loop uses streamText, and this provider only sends
    // OpenAI's stream_options.include_usage when includeUsage is set — without it
    // usage comes back null and the token budget guards go blind.
    resolveModel(settings());
    expect(createOpenAICompatible).toHaveBeenCalledTimes(1);
    expect(createOpenAICompatible.mock.calls[0]?.[0]).toMatchObject({ includeUsage: true });
  });

  it("still sets includeUsage when a reasoning effort is configured", () => {
    resolveModel(settings({ reasoningEffort: "low" }));
    expect(createOpenAICompatible.mock.calls[0]?.[0]).toMatchObject({ includeUsage: true });
  });
});
