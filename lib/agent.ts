// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import { listDriveConnections } from "@/lib/drive-connections";
import { openDriveFile, searchDriveFiles, type DriveFile } from "@/lib/drive";
import { formatMimeType } from "@/lib/file-types";
import { getEffectiveModelSettings, type EffectiveModelSettings } from "@/lib/model-settings";
import { ssrfSafeDispatcher } from "@/lib/ssrf";
import {
  createDebugRequestId,
  debugError,
  debugText,
  hashForDebug,
  writeDebugLog
} from "@/lib/debug-log";

/**
 * Per-request timeout for the outbound model call. Without it, a hung upstream
 * endpoint would stall the request indefinitely and hold the agent's SSE stream
 * and server resources open. Applied via {@link AbortSignal.timeout}, so it
 * bounds connect + response-body read for each individual attempt.
 */
const MODEL_REQUEST_TIMEOUT_MS = 60_000;

const AgentRequest = z.object({
  query: z.string().trim().min(1).max(2000),
  mode: z.enum(["list", "synthesis"]),
  driveIds: z.array(z.string().min(1)).min(1).max(20),
  curateList: z.boolean().optional().default(false)
});

type AgentRequest = z.infer<typeof AgentRequest>;

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: "search_drive" | "open_file" | "keep_file";
    arguments: string;
  };
};

type ToolDefinition = {
  type: "function";
  function: {
    name: ToolCall["function"]["name"];
    description: string;
    parameters: Record<string, unknown>;
  };
};

type ChatCompletion = {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
};

/**
 * Per-run limits that bound how much work the agent may do before it must stop
 * and return a (possibly partial) answer. Defaults live in
 * {@link defaultAgentBudgets} and can be overridden via {@link resolveAgentBudget}.
 */
export type AgentBudget = {
  /**
   * Maximum number of model tool-use iterations (assistant turns that may issue
   * tool calls). Once this many steps elapse without the agent finishing, tools
   * are disabled and the model is given one final turn to return a result that
   * respects the mode (e.g. synthesis still synthesizes rather than returning
   * only the raw list of files read).
   */
  maxToolSteps: number;
  /**
   * Maximum total number of `search_drive` calls allowed across the run. Also
   * communicated to the model in the system prompt; further searches are
   * skipped once the limit is hit.
   */
  maxSearchCalls: number;
  /**
   * Maximum total number of `open_file` calls allowed across the run. Also
   * communicated to the model in the system prompt; further opens are skipped
   * once the limit is hit.
   */
  maxOpenFileCalls: number;
  /**
   * Maximum number of *consecutive* low-progress searches (a repeated query, or
   * one that returns no new files) tolerated before the agent is instructed to
   * stop searching. The counter resets to zero whenever a search surfaces new
   * files.
   */
  maxLowProgressSearches: number;
  /**
   * Number of *additional* retry attempts for a failed tool call, on top of the
   * initial attempt (e.g. `1` means up to two attempts total). Only retryable
   * errors (HTTP 408/409/429/5xx) are retried.
   */
  maxToolRetries: number;
};

export type AgentOptions = {
  budget?: Partial<AgentBudget>;
};

export type AgentProgress =
  | { type: "progress"; message: string }
  | { type: "file"; file: DriveFile }
  // Curated list mode only: a file the agent opened and is evaluating for
  // relevance. It is provisional and may never be kept.
  | { type: "reviewing"; file: DriveFile }
  // Curated list mode only: a file the agent explicitly kept as relevant via
  // keep_file. The set of kept files is the authoritative curated result.
  | { type: "kept"; file: DriveFile }
  | { type: "final"; answer: string; answerFormat: "markdown" | "plain"; files: DriveFile[] }
  | { type: "error"; message: string };

const searchArgs = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).optional()
});

const openArgs = z.object({
  connectionId: z.string().min(1),
  fileId: z.string().min(1)
});

const keepArgs = z.object({
  connectionId: z.string().min(1),
  fileId: z.string().min(1)
});

const searchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "search_drive",
    description:
      "Search the user's selected Google Drive connections for files relevant to a query.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A concise Google Drive search query. Try alternate wording when needed."
        },
        limit: {
          type: "number",
          description: "Maximum results per connected Drive, up to 20."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  }
};

