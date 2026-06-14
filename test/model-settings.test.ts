// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { resolveRoleSettings, type EffectiveModelSettings } from "@/lib/model-settings";

const envDefault: EffectiveModelSettings = {
  provider: "openai",
  apiKey: "env-key",
  baseUrl: null,
  model: "env-model",
  source: "default"
};

describe("resolveRoleSettings", () => {
  it("falls back to the env default when the role has no override", () => {
    expect(
      resolveRoleSettings({ apiKey: null, baseUrl: null, model: null, provider: null }, envDefault)
    ).toBe(envDefault);
  });

  it("falls back when only one of model/apiKey is present (a partial row is not an override)", () => {
    expect(
      resolveRoleSettings({ apiKey: "k", baseUrl: null, model: null, provider: "openai" }, envDefault)
    ).toBe(envDefault);
    expect(
      resolveRoleSettings({ apiKey: null, baseUrl: null, model: "m", provider: "openai" }, envDefault)
    ).toBe(envDefault);
  });

  it("uses the custom override when both model and apiKey are present", () => {
    const result = resolveRoleSettings(
      {
        apiKey: "user-key",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        model: "user-model",
        provider: "openai-compatible"
      },
      envDefault
    );
    expect(result).toEqual({
      provider: "openai-compatible",
      apiKey: "user-key",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      model: "user-model",
      source: "custom"
    });
  });

  it("coerces an unknown/blank provider to openai on a custom override", () => {
    const result = resolveRoleSettings(
      { apiKey: "k", baseUrl: null, model: "m", provider: "totally-unknown" },
      envDefault
    );
    expect(result.provider).toBe("openai");
    expect(result.source).toBe("custom");
  });
});
