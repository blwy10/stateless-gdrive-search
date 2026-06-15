// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Project rule — explicit env, no silent defaults (see the env-var policy in
// docs/configuration.md): config that picks model/provider behaviour is `required(...)`, never
// `process.env.X || "<default>"`. Genuinely-optional features (base URL, SSL,
// debug, rate-limit knobs) may return null/off when unset, since that is a true
// no-op and not a hidden behaviour-picking default.
export const env = {
  googleClientId: () => required("GOOGLE_CLIENT_ID"),
  googleClientSecret: () => required("GOOGLE_CLIENT_SECRET"),
  databaseUrl: () => required("DATABASE_URL"),
  tokenEncryptionKey: () => required("TOKEN_ENCRYPTION_KEY"),
  aiApiKey: () => required("AI_API_KEY"),
  // Required model family. One of "openai" (Responses API), "anthropic", or
  // "openai-compatible" (Fireworks/vLLM/custom). Coerced/validated downstream by
  // lib/model-settings.
  aiProvider: () => required("AI_PROVIDER"),
  // Optional. Native providers (openai, anthropic) use their official endpoint
  // when unset; openai-compatible requires it. Returns null when unset.
  aiBaseUrl: (): string | null => process.env.AI_BASE_URL || null,
  // Required model id for the main role.
  aiModel: () => required("AI_MODEL"),
  // Required reasoning effort for the main role: "none" (provider default) |
  // "minimal" | "low" | "medium" | "high". Validated downstream by
  // lib/model-settings (an unrecognized value throws at startup).
  aiReasoningEffort: () => required("AI_REASONING_EFFORT"),
  // Grader role: a separate, cheaper model used only to judge per-file relevance
  // (see gradeFileRelevance in lib/agent/examiner.ts). There is no fallback to the main
  // model — both roles must be configured. Endpoint is optional except for
  // openai-compatible.
  graderAiApiKey: () => required("GRADER_AI_API_KEY"),
  graderAiProvider: () => required("GRADER_AI_PROVIDER"),
  graderAiBaseUrl: (): string | null => process.env.GRADER_AI_BASE_URL || null,
  graderAiModel: () => required("GRADER_AI_MODEL"),
  // Required reasoning effort for the grader role (see aiReasoningEffort).
  graderAiReasoningEffort: () => required("GRADER_AI_REASONING_EFFORT"),
  // Summarizer role: a separate model used only to condense an oversize file
  // (one that would otherwise be hard-truncated at MAX_FILE_CHARS) into the
  // synthesis budget — see summarizeOversizeContent in lib/agent/summarizer.ts. Like the
  // grader there is no fallback to another role: all four behaviour vars are
  // required (maintainer decision — recorded in docs/configuration.md). Endpoint optional
  // except for openai-compatible.
  summarizerAiApiKey: () => required("SUMMARIZER_AI_API_KEY"),
  summarizerAiProvider: () => required("SUMMARIZER_AI_PROVIDER"),
  summarizerAiBaseUrl: (): string | null => process.env.SUMMARIZER_AI_BASE_URL || null,
  summarizerAiModel: () => required("SUMMARIZER_AI_MODEL"),
  // Required reasoning effort for the summarizer role (see aiReasoningEffort).
  summarizerAiReasoningEffort: () => required("SUMMARIZER_AI_REASONING_EFFORT"),
  // Ranker role: a separate model used only to re-order a curated list's kept
  // files by relevance in one terminal call — see rankKeptFiles in
  // lib/agent/ranker.ts. Like the grader/summarizer there is no fallback to
  // another role: all four behaviour vars are required. Endpoint optional except
  // for openai-compatible.
  rankerAiApiKey: () => required("RANKER_AI_API_KEY"),
  rankerAiProvider: () => required("RANKER_AI_PROVIDER"),
  rankerAiBaseUrl: (): string | null => process.env.RANKER_AI_BASE_URL || null,
  rankerAiModel: () => required("RANKER_AI_MODEL"),
  // Required reasoning effort for the ranker role (see aiReasoningEffort).
  rankerAiReasoningEffort: () => required("RANKER_AI_REASONING_EFFORT"),
  nextAuthUrl: () => required("NEXTAUTH_URL")
};