const openFileTool: ToolDefinition = {
  type: "function",
  function: {
    name: "open_file",
    description:
      "Open and read a file returned by search_drive. Use the exact connectionId and fileId from search results.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        fileId: { type: "string" }
      },
      required: ["connectionId", "fileId"],
      additionalProperties: false
    }
  }
};

// Curated list mode only. Lets the model commit a relevance decision per file
// the moment it has read it, instead of emitting one list at the very end. The
// set of kept files is the authoritative curated result, so the UI can promote
// files from "reviewing" to "kept" live as the agent works.
const keepFileTool: ToolDefinition = {
  type: "function",
  function: {
    name: "keep_file",
    description:
      "Mark an already-opened file as relevant so it is included in the curated results. Call this immediately after reading a file whose content is relevant to the query. Only files you have opened can be kept.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        fileId: { type: "string" }
      },
      required: ["connectionId", "fileId"],
      additionalProperties: false
    }
  }
};

const baseTools: ToolDefinition[] = [searchTool, openFileTool];

function isCuratingRequest(input: AgentRequest) {
  return input.mode === "list" && input.curateList;
}

/**
 * Tools offered to the model for a given request. `keep_file` is only useful
 * (and only enabled) when curating a file list; offering it elsewhere would
 * just tempt the model into calls that have no effect.
 */
function toolsForRequest(input: AgentRequest): ToolDefinition[] {
  return isCuratingRequest(input) ? [...baseTools, keepFileTool] : baseTools;
}

export const defaultAgentBudgets: Record<AgentRequest["mode"], AgentBudget> = {
  list: {
    maxToolSteps: 20,
    maxSearchCalls: 10,
    maxOpenFileCalls: 15,
    maxLowProgressSearches: 2,
    maxToolRetries: 1
  },
  synthesis: {
    maxToolSteps: 20,
    maxSearchCalls: 10,
    maxOpenFileCalls: 20,
    maxLowProgressSearches: 2,
    maxToolRetries: 1
  }
};

export function resolveAgentBudget(
  mode: AgentRequest["mode"],
  override?: Partial<AgentBudget>
): AgentBudget {
  return {
    ...defaultAgentBudgets[mode],
    ...override
  };
}

function basePrompt(allowedDriveIds: string[], budget: AgentBudget, curating = false) {
  const toolList = curating
    ? "You have exactly three tools: search_drive, open_file, and keep_file."
    : "You have exactly two tools: search_drive and open_file.";
  return `You are a Google Drive research agent.

${toolList}
You may only work with these selected Drive connection IDs: ${allowedDriveIds.join(", ")}.
Use at most ${budget.maxSearchCalls} search_drive calls.
Use at most ${budget.maxOpenFileCalls} open_file calls.
Search using targeted query variants before deciding there is not enough evidence.
Do not repeat equivalent searches.
If searches stop producing new relevant files, answer with the evidence found.
Never claim you searched outside Google Drive.
Never ask for permissions or tokens.
If evidence is weak, say that directly.`;
}

function synthesisSystemPrompt(allowedDriveIds: string[], budget: AgentBudget) {
  return `${basePrompt(allowedDriveIds, budget)}

Open files when their titles or snippets appear relevant.
Return a concise synthesis answering the user's query, followed by the source files you relied on.
Your final response must start with exactly one format line:
FORMAT: markdown
or
FORMAT: plain
Then put the answer body after that line.
Use markdown only when headings, lists, links, or other markdown structure materially improve readability.
Never return HTML or any format other than markdown or plain.`;
}

function listSystemPrompt(
  allowedDriveIds: string[],
  budget: AgentBudget,
  curateList: boolean
) {
  if (curateList) {
    return `${basePrompt(allowedDriveIds, budget, true)}

Find relevant files only. Do not synthesize an answer.
Open files that may be relevant. The moment you read a file whose content is relevant to the query, call keep_file with its connectionId and fileId.
Only keep files you have actually opened and judged relevant; never keep a file you have not opened.
The files you keep are the entire curated result. A file you never keep will not be returned, so be sure to keep every relevant file as you go.
When you have opened the promising files and kept the relevant ones, stop calling tools and reply with exactly:
FORMAT: plain
DONE`;
  }

  return `${basePrompt(allowedDriveIds, budget)}

Find relevant files only. Do not synthesize an answer.
Open files when their titles or snippets appear relevant and opening is needed to judge relevance.
When you are done, return exactly:
FORMAT: plain
FILE_LIST_COMPLETE`;
}

