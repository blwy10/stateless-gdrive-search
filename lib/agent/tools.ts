// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { jsonSchema, tool, type ToolSet } from "ai";
import type { ToolCall, ToolResultMessage } from "./types";
import type { AgentRunContext, AgentRunState } from "./state";
import { handleSearchTool } from "./handlers/search";
import { handleOpenFileTool } from "./handlers/open";
import { handleReviewFileTool } from "./handlers/review";

/** Shared JSON schema for the connectionId/fileId pair open_file and review_file take. */
const ID_ARGS_SCHEMA = {
  type: "object",
  properties: {
    connectionId: { type: "string" },
    fileId: { type: "string" }
  },
  required: ["connectionId", "fileId"],
  additionalProperties: false
};

/**
 * Model-facing schema for a tool whose validation is deferred to its handler.
 * The model still sees the expected shape, but validation is a pass-through so
 * malformed/extra fields never raise an InvalidToolInputError (which would abort
 * the SDK's loop). The handler's own `parseToolArgs` does the strict zod check
 * and returns a recoverable observation on failure — preserving the "bad args ->
 * retry, never abort" behaviour across every provider, including non-strict ones.
 */
function looseToolSchema(schema: Record<string, unknown>) {
  return jsonSchema<Record<string, unknown>>(schema as Parameters<typeof jsonSchema>[0], {
    validate: (value) => ({ success: true, value: (value ?? {}) as Record<string, unknown> })
  });
}

/**
 * Adapt a tested tool handler (written against the OpenAI-style {@link ToolCall}
 * shape) into an AI SDK tool `execute`. The SDK passes already-parsed `input`,
 * which we re-serialize so the handler's strict zod validation still runs and
 * still turns bad arguments into a recoverable observation. The handler's
 * tool-result `content` (a JSON string) is parsed back into the value returned
 * to the model. Handlers never throw, so a single bad file/argument can never
 * abort the run.
 */
async function runToolHandler(
  handler: (
    context: AgentRunContext,
    state: AgentRunState,
    step: number,
    toolCall: ToolCall
  ) => Promise<ToolResultMessage>,
  context: AgentRunContext,
  state: AgentRunState,
  name: ToolCall["function"]["name"],
  toolCallId: string,
  input: unknown
): Promise<unknown> {
  const toolCall: ToolCall = {
    id: toolCallId,
    type: "function",
    function: { name, arguments: JSON.stringify(input ?? {}) }
  };
  const result = await handler(context, state, state.currentStep, toolCall);
  return JSON.parse(result.content);
}

/**
 * Build the AI SDK tool set for a run, closing over its context and state. Both
 * list modes (curated and uncurated) use `review_file`, which examines files in
 * isolation so content never enters this loop's context; synthesis uses
 * `open_file`, which reads content directly into context for synthesis. Each tool
 * defers to its tested handler via {@link runToolHandler}.
 */
export function buildAgentTools(context: AgentRunContext, state: AgentRunState): ToolSet {
  const searchDrive = tool({
    description:
      "Search the user's selected Google Drive connections for files relevant to a query.",
    inputSchema: looseToolSchema({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A concise Google Drive search query. Try alternate wording when needed."
        },
        limit: { type: "number", description: "Maximum results per connected Drive, up to 20." }
      },
      required: ["query"],
      additionalProperties: false
    }),
    execute: (input, { toolCallId }) =>
      runToolHandler(handleSearchTool, context, state, "search_drive", toolCallId, input)
  });

  if (context.input.mode === "list") {
    const reviewFile = tool({
      description:
        "Open a file from a search_drive result, read it in isolation, and report whether it is relevant to the query plus any notable names, projects, or terms worth searching for next. In curated mode relevant files are kept automatically and irrelevant ones dropped; in uncurated mode every match is returned regardless, so use this mainly to discover related search terms. Copy connectionId and fileId verbatim from a single search_drive result — never invent, guess, or modify an id, and never pair the connectionId of one file with the fileId of another. connectionId must be one of the selected Drive connection IDs.",
      inputSchema: looseToolSchema(ID_ARGS_SCHEMA),
      execute: (input, { toolCallId }) =>
        runToolHandler(handleReviewFileTool, context, state, "review_file", toolCallId, input)
    });
    return { search_drive: searchDrive, review_file: reviewFile };
  }

  const openFile = tool({
    description:
      "Open and read a file returned by search_drive. Copy connectionId and fileId verbatim from a single search_drive result — never invent, guess, or modify an id, and never pair the connectionId of one file with the fileId of another. connectionId must be one of the selected Drive connection IDs.",
    inputSchema: looseToolSchema(ID_ARGS_SCHEMA),
    execute: (input, { toolCallId }) =>
      runToolHandler(handleOpenFileTool, context, state, "open_file", toolCallId, input)
  });
  return { search_drive: searchDrive, open_file: openFile };
}
