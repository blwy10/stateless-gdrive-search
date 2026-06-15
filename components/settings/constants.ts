// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

export type ModelProvider = "openai" | "anthropic" | "openai-compatible";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

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

export type ModelRole = "main" | "grader" | "summarizer" | "ranker";

export const PROVIDER_OPTIONS: { value: ModelProvider; label: string; hint: string }[] = [
  {
    value: "openai",
    label: "OpenAI (Responses API)",
    hint: "Uses OpenAI's official endpoint. Endpoint URL optional."
  },
  {
    value: "anthropic",
    label: "Anthropic (Claude)",
    hint: "Uses Anthropic's official endpoint. Endpoint URL optional."
  },
  {
    value: "openai-compatible",
    label: "OpenAI-compatible (Fireworks, vLLM, …)",
    hint: "Any OpenAI-compatible endpoint. Endpoint URL required."
  }
];

export const PROVIDER_LABELS: Record<ModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI-compatible"
};

// "none" is the EXPLICIT "use the provider default" choice (no implicit unset).
// These match REASONING_EFFORTS in lib/model-settings.
export const REASONING_EFFORT_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: "none", label: "None (provider default)" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" }
];

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "None (provider default)",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High"
};

export const ROLE_META: Record<ModelRole, { title: string; help: string }> = {
  main: {
    title: "Main model",
    help: "Runs the research agent and writes the synthesis answer."
  },
  grader: {
    title: "Grader model",
    help: "A separate, cheaper model that only judges per-file relevance."
  },
  summarizer: {
    title: "Summarizer model",
    help: "A separate model that condenses an oversize file into the synthesis budget instead of hard-truncating it."
  },
  ranker: {
    title: "Ranker model",
    help: "A separate model that re-orders a curated list's kept files by relevance in one final pass."
  }
};