function systemPrompt(input: AgentRequest, allowedDriveIds: string[], budget: AgentBudget) {
  return input.mode === "synthesis"
    ? synthesisSystemPrompt(allowedDriveIds, budget)
    : listSystemPrompt(allowedDriveIds, budget, input.curateList);
}

function safeJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

async function callModel(
  settings: EffectiveModelSettings,
  messages: ChatMessage[],
  requestId: string,
  step: number,
  offeredTools: ToolDefinition[] | null = null
) {
  const startedAt = Date.now();
  const toolsEnabled = Boolean(offeredTools?.length);

  await writeDebugLog({
    event: "agent.model.request",
    requestId,
    step,
    model: settings.model,
    modelSettingsSource: settings.source,
    messageCount: messages.length,
    toolsEnabled
  });

  try {
    const response = await undiciFetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        "content-type": "application/json"
      },
      // The base URL is validated as a public HTTPS host (see
      // validatePublicHttpsBaseUrl), but a validated host can still answer with a
      // redirect to an internal/metadata address (e.g. 169.254.169.254). Refuse to
      // follow redirects, and for user-supplied endpoints validate the resolved IP
      // at connect time (ssrfSafeDispatcher) to also close the DNS-rebinding window.
      redirect: "error",
      signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
      ...(settings.source === "custom" ? { dispatcher: ssrfSafeDispatcher } : {}),
      body: JSON.stringify({
        model: settings.model,
        messages,
        ...(toolsEnabled ? { tools: offeredTools, tool_choice: "auto" } : {}),
        temperature: 0.2
      })
    });
    if (!response.ok) {
      const responseBody = await response.text();
      await writeDebugLog({
        event: "agent.model.failed",
        level: "error",
        requestId,
        step,
        model: settings.model,
        modelSettingsSource: settings.source,
        status: response.status,
        durationMs: Date.now() - startedAt,
        response: debugText(responseBody)
      });
      throw new Error(`AI request failed with status ${response.status}`);
    }

    const completion = (await response.json()) as ChatCompletion;
    const message = completion.choices[0]?.message;
    await writeDebugLog({
      event: "agent.model.completed",
      requestId,
      step,
      model: settings.model,
      modelSettingsSource: settings.source,
      durationMs: Date.now() - startedAt,
      toolCallCount: message?.tool_calls?.length ?? 0,
      responseContentLength: message?.content?.length ?? 0
    });
    return completion;
  } catch (error) {
    await writeDebugLog({
      event: "agent.model.error",
      level: "error",
      requestId,
      step,
      model: settings.model,
      modelSettingsSource: settings.source,
      durationMs: Date.now() - startedAt,
      error: debugError(error)
    });
    throw error;
  }
}

