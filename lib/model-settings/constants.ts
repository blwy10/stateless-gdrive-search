// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

export const MODEL_PROVIDERS = ["openai", "anthropic", "openai-compatible"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/**
 * The three independent model roles. `main` runs the agent loop and writes the
 * synthesis answer; `grader` is a separate, cheaper model that only judges
 * per-file relevance (see gradeFileRelevance in lib/agent.ts); `summarizer` is a
 * separate model that condenses an oversize file into the synthesis budget rather
 * than hard-truncating it (see summarizeOversizeContent in lib/agent.ts). Each
 * role is configured independently at the env level (all required — there is no
 * fallback between roles) and may be overridden per-user independently.
 */
export const MODEL_ROLES = ["main", "grader", "summarizer"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * Reasoning-effort levels accepted for either role. `"none"` is the EXPLICIT
 * "use the provider default" value — the option is omitted entirely (and for
 * Anthropic, extended thinking stays off). There is intentionally no implicit
 * "unset means default": the env vars are required (see "Environment variables"
 * in AGENTS.md), so an operator must choose `none` on purpose rather than relying
 * on a silent fallback. `minimal|low|medium|high` is the widely-supported active
 * set (covers OpenAI and Fireworks gpt-oss); provider-specific extras like
 * "xhigh" are deliberately not offered. Maps to OpenAI's `reasoningEffort` /
 * OpenAI-compatible `reasoning_effort` directly, and to an Anthropic thinking
 * budget by lib/model-provider.
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Coerce a stored/env provider string to a known {@link ModelProvider},
 * defaulting to "openai" for anything unset or unrecognized. DB rows carry a
 * NOT NULL default, so this mainly guards the operator-supplied AI_PROVIDER env.
 */
export function coerceModelProvider(value: string | null | undefined): ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value ?? "")
    ? (value as ModelProvider)
    : "openai";
}

/**
 * Coerce a stored reasoning-effort string to a known {@link ReasoningEffort},
 * defaulting to `"none"` (provider default) for anything unset, blank, or
 * unrecognized. Trims and lower-cases first so a legacy DB value still resolves.
 * This is the LENIENT path for STORED data (DB columns written by our own,
 * enum-constrained UI, plus legacy null rows) — a stray value degrades to the
 * provider default rather than breaking a run. The env vars take the strict path
 * instead ({@link requireReasoningEffortEnv}), failing loudly on a typo.
 */
export function coerceReasoningEffort(value: string | null | undefined): ReasoningEffort {
  const normalized = value?.trim().toLowerCase() ?? "";
  return (REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? (normalized as ReasoningEffort)
    : "none";
}

/**
 * Strictly parse a REQUIRED reasoning-effort env var: the value must already be
 * present (callers read it via `env`'s `required(...)`) and must be one of
 * {@link REASONING_EFFORTS}. An unrecognized value throws rather than silently
 * coercing — env config is explicit by design, so a typo should fail at startup,
 * not quietly run at the provider default. (`none` is a valid, explicit choice.)
 */
export function requireReasoningEffortEnv(rawValue: string, varName: string): ReasoningEffort {
  const normalized = rawValue.trim().toLowerCase();
  if (!(REASONING_EFFORTS as readonly string[]).includes(normalized)) {
    throw new Error(
      `Invalid ${varName}="${rawValue}". Must be one of: ${REASONING_EFFORTS.join(", ")}`
    );
  }
  return normalized as ReasoningEffort;
}
