// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { debugError, hashForDebug, writeDebugLog } from "@/lib/debug-log";
import type { ToolCall, ToolResultMessage } from "./types";
import type { AgentRunContext } from "./state";

export function safeJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function isRetryableToolError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /\b(408|409|429|500|502|503|504)\b/.test(error.message);
}

export async function withToolRetries<T>(
  operation: () => Promise<T>,
  retryCount: number
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= retryCount || !isRetryableToolError(error)) break;
    }
  }
  throw lastError;
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * Build a tool-result observation for a tool call that failed to execute.
 * Returning this to the model (instead of throwing) keeps a single bad file or
 * transient Drive error from aborting the entire run: the model sees the
 * failure as an observation and can route around it — open a different file, or
 * synthesize from the evidence it already gathered. Mirrors the `skipped`
 * observations the handlers already return when a budget is exhausted.
 */
export function toolErrorObservation(toolCallId: string, message: string): ToolResultMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: safeJson({ error: true, message })
  };
}

/**
 * Parse a tool call's JSON arguments against its zod schema, converting any
 * failure — malformed JSON (`SyntaxError`) or a schema violation (`ZodError`,
 * e.g. a missing/empty field or out-of-range value) — into a recoverable
 * observation instead of throwing. A throw here would bubble out of the
 * tool-dispatch loop and abort the whole run over a single malformed call the
 * model could simply re-issue with corrected arguments.
 */
export async function parseToolArgs<T>(
  context: AgentRunContext,
  step: number,
  toolCall: ToolCall,
  schema: z.ZodType<T>
): Promise<{ ok: true; args: T } | { ok: false; observation: ToolResultMessage }> {
  try {
    return { ok: true, args: schema.parse(JSON.parse(toolCall.function.arguments || "{}")) };
  } catch (error) {
    await writeDebugLog({
      event: "agent.tool.invalid_args",
      level: "warn",
      requestId: context.requestId,
      step,
      tool: toolCall.function.name,
      toolCallIdHash: hashForDebug(toolCall.id),
      error: debugError(error)
    });
    return {
      ok: false,
      observation: toolErrorObservation(
        toolCall.id,
        `Invalid arguments for ${toolCall.function.name}: ${errorText(error)}. Reply with a JSON object containing the required fields and call the tool again.`
      )
    };
  }
}