function uniqueFiles(files: DriveFile[]) {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = fileKey(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fileKey(file: Pick<DriveFile, "connectionId" | "id">) {
  return `${file.connectionId}:${file.id}`;
}

function formatFileProgressLabel(file: DriveFile) {
  return `${formatMimeType(file.mimeType)} "${file.name}"`;
}

function normalizeSearchQuery(query: string) {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function partialAnswer(reason: string, mode: AgentRequest["mode"]) {
  if (mode === "list") {
    return { answer: "", answerFormat: "plain" as const };
  }

  return {
    answerFormat: "plain" as const,
    answer: `${reason} Returning the files found so far.`
  };
}

export function parseFinalAnswer(content: string | null, mode: AgentRequest["mode"]) {
  if (mode === "list") {
    return { answer: "", answerFormat: "plain" as const };
  }

  const raw = content?.trim() || "No answer returned.";
  const match = raw.match(/^FORMAT:\s*(markdown|plain)\s*\n([\s\S]*)$/i);
  if (match) {
    return {
      answerFormat: match[1].toLowerCase() === "markdown" ? ("markdown" as const) : ("plain" as const),
      answer: match[2].trim()
    };
  }

  const likelyMarkdown = /(^|\n)\s*(#{1,6}\s+|[-*]\s+|\d+\.\s+|```|\[[^\]]+\]\([^)]+\))/.test(raw);
  return {
    answerFormat: likelyMarkdown ? ("markdown" as const) : ("plain" as const),
    answer: raw
  };
}

/**
 * Resolve the curated file list for list mode. Normally this is the set of files
 * the model explicitly kept via keep_file. As a safety net, if the model opened
 * files but kept none — usually because it ignored keep_file rather than judging
 * everything irrelevant — fall back to the reviewed (opened) files so the run
 * still returns something useful instead of an empty list. The `fallback` flag
 * reports whether that substitution happened (for logging / progress).
 */
export function curatedResultFiles(keptFiles: DriveFile[], openedFiles: DriveFile[]) {
  if (keptFiles.length > 0) {
    return { files: uniqueFiles(keptFiles), fallback: false };
  }
  const reviewed = uniqueFiles(openedFiles);
  return { files: reviewed, fallback: reviewed.length > 0 };
}

function isRetryableToolError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /\b(408|409|429|500|502|503|504)\b/.test(error.message);
}

async function withToolRetries<T>(
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

/**
 * Tool result appended to the chat transcript after a tool call. Each tool
 * handler returns exactly one of these so the main loop can stay a thin
 * dispatcher.
 */
type ToolResultMessage = Extract<ChatMessage, { role: "tool" }>;

function errorText(error: unknown) {
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
function toolErrorObservation(toolCallId: string, message: string): ToolResultMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: safeJson({ error: true, message })
  };
}

/**
 * Immutable per-run context shared by the tool handlers: everything that is
 * fixed for the lifetime of a single {@link runDriveAgent} call.
 */
export type AgentRunContext = {
  ownerSub: string;
  input: AgentRequest;
  budget: AgentBudget;
  selectedDriveIds: string[];
  requestId: string;
  emit: (event: AgentProgress) => void | Promise<void>;
};

/**
 * Mutable per-run state threaded through the tool handlers. Handlers update
 * these counters/collections in place; the main loop reads them to make
 * budget/stop decisions and to assemble the final result.
 */
export type AgentRunState = {
  referencedFiles: DriveFile[];
  openedFiles: DriveFile[];
  /**
   * Curated list mode only: files the model kept via `keep_file`. This is the
   * authoritative curated result, populated live as the run progresses.
   */
  keptFiles: DriveFile[];
  searchedQueries: Set<string>;
  knownFileKeys: Set<string>;
  openedFileKeys: Set<string>;
  keptFileKeys: Set<string>;
  searchCallCount: number;
  openFileCallCount: number;
  lowProgressSearchCount: number;
  stopAfterToolUseReason: string | null;
};

/**
 * Handle a single `search_drive` tool call: enforce the search budget, run the
 * search, update progress/low-progress tracking, and emit any newly seen files.
 * Mutates {@link state} in place and returns the tool message to append.
 */
export async function handleSearchTool(
  context: AgentRunContext,
  state: AgentRunState,
  step: number,
  toolCall: ToolCall
): Promise<ToolResultMessage> {
  const { requestId, budget, selectedDriveIds, ownerSub, input, emit } = context;
  const args = searchArgs.parse(JSON.parse(toolCall.function.arguments || "{}"));
  const normalizedQuery = normalizeSearchQuery(args.query);
  await writeDebugLog({
    event: "agent.tool.search_drive.requested",
    requestId,
    step,
    toolCallIdHash: hashForDebug(toolCall.id),
    query: debugText(args.query),
    limit: args.limit ?? null,
    searchCallCount: state.searchCallCount
  });
  if (state.searchCallCount >= budget.maxSearchCalls) {
    const reason = `Search budget reached after ${state.searchCallCount} search_drive call(s).`;
    await emit({ type: "progress", message: reason });
    await writeDebugLog({
      event: "agent.tool.search_drive.skipped",
      level: "warn",
      requestId,
      step,
      reason: "search_budget_reached",
      searchCallCount: state.searchCallCount
    });
    state.stopAfterToolUseReason = reason;
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: safeJson({ skipped: true, reason })
    };
  }

  await emit({ type: "progress", message: `Searching Drive for "${args.query}"` });
  state.searchCallCount += 1;
  const wasRepeatedQuery = state.searchedQueries.has(normalizedQuery);
  state.searchedQueries.add(normalizedQuery);
  const toolStartedAt = Date.now();
  let files: DriveFile[];
  try {
    files = await withToolRetries(
      () =>
        searchDriveFiles({
          ownerSub,
          connectionIds: selectedDriveIds,
          query: args.query,
          limit: args.limit,
          debugRequestId: requestId
        }),
      budget.maxToolRetries
    );
  } catch (error) {
    await writeDebugLog({
      event: "agent.tool.search_drive.failed",
      level: "error",
      requestId,
      step,
      durationMs: Date.now() - toolStartedAt,
      searchCallCount: state.searchCallCount,
      error: debugError(error)
    });
    return toolErrorObservation(
      toolCall.id,
      `Search failed: ${errorText(error)}. Try a different query or use the files already found.`
    );
  }
  const newFiles = files.filter((file) => !state.knownFileKeys.has(fileKey(file)));
  await writeDebugLog({
    event: "agent.tool.search_drive.completed",
    requestId,
    step,
    durationMs: Date.now() - toolStartedAt,
    repeatedQuery: wasRepeatedQuery,
    resultCount: files.length,
    newResultCount: newFiles.length,
    searchCallCount: state.searchCallCount
  });
  for (const file of files) {
    state.knownFileKeys.add(fileKey(file));
  }
  if (wasRepeatedQuery || newFiles.length === 0) {
    state.lowProgressSearchCount += 1;
  } else {
    state.lowProgressSearchCount = 0;
  }
  if (state.lowProgressSearchCount >= budget.maxLowProgressSearches) {
    state.stopAfterToolUseReason = `Searches stopped producing new files after ${state.lowProgressSearchCount} low-progress search(es).`;
    await writeDebugLog({
      event: "agent.low_progress_search_limit_reached",
      level: "warn",
      requestId,
      step,
      lowProgressSearchCount: state.lowProgressSearchCount
    });
  }
  if (!input.curateList) {
    state.referencedFiles.push(...files);
    for (const file of files) {
      await emit({ type: "file", file });
    }
  }
  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content: safeJson({ files })
  };
}

/**
 * Handle a single `open_file` tool call: enforce drive scope, dedupe already
 * opened files, enforce the open-file budget, read the file, and emit progress.
 * Mutates {@link state} in place and returns the tool message to append.
 */
export async function handleOpenFileTool(
  context: AgentRunContext,
  state: AgentRunState,
  step: number,
  toolCall: ToolCall
): Promise<ToolResultMessage> {
  const { requestId, budget, selectedDriveIds, ownerSub, input, emit } = context;
  const curating = isCuratingRequest(input);
  const args = openArgs.parse(JSON.parse(toolCall.function.arguments || "{}"));
  await writeDebugLog({
    event: "agent.tool.open_file.requested",
    requestId,
    step,
    toolCallIdHash: hashForDebug(toolCall.id),
    connectionIdHash: hashForDebug(args.connectionId),
    fileIdHash: hashForDebug(args.fileId),
    openFileCallCount: state.openFileCallCount
  });
  if (!selectedDriveIds.includes(args.connectionId)) {
    await writeDebugLog({
      event: "agent.tool.open_file.rejected",
      level: "error",
      requestId,
      step,
      reason: "outside_selected_drive_scope",
      connectionIdHash: hashForDebug(args.connectionId),
      fileIdHash: hashForDebug(args.fileId)
    });
    throw new Error("AI attempted to open a file outside the selected Drive scope");
  }
  const key = `${args.connectionId}:${args.fileId}`;
  if (state.openedFileKeys.has(key)) {
    const reason = "File was already opened earlier in this run.";
    await writeDebugLog({
      event: "agent.tool.open_file.skipped",
      requestId,
      step,
      reason: "already_opened",
      fileKeyHash: hashForDebug(key)
    });
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: safeJson({ skipped: true, reason })
    };
  }
  if (state.openFileCallCount >= budget.maxOpenFileCalls) {
    const reason = `Open-file budget reached after ${state.openFileCallCount} open_file call(s).`;
    await emit({ type: "progress", message: reason });
    await writeDebugLog({
      event: "agent.tool.open_file.skipped",
      level: "warn",
      requestId,
      step,
      reason: "open_file_budget_reached",
      openFileCallCount: state.openFileCallCount
    });
    state.stopAfterToolUseReason = reason;
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: safeJson({ skipped: true, reason })
    };
  }

  state.openFileCallCount += 1;
  state.openedFileKeys.add(key);
  const toolStartedAt = Date.now();
  let opened: { file: DriveFile; content: string };
  try {
    opened = await withToolRetries(
      () =>
        openDriveFile({
          ownerSub,
          connectionId: args.connectionId,
          fileId: args.fileId,
          debugRequestId: requestId
        }),
      budget.maxToolRetries
    );
  } catch (error) {
    await writeDebugLog({
      event: "agent.tool.open_file.failed",
      level: "error",
      requestId,
      step,
      durationMs: Date.now() - toolStartedAt,
      fileKeyHash: hashForDebug(key),
      openFileCallCount: state.openFileCallCount,
      error: debugError(error)
    });
    return toolErrorObservation(
      toolCall.id,
      `Could not open this file: ${errorText(error)}. It may be inaccessible; continue with the other files.`
    );
  }
  await writeDebugLog({
    event: "agent.tool.open_file.completed",
    requestId,
    step,
    durationMs: Date.now() - toolStartedAt,
    fileKeyHash: hashForDebug(fileKey(opened.file)),
    mimeType: opened.file.mimeType,
    contentLength: opened.content.length,
    openFileCallCount: state.openFileCallCount
  });
  state.knownFileKeys.add(fileKey(opened.file));
  state.openedFiles.push(opened.file);
  // When curating, an opened file is only a candidate: it becomes a result only
  // if the model later keeps it. The authoritative list is state.keptFiles, so
  // we surface the open as a provisional "reviewing" event and leave it out of
  // referencedFiles. Otherwise an open is itself a result the UI should show.
  if (curating) {
    await emit({ type: "progress", message: `Reviewing ${formatFileProgressLabel(opened.file)}` });
    await emit({ type: "reviewing", file: opened.file });
  } else {
    state.referencedFiles.push(opened.file);
    await emit({ type: "progress", message: `Opened ${formatFileProgressLabel(opened.file)}` });
    await emit({ type: "file", file: opened.file });
  }
  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content: safeJson({
      file: opened.file,
      content: opened.content
    })
  };
}

