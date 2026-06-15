// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { env } from "@/lib/env";
import { coerceModelProvider, requireReasoningEffortEnv, type ModelRole } from "./constants";
import type { EffectiveModelSettings } from "./types";

export function envSettings(role: ModelRole): EffectiveModelSettings {
  if (role === "grader") {
    return {
      provider: coerceModelProvider(env.graderAiProvider()),
      apiKey: env.graderAiApiKey(),
      baseUrl: env.graderAiBaseUrl(),
      model: env.graderAiModel(),
      reasoningEffort: requireReasoningEffortEnv(
        env.graderAiReasoningEffort(),
        "GRADER_AI_REASONING_EFFORT"
      ),
      source: "default"
    };
  }
  if (role === "summarizer") {
    return {
      provider: coerceModelProvider(env.summarizerAiProvider()),
      apiKey: env.summarizerAiApiKey(),
      baseUrl: env.summarizerAiBaseUrl(),
      model: env.summarizerAiModel(),
      reasoningEffort: requireReasoningEffortEnv(
        env.summarizerAiReasoningEffort(),
        "SUMMARIZER_AI_REASONING_EFFORT"
      ),
      source: "default"
    };
  }
  if (role === "ranker") {
    return {
      provider: coerceModelProvider(env.rankerAiProvider()),
      apiKey: env.rankerAiApiKey(),
      baseUrl: env.rankerAiBaseUrl(),
      model: env.rankerAiModel(),
      reasoningEffort: requireReasoningEffortEnv(
        env.rankerAiReasoningEffort(),
        "RANKER_AI_REASONING_EFFORT"
      ),
      source: "default"
    };
  }
  return {
    provider: coerceModelProvider(env.aiProvider()),
    apiKey: env.aiApiKey(),
    baseUrl: env.aiBaseUrl(),
    model: env.aiModel(),
    reasoningEffort: requireReasoningEffortEnv(env.aiReasoningEffort(), "AI_REASONING_EFFORT"),
    source: "default"
  };
}
