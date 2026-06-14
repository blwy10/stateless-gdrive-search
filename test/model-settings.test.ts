// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  coerceReasoningEffort,
  resolveRoleSettings,
  type EffectiveModelSettings
} from "@/lib/model-settings";

const envDefault: EffectiveModelSettings = {
  provider: "openai",
  apiKey: "env-key",
  baseUrl: null,
  model: "env-model",
  reasoningEffort: "none",
  source: "default"
};

describe("resolveRoleSettings", () => {
  it("falls back to the env default when the role has no override", () => {
    expect(
      resolveRoleSettings(
        { apiKey: null, baseUrl: null, model: null, provider: null, reasoningEffort: null },
        envDefault
      )
    ).toBe(envDefault);
  });

  it("falls back when only one of model/apiKey is present (a partial row is not an override)", () => {
    expect(
      resolveRoleSettings(
        { apiKey: "k", baseUrl: null, model: null, provider: "openai", reasoningEffort: "high" },
        envDefault
      )
    ).toBe(envDefault);
    expect(
      resolveRoleSettings(
        { apiKey: null, baseUrl: null, model: "m", provider: "openai", reasoningEffort: "high" },
        envDefault
      )
    ).toBe(envDefault);
  });

  it("uses the custom override when both model and apiKey are present", () => {
    const result = resolveRoleSettings(
      {
        apiKey: "user-key",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        model: "user-model",
        provider: "openai-compatible",
        reasoningEffort: "low"
      },
      envDefault
    );
    expect(result).toEqual({
      provider: "openai-compatible",
      apiKey: "user-key",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      model: "user-model",
      reasoningEffort: "low",
      source: "custom"
    });
  });

  it("coerces an unknown/blank provider to openai on a custom override", () => {
    const result = resolveRoleSettings(
      { apiKey: "k", baseUrl: null, model: "m", provider: "totally-unknown", reasoningEffort: "none" },
      envDefault
    );
    expect(result.provider).toBe("openai");
    expect(result.source).toBe("custom");
  });

  it("normalizes the override's reasoning effort and falls back to none for an invalid one", () => {
    expect(
      resolveRoleSettings(
        { apiKey: "k", baseUrl: null, model: "m", provider: "openai", reasoningEffort: "MEDIUM " },
        envDefault
      ).reasoningEffort
    ).toBe("medium");
    // A custom row with a null/legacy or invalid effort resolves to the explicit
    // "none" (provider default), never null.
    expect(
      resolveRoleSettings(
        { apiKey: "k", baseUrl: null, model: "m", provider: "openai", reasoningEffort: "turbo" },
        envDefault
      ).reasoningEffort
    ).toBe("none");
    expect(
      resolveRoleSettings(
        { apiKey: "k", baseUrl: null, model: "m", provider: "openai", reasoningEffort: null },
        envDefault
      ).reasoningEffort
    ).toBe("none");
  });
});

describe("coerceReasoningEffort", () => {
  it("accepts the known levels, including the explicit none", () => {
    expect(coerceReasoningEffort("none")).toBe("none");
    expect(coerceReasoningEffort("minimal")).toBe("minimal");
    expect(coerceReasoningEffort("low")).toBe("low");
    expect(coerceReasoningEffort("medium")).toBe("medium");
    expect(coerceReasoningEffort("high")).toBe("high");
  });

  it("trims and lower-cases before matching", () => {
    expect(coerceReasoningEffort("  High ")).toBe("high");
    expect(coerceReasoningEffort("LOW")).toBe("low");
  });

  it("defaults to none for unset, blank, or unknown values", () => {
    expect(coerceReasoningEffort(null)).toBe("none");
    expect(coerceReasoningEffort(undefined)).toBe("none");
    expect(coerceReasoningEffort("")).toBe("none");
    expect(coerceReasoningEffort("   ")).toBe("none");
    expect(coerceReasoningEffort("turbo")).toBe("none");
    expect(coerceReasoningEffort("xhigh")).toBe("none");
  });
});