/**
 * Handle a single `keep_file` tool call (curated list mode only): record the
 * model's decision to keep an already-opened file as relevant. This is the
 * authoritative curation signal — the kept set becomes the final result — so it
 * runs live, emitting a `kept` event the UI uses to promote the file out of the
 * provisional "reviewing" state. Keeping a file that was never opened is
 * rejected as a tool-result observation (not thrown) so the model can recover.
 */
export async function handleKeepFileTool(
  context: AgentRunContext,
  state: AgentRunState,
  step: number,
  toolCall: ToolCall
): Promise<ToolResultMessage> {
  const { requestId, emit } = context;
  const args = keepArgs.parse(JSON.parse(toolCall.function.arguments || "{}"));
  const key = `${args.connectionId}:${args.fileId}`;
  await writeDebugLog({
    event: "agent.tool.keep_file.requested",
    requestId,
    step,
    toolCallIdHash: hashForDebug(toolCall.id),
    fileKeyHash: hashForDebug(key),
    keptFileCount: state.keptFiles.length
  });

  const opened = state.openedFiles.find((candidate) => fileKey(candidate) === key);
  if (!opened) {
    await writeDebugLog({
      event: "agent.tool.keep_file.rejected",
      level: "warn",
      requestId,
      step,
      reason: "not_opened",
      fileKeyHash: hashForDebug(key)
    });
    return toolErrorObservation(
      toolCall.id,
      "Open this file with open_file before keeping it. Only files you have opened can be kept."
    );
  }

  if (state.keptFileKeys.has(key)) {
    await writeDebugLog({
      event: "agent.tool.keep_file.skipped",
      requestId,
      step,
      reason: "already_kept",
      fileKeyHash: hashForDebug(key)
    });
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: safeJson({ kept: true, alreadyKept: true })
    };
  }

  state.keptFileKeys.add(key);
  state.keptFiles.push(opened);
  await writeDebugLog({
    event: "agent.tool.keep_file.completed",
    requestId,
    step,
    fileKeyHash: hashForDebug(key),
    keptFileCount: state.keptFiles.length
  });
  await emit({ type: "progress", message: `Kept ${formatFileProgressLabel(opened)}` });
  await emit({ type: "kept", file: opened });
  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content: safeJson({ kept: true })
  };
}

