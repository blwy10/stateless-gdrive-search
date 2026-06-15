// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { z } from "zod";
import {
  MODEL_PROVIDERS,
  REASONING_EFFORTS,
  type ModelProvider,
  type ModelRole,
  type ReasoningEffort
} from "./constants";

export type RoleSettingsSummary = {
  hasCustomModel: boolean;
  apiKeyConfigured: boolean;
  provider: ModelProvider | null;
  baseUrl: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  updatedAt: string | null;
};

export type ModelSettingsSummary = {
  main: RoleSettingsSummary;
  grader: RoleSettingsSummary;
  summarizer: RoleSettingsSummary;
  ranker: RoleSettingsSummary;
};

export type EffectiveModelSettings = {
  provider: ModelProvider;
  apiKey: string;
  /**
   * Null for native providers (openai, anthropic) that use their official
   * endpoint; always set for openai-compatible.
   */
  baseUrl: string | null;
  model: string;
  /**
   * Reasoning effort for this role. Always set (never null) — `"none"` is the
   * explicit "provider default" value. Applied per-provider by
   * lib/model-provider's resolveModel.
   */
  reasoningEffort: ReasoningEffort;
  source: "default" | "custom";
};

/** Effective settings for all roles, resolved once per agent run. */
export type EffectiveModelSettingsBundle = {
  main: EffectiveModelSettings;
  grader: EffectiveModelSettings;
  summarizer: EffectiveModelSettings;
  ranker: EffectiveModelSettings;
};

const RoleSettingsInput = z
  .object({
    provider: z.enum(MODEL_PROVIDERS).optional().default("openai-compatible"),
    apiKey: z.string().trim().min(1).max(4096).optional(),
    baseUrl: z.string().trim().min(1).max(2048).optional(),
    model: z.string().trim().min(1).max(200),
    // The UI always sends one of REASONING_EFFORTS ("none" = provider default);
    // optional only so a partial API save can omit it (then stored as "none").
    reasoningEffort: z.enum(REASONING_EFFORTS).optional()
  })
  // Native providers use their official endpoint, but an OpenAI-compatible
  // endpoint has no default, so its URL is mandatory.
  .refine((value) => value.provider !== "openai-compatible" || Boolean(value.baseUrl), {
    message: "An endpoint URL is required for OpenAI-compatible providers",
    path: ["baseUrl"]
  });

export type RoleSettingsInput = z.infer<typeof RoleSettingsInput>;

// A save may target any role independently (or several); at least one must be
// present so an empty request is rejected rather than silently doing nothing.
const ModelSettingsInput = z
  .object({
    main: RoleSettingsInput.optional(),
    grader: RoleSettingsInput.optional(),
    summarizer: RoleSettingsInput.optional(),
    ranker: RoleSettingsInput.optional()
  })
  .refine((value) => Boolean(value.main || value.grader || value.summarizer || value.ranker), {
    message: "Provide settings for at least one role (main, grader, summarizer, or ranker)"
  });

export type ModelSettingsInput = z.infer<typeof ModelSettingsInput>;

export type ModelSettingsRow = {
  api_key_ciphertext: string | null;
  base_url: string | null;
  model: string | null;
  provider: string | null;
  reasoning_effort: string | null;
  grader_api_key_ciphertext: string | null;
  grader_base_url: string | null;
  grader_model: string | null;
  grader_provider: string | null;
  grader_reasoning_effort: string | null;
  summarizer_api_key_ciphertext: string | null;
  summarizer_base_url: string | null;
  summarizer_model: string | null;
  summarizer_provider: string | null;
  summarizer_reasoning_effort: string | null;
  ranker_api_key_ciphertext: string | null;
  ranker_base_url: string | null;
  ranker_model: string | null;
  ranker_provider: string | null;
  ranker_reasoning_effort: string | null;
  updated_at: Date;
};

/** Raw per-role columns pulled off a {@link ModelSettingsRow}. */
export type RoleColumns = {
  apiKeyCiphertext: string | null;
  baseUrl: string | null;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
};

export function parseModelSettingsInput(value: unknown) {
  return ModelSettingsInput.parse(value);
}

/** Map the `role` query param used by the per-role DELETE to a known target. */
export function parseModelRole(value: string | null | undefined): ModelRole | "all" {
  return value === "main" || value === "grader" || value === "summarizer" || value === "ranker"
    ? value
    : "all";
}
