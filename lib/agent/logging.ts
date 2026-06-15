// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import type { StepResult, ToolSet } from "ai";
import type { ModelProvider } from "@/lib/model-settings";
import { isDebugTranscriptLogEnabled, writeDebugLog } from "@/lib/debug-log";

/**
 * The subset of a role's resolved model settings used for debug-log attribution
 * (which model/provider produced a step, and whether it came from the operator
 * default or a user override). Shared by the main loop, the forced-synthesis
 * turn, and the isolated grader/summarizer callers.
 */
export type LogSettings = { model: string; provider: ModelProvider; source: "default" | "custom" };

/**
 * Wall-clock timing for one main-loop step, measured around the AI SDK callbacks
 * (the `StepResult` carries no duration). `durationMs` spans the whole step —
 * model generation PLUS the step's tool executions, since `onStepFinish` fires
 * after tools — so isolate model time by subtracting that step's per-tool
 * `durationMs` (already logged). `ttftMs` (time-to-first-token: step start to the
 * first streamed chunk) is the clean model-start latency, or `null` when nothing
 * streamed (e.g. the non-streaming forced-synthesis turn).
 */
export type StepTiming = { durationMs: number; ttftMs: number | null };

/**
 * Log one model step's outcome. The AI SDK drives the loop now, so instead of a
 * hand-rolled per-attempt logger this runs from `generateText`'s onStepFinish.
 * Reasoning is read from the SDK's unified `reasoningText` regardless of provider
 * (OpenAI summaries, Anthropic thinking, Fireworks reasoning_content all land
 * there); the full untruncated transcript (content + reasoning + tool calls +
 * raw response body) is emitted only under DEBUG_LOG_TRANSCRIPT. `caller`
 * separates the main agent (`agent.model.*`) from the curated grader, which logs
 * its own `agent.grade.*` events. `timing` adds step latency + time-to-first-token
 * (the isolated grader/summarizer/ranker time their single call directly instead).
 */
export async function logModelStep(
  requestId: string,
  settings: LogSettings,
  step: StepResult<ToolSet>,
  timing: StepTiming
) {
  const reasoning = step.reasoningText ?? null;
  await writeDebugLog({
    event: "agent.model.completed",
    requestId,
    step: step.stepNumber,
    durationMs: timing.durationMs,
    ttftMs: timing.ttftMs,
    model: settings.model,
    provider: settings.provider,
    modelSettingsSource: settings.source,
    finishReason: step.finishReason,
    toolCallCount: step.toolCalls.length,
    responseContentLength: step.text.length,
    reasoningContentLength: reasoning?.length ?? 0,
    // Raw usage breakdown (whatever the provider reported) so you can see per
    // provider what's actually available and tune the budget. `totalTokens`
    // already includes reasoning; `reasoningTokens` is a subset, logged for
    // visibility only — never summed on top (see resolveUsageTokens).
    inputTokens: step.usage?.inputTokens ?? null,
    outputTokens: step.usage?.outputTokens ?? null,
    totalTokens: step.usage?.totalTokens ?? null,
    reasoningTokens: step.usage?.reasoningTokens ?? null,
    warningCount: step.warnings?.length ?? 0
  });
  if (isDebugTranscriptLogEnabled()) {
    await writeDebugLog({
      event: "agent.model.transcript",
      requestId,
      step: step.stepNumber,
      model: settings.model,
      content: step.text || null,
      reasoningContent: reasoning,
      toolCalls: step.toolCalls.map((toolCall) => ({
        name: toolCall.toolName,
        arguments: JSON.stringify(toolCall.input ?? {})
      })),
      responseBody: step.response.body ?? null
    });
  }
}