export function parseAgentRequest(value: unknown) {
  return AgentRequest.parse(value);
}

export async function runDriveAgent(
  ownerSub: string,
  input: AgentRequest,
  emit: (event: AgentProgress) => void | Promise<void>,
  options: AgentOptions = {}
) {
  const requestId = createDebugRequestId("agent");
  const startedAt = Date.now();
  const budget = resolveAgentBudget(input.mode, options.budget);
  const modelSettings = await getEffectiveModelSettings(ownerSub);
  await writeDebugLog({
    event: "agent.started",
    requestId,
    mode: input.mode,
    curateList: input.curateList,
    query: debugText(input.query),
    requestedDriveCount: input.driveIds.length,
    ownerSubHash: hashForDebug(ownerSub),
    modelSettingsSource: modelSettings.source,
    model: modelSettings.model,
    budget
  });

  const connections = await listDriveConnections(ownerSub);
  const allowed = new Set(connections.map((connection) => connection.id));
  const selectedDriveIds = input.driveIds.includes("all")
    ? connections.map((connection) => connection.id)
    : input.driveIds.filter((id) => allowed.has(id));

  await writeDebugLog({
    event: "agent.connections.selected",
    requestId,
    availableConnectionCount: connections.length,
    selectedConnectionCount: selectedDriveIds.length,
    selectedConnectionIdHashes: selectedDriveIds.map(hashForDebug)
  });

  if (selectedDriveIds.length === 0) {
    await writeDebugLog({
      event: "agent.failed",
      level: "warn",
      requestId,
      reason: "no_connected_drive_selected",
      durationMs: Date.now() - startedAt
    });
    throw new Error("No connected Drive selected");
  }

  const context: AgentRunContext = {
    ownerSub,
    input,
    budget,
    selectedDriveIds,
    requestId,
    emit
  };
  const state: AgentRunState = {
    referencedFiles: [],
    openedFiles: [],
    keptFiles: [],
    searchedQueries: new Set<string>(),
    knownFileKeys: new Set<string>(),
    openedFileKeys: new Set<string>(),
    keptFileKeys: new Set<string>(),
    searchCallCount: 0,
    openFileCallCount: 0,
    lowProgressSearchCount: 0,
    stopAfterToolUseReason: null
  };
  const curating = isCuratingRequest(input);
  // In curated mode the curated result is the set of kept files, built up live
  // via keep_file rather than parsed from a final message. See curatedResultFiles
  // for the empty-keep fallback.
  const curatedResult = () => curatedResultFiles(state.keptFiles, state.openedFiles);
  const activeTools = toolsForRequest(input);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(input, selectedDriveIds, budget) },
    {
      role: "user",
      content: `Query: ${input.query}\nMode: ${input.mode}\nCurate list: ${input.curateList}`
    }
  ];
  let stopInstructionSent = false;

  await emit({
    type: "progress",
    message: `Agent started with ${selectedDriveIds.length} Drive connection(s).`
  });

  for (let step = 0; step < budget.maxToolSteps; step += 1) {
    if (state.stopAfterToolUseReason && !stopInstructionSent) {
      messages.push({
        role: "user",
        content: curating
          ? `${state.stopAfterToolUseReason} Stop searching and opening files. Keep any remaining relevant opened files with keep_file, then reply to finish.`
          : `${state.stopAfterToolUseReason} Stop using tools and return the final result now.`
      });
      stopInstructionSent = true;
    }

    // Once a budget has forced a stop, drop the search/open tools so the model
    // must wind down instead of issuing calls that would only be skipped. In
    // curated mode keep_file is free and is the curation signal itself, so we
    // keep offering it until the model finishes — otherwise a file opened right
    // before the stop could never be kept.
    const offeredTools = stopInstructionSent
      ? curating
        ? [keepFileTool]
        : null
      : activeTools;
    const completion = await callModel(modelSettings, messages, requestId, step, offeredTools);
    const message = completion.choices[0]?.message;
    if (!message) {
      await writeDebugLog({
        event: "agent.failed",
        level: "error",
        requestId,
        reason: "model_returned_no_message",
        step,
        durationMs: Date.now() - startedAt
      });
      throw new Error("AI returned no message");
    }

    messages.push({
      role: "assistant",
      content: message.content,
      tool_calls: message.tool_calls
    });

    if (!message.tool_calls?.length) {
      const { answer, answerFormat } = parseFinalAnswer(message.content, input.mode);
      const curated = curating ? curatedResult() : null;
      const files = curated ? curated.files : uniqueFiles(state.referencedFiles);
      if (curated?.fallback) {
        await emit({
          type: "progress",
          message: "No files were explicitly kept; returning all reviewed files."
        });
      }
      await writeDebugLog({
        event: "agent.completed",
        requestId,
        reason: "final_message",
        durationMs: Date.now() - startedAt,
        step,
        searchCallCount: state.searchCallCount,
        openFileCallCount: state.openFileCallCount,
        referencedFileCount: state.referencedFiles.length,
        keptFileCount: state.keptFiles.length,
        curatedFallback: curated?.fallback ?? false,
        returnedFileCount: files.length,
        answerFormat,
        answerLength: answer.length
      });
      await emit({ type: "final", answer, answerFormat, files });
      return;
    }

    for (const toolCall of message.tool_calls) {
      if (toolCall.function.name === "search_drive") {
        messages.push(await handleSearchTool(context, state, step, toolCall));
      } else if (toolCall.function.name === "open_file") {
        messages.push(await handleOpenFileTool(context, state, step, toolCall));
      } else if (toolCall.function.name === "keep_file") {
        messages.push(await handleKeepFileTool(context, state, step, toolCall));
      }
    }
  }

  const reason = `Agent stopped after reaching the ${budget.maxToolSteps}-step tool-use budget.`;

  // Budget exhausted: force one final, tool-free turn so the agent still
  // respects the requested mode. Without this, synthesis runs that ran out of
  // steps would skip synthesis and return only the raw list of files read.
  // List mode needs no model turn: un-curated returns the files found, and
  // curated returns the files already kept live via keep_file. So only
  // synthesis needs the extra call.
  const needsFinalModelTurn = input.mode === "synthesis";
  let finalContent: string | null = null;
  if (needsFinalModelTurn) {
    messages.push({
      role: "user",
      content: `${reason} Stop using tools and return the final result now.`
    });
    try {
      const completion = await callModel(
        modelSettings,
        messages,
        requestId,
        budget.maxToolSteps,
        null
      );
      finalContent = completion.choices[0]?.message?.content ?? null;
    } catch (error) {
      await writeDebugLog({
        event: "agent.final_turn.failed",
        level: "error",
        requestId,
        durationMs: Date.now() - startedAt,
        error: debugError(error)
      });
    }
  }

  const { answer, answerFormat } =
    finalContent !== null
      ? parseFinalAnswer(finalContent, input.mode)
      : partialAnswer(reason, input.mode);
  const curated = curating ? curatedResult() : null;
  const files = curated ? curated.files : uniqueFiles(state.referencedFiles);
  if (curated?.fallback) {
    await emit({
      type: "progress",
      message: "No files were explicitly kept; returning all reviewed files."
    });
  }
  await writeDebugLog({
    event: "agent.completed",
    requestId,
    reason: "max_tool_steps_reached",
    durationMs: Date.now() - startedAt,
    finalModelTurn: needsFinalModelTurn,
    forcedFinalAnswer: finalContent !== null,
    searchCallCount: state.searchCallCount,
    openFileCallCount: state.openFileCallCount,
    referencedFileCount: state.referencedFiles.length,
    keptFileCount: state.keptFiles.length,
    curatedFallback: curated?.fallback ?? false,
    returnedFileCount: files.length,
    answerFormat,
    answerLength: answer.length
  });
  await emit({ type: "final", answer, answerFormat, files });
}
