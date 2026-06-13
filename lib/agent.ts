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
  isDebugTranscriptLogEnabled,
  writeDebugLog
} from "@/lib/debug-log";

/**
 * Per-request timeout for the outbound model call. Without it, a hung upstream
 * endpoint would stall the request indefinitely and hold the agent's SSE stream
 * and server resources open. Applied via {@link AbortSignal.timeout}, so it
 * bounds connect + response-body read for each individual attempt.
 */
const MODEL_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Additional retry attempts for a failed model call, on top of the initial
 * attempt (so `2` ⇒ up to three attempts total). Only transient failures are
 * retried — network errors, timeouts, HTTP 5xx, and 429 — mirroring
 * {@link withToolRetries} for the Drive tools, which the model call previously
 * lacked. Client errors (4xx) are never retried: an identical bad request will
 * only fail again and waste time and tokens.
 */
const MODEL_REQUEST_MAX_RETRIES = 2;

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
    name: "search_drive" | "open_file" | "review_file";
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
      // Reasoning/thinking models return their chain-of-thought separately from
      // `content` (which is null on tool-call turns). Fireworks/DeepSeek/vLLM use
      // `reasoning_content`; OpenRouter and some others use `reasoning`. Capture
      // both so the transcript log shows the rationale regardless of provider.
      reasoning_content?: string | null;
      reasoning?: string | null;
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
  // Curated list mode only: a file the agent is reading and grading right now.
  // Provisional — it resolves to exactly one of `kept` or `discarded`.
  | { type: "reviewing"; file: DriveFile }
  // Curated list mode only: a reviewed file the grader judged relevant. The set
  // of kept files is the authoritative curated result.
  | { type: "kept"; file: DriveFile }
  // Curated list mode only: a reviewed file the grader judged not relevant, so
  // the UI can drop it from the provisional "reviewing" state.
  | { type: "discarded"; file: DriveFile }
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

const reviewArgs = z.object({
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
      "Open and read a file returned by search_drive. Copy connectionId and fileId verbatim from a single search_drive result — never invent, guess, or modify an id, and never pair the connectionId of one file with the fileId of another. connectionId must be one of the selected Drive connection IDs.",
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

// Curated list mode only. Reads a candidate file and judges its relevance in a
// single step. Crucially, the file's content is NOT loaded into the main agent's
// context: review_file opens the file and grades it in an isolated, single-shot
// model call (see gradeFileRelevance), returning only a compact verdict. This
// keeps the curating loop's context tiny no matter how many files it reviews,
// and makes each relevance judgement an independent decision with the model's
// full attention rather than one made while 14 other files crowd the window.
const reviewFileTool: ToolDefinition = {
  type: "function",
  function: {
    name: "review_file",
    description:
      "Open a file returned by search_drive, read it, and judge whether it is relevant to the query. Relevant files are kept in the curated results automatically; irrelevant ones are discarded. Copy connectionId and fileId verbatim from a single search_drive result — never invent, guess, or modify an id, and never pair the connectionId of one file with the fileId of another. connectionId must be one of the selected Drive connection IDs.",
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
 * Tools offered to the model for a given request. Curated list mode swaps
 * `open_file` for `review_file`: instead of pulling file contents into the
 * agent's context and judging them inline, the model reviews candidates and an
 * isolated grader decides relevance, so curated runs never offer `open_file`.
 */
function toolsForRequest(input: AgentRequest): ToolDefinition[] {
  return isCuratingRequest(input) ? [searchTool, reviewFileTool] : baseTools;
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
    ? "You have exactly two tools: search_drive and review_file."
    : "You have exactly two tools: search_drive and open_file.";
  const readBudgetLine = curating
    ? `Use at most ${budget.maxOpenFileCalls} review_file calls.`
    : `Use at most ${budget.maxOpenFileCalls} open_file calls.`;
  // Smaller models occasionally fabricate a connectionId — e.g. inventing a
  // second connection even when only one exists. Spell out that ids are opaque
  // values to be copied verbatim, and when there is a single connection pin it
  // to one literal so there is nothing to "guess".
  const idRule =
    allowedDriveIds.length === 1
      ? `There is exactly one connection: every connectionId you pass must be exactly "${allowedDriveIds[0]}" — never any other value.`
      : `Every connectionId you pass must be exactly one of those IDs.`;
  return `You are a Google Drive research agent.

${toolList}
You may only work with these selected Drive connection IDs: ${allowedDriveIds.join(", ")}.
Every connectionId and fileId you pass to a tool is an opaque identifier you must copy verbatim from a search_drive result — never invent, guess, modify, or take an id from a different file.
${idRule}
Use at most ${budget.maxSearchCalls} search_drive calls.
${readBudgetLine}
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
For every file that looks promising from its title or snippet, call review_file with its connectionId and fileId.
review_file opens the file, reads it, and judges its relevance for you: relevant files are kept in the results automatically and irrelevant ones are discarded. You do not judge relevance yourself, and there is no separate step to open or keep a file.
Only files you review can be returned, and only the relevant ones are kept, so review every promising file.
When you have reviewed the promising files, stop calling tools and reply with exactly:
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

/**
 * Error thrown for a non-OK model HTTP response. Carries whether the status is
 * worth retrying so {@link callModel}'s retry loop can tell a transient 5xx/429
 * (retry) apart from a client 4xx (do not retry).
 */
class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "ModelRequestError";
  }
}

/**
 * Identifies which logical caller is issuing a model request so its debug-log
 * events stay attributable. The agent makes model calls from two distinct places
 * that must never blur together in a transcript: the main reasoning loop and the
 * isolated per-file relevance grader (curated list mode). They share a requestId
 * and step — and a single step can grade several files — so the caller is what
 * tells them apart.
 */
type ModelCaller = "agent" | "grader";

/**
 * Debug-log event namespace for a {@link callModel} invocation. The main agent
 * loop logs under `agent.model.*`; the grader logs under `agent.grade.*` so its
 * isolated relevance judgements are never mistaken for the agent's own reasoning
 * turns (and align with the `agent.grade.failed` event the grader already emits).
 */
export function modelEventPrefix(caller: ModelCaller) {
  return caller === "grader" ? "agent.grade" : "agent.model";
}

/**
 * Pull a model turn's chain-of-thought out of whichever field the provider used.
 * Reasoning/thinking models return it separately from `content` (which is null
 * on tool-call turns): Fireworks/DeepSeek/vLLM use `reasoning_content`,
 * OpenRouter and some others use `reasoning`. Returning it lets the transcript
 * log show the rationale regardless of provider; `null` means none was given.
 */
export function extractReasoningContent(
  message: { reasoning_content?: string | null; reasoning?: string | null } | undefined
): string | null {
  return message?.reasoning_content ?? message?.reasoning ?? null;
}

/**
 * Debug-log attribution for a single {@link callModel} invocation: which caller
 * issued it (so grader calls log distinctly under `agent.grade.*`) and any extra
 * fields merged into every one of that call's events. The grader passes the
 * hashed key of the file it is judging, so a grade's request/completed/
 * transcript/error entries are self-correlating even when several files are
 * graded within one step.
 */
type ModelCallLog = {
  caller?: ModelCaller;
  fields?: Record<string, unknown>;
};

async function callModel(
  settings: EffectiveModelSettings,
  messages: ChatMessage[],
  requestId: string,
  step: number,
  offeredTools: ToolDefinition[] | null = null,
  log: ModelCallLog = {}
) {
  const startedAt = Date.now();
  const toolsEnabled = Boolean(offeredTools?.length);
  // Grader calls log under agent.grade.* (see modelEventPrefix) so they are
  // never confused with the main agent's agent.model.* turns; logFields tags
  // every event for this call (e.g. the grader's file hash) for correlation.
  const eventPrefix = modelEventPrefix(log.caller ?? "agent");
  const logFields = log.fields ?? {};

  await writeDebugLog({
    event: `${eventPrefix}.request`,
    requestId,
    step,
    model: settings.model,
    modelSettingsSource: settings.source,
    messageCount: messages.length,
    toolsEnabled,
    ...logFields
  });

  let lastError: unknown;
  for (let attempt = 0; attempt <= MODEL_REQUEST_MAX_RETRIES; attempt += 1) {
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
          event: `${eventPrefix}.failed`,
          level: "error",
          requestId,
          step,
          model: settings.model,
          modelSettingsSource: settings.source,
          status: response.status,
          durationMs: Date.now() - startedAt,
          attempt,
          response: debugText(responseBody),
          ...logFields
        });
        throw new ModelRequestError(
          `AI request failed with status ${response.status}`,
          isRetryableModelStatus(response.status)
        );
      }

      const completion = (await response.json()) as ChatCompletion;
      const message = completion.choices[0]?.message;
      // Reasoning models (e.g. gpt-oss on Fireworks) put their chain-of-thought
      // in reasoning_content/reasoning, not content — and content is null on
      // tool-call turns. extractReasoningContent falls back across the field
      // names so the rationale is captured regardless of provider.
      const reasoning = extractReasoningContent(message);
      await writeDebugLog({
        event: `${eventPrefix}.completed`,
        requestId,
        step,
        model: settings.model,
        modelSettingsSource: settings.source,
        durationMs: Date.now() - startedAt,
        toolCallCount: message?.tool_calls?.length ?? 0,
        responseContentLength: message?.content?.length ?? 0,
        reasoningContentLength: reasoning?.length ?? 0,
        ...logFields
      });
      // Full transcript dump (DEBUG_LOG_TRANSCRIPT only): the model's raw,
      // untruncated reasoning text (reasoningContent) plus the tool calls it
      // issued this step (names and arguments). This is what makes curation
      // decisions auditable — e.g. why a file was kept vs. merely reviewed —
      // which the metadata-only completed event above cannot show. For reasoning
      // models the rationale lives in reasoningContent since content is null
      // whenever the model calls a tool, so both fields are logged in full. The
      // grader logs its own agent.grade.transcript (distinct from the main
      // agent's agent.model.transcript). Emitted for every model call (every
      // mode, the grader, and the forced final synthesis turn) and kept
      // independent of DEBUG_LOG_CONTENT.
      if (isDebugTranscriptLogEnabled()) {
        await writeDebugLog({
          event: `${eventPrefix}.transcript`,
          requestId,
          step,
          model: settings.model,
          content: message?.content ?? null,
          reasoningContent: reasoning,
          toolCalls: (message?.tool_calls ?? []).map((toolCall) => ({
            name: toolCall.function.name,
            arguments: toolCall.function.arguments
          })),
          ...logFields
        });
      }
      return completion;
    } catch (error) {
      lastError = error;
      // HTTP errors carry their own retryability (4xx no, 5xx/429 yes); network
      // failures, timeouts, and unparseable bodies are treated as transient.
      const retryable = error instanceof ModelRequestError ? error.retryable : true;
      const willRetry = retryable && attempt < MODEL_REQUEST_MAX_RETRIES;
      await writeDebugLog({
        event: `${eventPrefix}.error`,
        level: willRetry ? "warn" : "error",
        requestId,
        step,
        model: settings.model,
        modelSettingsSource: settings.source,
        durationMs: Date.now() - startedAt,
        attempt,
        willRetry,
        error: debugError(error),
        ...logFields
      });
      if (!willRetry) throw error;
    }
  }

  // The loop returns on success and throws on a final/non-retryable error, so
  // this only guards the otherwise-unreachable case of exhausting the bound.
  throw lastError ?? new Error("AI request failed");
}

/**
 * Verdict from grading one file against the query in curated list mode. The
 * `reason` is a short, auditable justification (surfaced in debug logs and the
 * review_file tool result), not shown to the end user.
 */
export type GradeVerdict = { relevant: boolean; reason: string };

const MAX_GRADE_REASON_CHARS = 300;

/**
 * Build the isolated conversation used to grade a single file. This is a fresh,
 * minimal context — system instruction plus one user message holding only the
 * query and this one file — so the judgement never sees (or is polluted by) the
 * other files the agent is reviewing. The content is already capped upstream by
 * the Drive reader (MAX_FILE_CHARS), so this stays a small, bounded prompt.
 */
function buildGradeMessages(query: string, file: DriveFile, content: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You decide whether a single document is relevant to a user's search query.
Relevant means the document's content would help answer or directly concerns the query — sharing a keyword alone is not enough.
Respond with ONLY a JSON object and nothing else (no prose, no code fences):
{"relevant": true or false, "reason": "<one short sentence>"}`
    },
    {
      role: "user",
      content: `Query: ${query}

File name: ${file.name}
File type: ${formatMimeType(file.mimeType)}

Content:
${content}`
    }
  ];
}

/**
 * Parse the grader's reply into a verdict. The grader is instructed to return a
 * bare JSON object, but models sometimes wrap it in prose or code fences, so we
 * extract the first JSON object and read `relevant`/`reason` leniently. If the
 * reply cannot be parsed at all, we default to KEEPING the file: a malformed
 * grade should not silently drop a file that might be relevant (favouring recall
 * mirrors the rest of the agent's "return something useful" behaviour), and the
 * reason records that it was a default so the decision stays auditable.
 */
export function parseGradeResponse(content: string | null): GradeVerdict {
  const raw = (content ?? "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { relevant?: unknown; reason?: unknown };
      const relevant =
        parsed.relevant === true || /^(true|yes|relevant)$/i.test(String(parsed.relevant).trim());
      const reason =
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim().slice(0, MAX_GRADE_REASON_CHARS)
          : relevant
            ? "Judged relevant."
            : "Judged not relevant.";
      return { relevant, reason };
    } catch {
      // Fall through to the default-keep behaviour below.
    }
  }
  return { relevant: true, reason: "Relevance grade could not be parsed; kept by default." };
}

/**
 * Grade one already-read file against the query using an isolated, single-shot
 * model call (no tools, its own minimal conversation). On any failure — the
 * grader request erroring out after retries, or an unparseable reply — we keep
 * the file rather than abort or drop it, so a transient grader problem degrades
 * to extra recall instead of a missing result.
 */
export async function gradeFileRelevance(
  modelSettings: EffectiveModelSettings,
  query: string,
  file: DriveFile,
  content: string,
  requestId: string,
  step: number
): Promise<GradeVerdict> {
  // The grader is a separate model call from the main agent loop: route its logs
  // under agent.grade.* (caller: "grader") and tag every event with the file it
  // is judging so each grade stays attributable even when several files share a
  // step.
  const fileKeyHash = hashForDebug(fileKey(file));
  try {
    const completion = await callModel(
      modelSettings,
      buildGradeMessages(query, file, content),
      requestId,
      step,
      null,
      { caller: "grader", fields: { fileKeyHash } }
    );
    return parseGradeResponse(completion.choices[0]?.message?.content ?? null);
  } catch (error) {
    await writeDebugLog({
      event: "agent.grade.failed",
      level: "warn",
      requestId,
      step,
      fileKeyHash,
      error: debugError(error)
    });
    return { relevant: true, reason: "Relevance check unavailable; kept by default." };
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

function isRetryableToolError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /\b(408|409|429|500|502|503|504)\b/.test(error.message);
}

/**
 * Model-endpoint HTTP statuses worth retrying: 5xx (server-side) and 429 (rate
 * limited). 4xx (bad request, auth, bad config) will not fix themselves, so an
 * identical retry would only fail again.
 */
export function isRetryableModelStatus(status: number) {
  return status === 429 || status >= 500;
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
 * Parse a tool call's JSON arguments against its zod schema, converting any
 * failure — malformed JSON (`SyntaxError`) or a schema violation (`ZodError`,
 * e.g. a missing/empty field or out-of-range value) — into a recoverable
 * observation instead of throwing. A throw here would bubble out of the
 * tool-dispatch loop and abort the whole run over a single malformed call the
 * model could simply re-issue with corrected arguments.
 */
async function parseToolArgs<T>(
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
  /**
   * Curated list mode only: grade one already-read file for relevance. Injected
   * (rather than called directly) so it runs as an isolated model call in
   * production but can be stubbed in tests without mocking the network. `step` is
   * forwarded for debug-log correlation.
   */
  gradeFile: (file: DriveFile, content: string, step: number) => Promise<GradeVerdict>;
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
   * Curated list mode only: every file run through the relevance grader (kept or
   * discarded). Tracked for visibility/logging; the result is `keptFiles`.
   */
  reviewedFiles: DriveFile[];
  /**
   * Curated list mode only: files the grader judged relevant. This is the
   * authoritative curated result, populated live as the run progresses.
   */
  keptFiles: DriveFile[];
  searchedQueries: Set<string>;
  knownFileKeys: Set<string>;
  openedFileKeys: Set<string>;
  reviewedFileKeys: Set<string>;
  keptFileKeys: Set<string>;
  searchCallCount: number;
  openFileCallCount: number;
  reviewFileCallCount: number;
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
  const parsed = await parseToolArgs(context, step, toolCall, searchArgs);
  if (!parsed.ok) return parsed.observation;
  const args = parsed.args;
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
 *
 * An out-of-scope connectionId (the model fabricating an id instead of copying
 * one from a search result) is rejected as a tool-result observation, not
 * thrown — the file is never opened, but the run continues so the model can
 * retry with a valid connectionId instead of aborting the entire run.
 */
export async function handleOpenFileTool(
  context: AgentRunContext,
  state: AgentRunState,
  step: number,
  toolCall: ToolCall
): Promise<ToolResultMessage> {
  const { requestId, budget, selectedDriveIds, ownerSub, emit } = context;
  const parsed = await parseToolArgs(context, step, toolCall, openArgs);
  if (!parsed.ok) return parsed.observation;
  const args = parsed.args;
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
    // Security boundary: we never open a file outside the user's selected
    // drives (we return before openDriveFile is ever called). But an
    // out-of-scope connectionId is almost always the model fabricating an id
    // instead of copying it from a search result, so surface it as a
    // recoverable observation rather than throwing — a throw bubbles out of
    // runDriveAgent and aborts the whole run, discarding every file already
    // reviewed. Returning lets the model retry with a valid connectionId.
    return toolErrorObservation(
      toolCall.id,
      `connectionId "${args.connectionId}" is not one of the selected Drive connections, so this file cannot be opened. Use the exact connectionId from a search_drive result. Selected connectionIds: ${selectedDriveIds.join(", ")}.`
    );
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
  // open_file is offered only outside curated mode (curated runs review files
  // via review_file instead), so an opened file is always a result to surface.
  state.referencedFiles.push(opened.file);
  await emit({ type: "progress", message: `Opened ${formatFileProgressLabel(opened.file)}` });
  await emit({ type: "file", file: opened.file });
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
 * Handle a single `review_file` tool call (curated list mode only): open a
 * candidate file, grade its relevance in an isolated model call, and keep it iff
 * the grader says it is relevant. Unlike open_file, the file's content is never
 * returned into the main loop's context — only a compact verdict — so the
 * curating conversation stays small however many files are reviewed.
 *
 * Mirrors open_file's guards (out-of-scope connectionId, dedupe, budget, open
 * failure) which are all surfaced as recoverable observations rather than thrown,
 * so a single bad file never aborts the run. Emits a provisional `reviewing`
 * event before grading, then `kept` or `discarded` once the verdict is in, so
 * the UI shows each review as it happens instead of a lingering queue.
 */
export async function handleReviewFileTool(
  context: AgentRunContext,
  state: AgentRunState,
  step: number,
  toolCall: ToolCall
): Promise<ToolResultMessage> {
  const { requestId, budget, selectedDriveIds, ownerSub, emit, gradeFile } = context;
  const parsed = await parseToolArgs(context, step, toolCall, reviewArgs);
  if (!parsed.ok) return parsed.observation;
  const args = parsed.args;
  const key = `${args.connectionId}:${args.fileId}`;
  await writeDebugLog({
    event: "agent.tool.review_file.requested",
    requestId,
    step,
    toolCallIdHash: hashForDebug(toolCall.id),
    connectionIdHash: hashForDebug(args.connectionId),
    fileIdHash: hashForDebug(args.fileId),
    reviewFileCallCount: state.reviewFileCallCount
  });
  if (!selectedDriveIds.includes(args.connectionId)) {
    await writeDebugLog({
      event: "agent.tool.review_file.rejected",
      level: "error",
      requestId,
      step,
      reason: "outside_selected_drive_scope",
      connectionIdHash: hashForDebug(args.connectionId),
      fileIdHash: hashForDebug(args.fileId)
    });
    // Same security boundary and recovery posture as open_file: an out-of-scope
    // connectionId is almost always a hallucinated id, so reject it as an
    // observation (never opening the file) instead of throwing and aborting.
    return toolErrorObservation(
      toolCall.id,
      `connectionId "${args.connectionId}" is not one of the selected Drive connections, so this file cannot be reviewed. Use the exact connectionId from a search_drive result. Selected connectionIds: ${selectedDriveIds.join(", ")}.`
    );
  }
  if (state.reviewedFileKeys.has(key)) {
    await writeDebugLog({
      event: "agent.tool.review_file.skipped",
      requestId,
      step,
      reason: "already_reviewed",
      fileKeyHash: hashForDebug(key)
    });
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: safeJson({ reviewed: true, alreadyReviewed: true, kept: state.keptFileKeys.has(key) })
    };
  }
  if (state.reviewFileCallCount >= budget.maxOpenFileCalls) {
    const reason = `Review budget reached after ${state.reviewFileCallCount} review_file call(s).`;
    await emit({ type: "progress", message: reason });
    await writeDebugLog({
      event: "agent.tool.review_file.skipped",
      level: "warn",
      requestId,
      step,
      reason: "review_budget_reached",
      reviewFileCallCount: state.reviewFileCallCount
    });
    state.stopAfterToolUseReason = reason;
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: safeJson({ skipped: true, reason })
    };
  }

  state.reviewFileCallCount += 1;
  state.reviewedFileKeys.add(key);
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
      event: "agent.tool.review_file.failed",
      level: "error",
      requestId,
      step,
      durationMs: Date.now() - toolStartedAt,
      fileKeyHash: hashForDebug(key),
      reviewFileCallCount: state.reviewFileCallCount,
      error: debugError(error)
    });
    return toolErrorObservation(
      toolCall.id,
      `Could not open this file to review it: ${errorText(error)}. It may be inaccessible; continue with the other files.`
    );
  }

  const openedKey = fileKey(opened.file);
  state.knownFileKeys.add(openedKey);
  state.reviewedFileKeys.add(openedKey);
  state.reviewedFiles.push(opened.file);
  await emit({ type: "progress", message: `Reviewing ${formatFileProgressLabel(opened.file)}` });
  await emit({ type: "reviewing", file: opened.file });

  const verdict = await gradeFile(opened.file, opened.content, step);
  await writeDebugLog({
    event: "agent.tool.review_file.completed",
    requestId,
    step,
    durationMs: Date.now() - toolStartedAt,
    fileKeyHash: hashForDebug(openedKey),
    mimeType: opened.file.mimeType,
    contentLength: opened.content.length,
    relevant: verdict.relevant,
    // The grader's justification is meant to be auditable (see GradeVerdict);
    // surface it here at the metadata tier (gated like other model-derived text
    // via debugText) so a keep/discard decision is explained even without the
    // full DEBUG_LOG_TRANSCRIPT dump.
    reason: debugText(verdict.reason),
    reviewFileCallCount: state.reviewFileCallCount,
    keptFileCount: state.keptFiles.length
  });

  if (verdict.relevant) {
    if (!state.keptFileKeys.has(openedKey)) {
      state.keptFileKeys.add(openedKey);
      state.keptFiles.push(opened.file);
    }
    await emit({ type: "progress", message: `Kept ${formatFileProgressLabel(opened.file)}` });
    await emit({ type: "kept", file: opened.file });
  } else {
    await emit({ type: "progress", message: `Discarded ${formatFileProgressLabel(opened.file)}` });
    await emit({ type: "discarded", file: opened.file });
  }

  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content: safeJson({ reviewed: true, kept: verdict.relevant, reason: verdict.reason })
  };
}

/**
 * Route one tool call from the model to its handler. Centralised so the run loop
 * stays a thin iterator and — crucially — so every tool call produces a
 * tool-result message, including tool names the model invents. An unanswered
 * tool call leaves the next request a malformed conversation (an assistant
 * `tool_calls` entry with no matching `tool` reply), which providers reject,
 * aborting the run.
 */
export async function dispatchToolCall(
  context: AgentRunContext,
  state: AgentRunState,
  step: number,
  toolCall: ToolCall
): Promise<ToolResultMessage> {
  // The completion is cast from the wire, so the union type does not actually
  // constrain the runtime value — the model can emit any tool name.
  const name: string = toolCall.function.name;
  if (name === "search_drive") return handleSearchTool(context, state, step, toolCall);
  if (name === "open_file") return handleOpenFileTool(context, state, step, toolCall);
  if (name === "review_file") return handleReviewFileTool(context, state, step, toolCall);

  await writeDebugLog({
    event: "agent.tool.unknown",
    level: "warn",
    requestId: context.requestId,
    step,
    tool: name,
    toolCallIdHash: hashForDebug(toolCall.id)
  });
  const available = toolsForRequest(context.input)
    .map((tool) => tool.function.name)
    .join(", ");
  return toolErrorObservation(
    toolCall.id,
    `Unknown tool "${name}". Use only these tools: ${available}.`
  );
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
    emit,
    gradeFile: (file, content, step) =>
      gradeFileRelevance(modelSettings, input.query, file, content, requestId, step)
  };
  const state: AgentRunState = {
    referencedFiles: [],
    openedFiles: [],
    reviewedFiles: [],
    keptFiles: [],
    searchedQueries: new Set<string>(),
    knownFileKeys: new Set<string>(),
    openedFileKeys: new Set<string>(),
    reviewedFileKeys: new Set<string>(),
    keptFileKeys: new Set<string>(),
    searchCallCount: 0,
    openFileCallCount: 0,
    reviewFileCallCount: 0,
    lowProgressSearchCount: 0,
    stopAfterToolUseReason: null
  };
  const curating = isCuratingRequest(input);
  // In curated mode the curated result is exactly the set of files the grader
  // kept, built up live as review_file runs rather than parsed from a final
  // message. An empty kept set is a valid "nothing relevant" result, so there is
  // no opened-files fallback.
  const curatedResult = () => uniqueFiles(state.keptFiles);
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
          ? `${state.stopAfterToolUseReason} Stop searching. Review any remaining promising files with review_file, then reply to finish.`
          : `${state.stopAfterToolUseReason} Stop using tools and return the final result now.`
      });
      stopInstructionSent = true;
    }

    // Once a budget has forced a stop, drop search so the model winds down
    // instead of issuing calls that would only be skipped. In curated mode keep
    // offering review_file so a promising file found right before the stop can
    // still be reviewed; a review past the review budget just returns a skipped
    // observation, so this can't run away.
    const offeredTools = stopInstructionSent
      ? curating
        ? [reviewFileTool]
        : null
      : activeTools;
    const completion = await callModel(modelSettings, messages, requestId, step, offeredTools);
    const message = completion.choices[0]?.message;
    if (!message) {
      // A completion with no choices/message is malformed, but aborting would
      // discard everything gathered so far. Finalize gracefully with the files
      // already found (plus, in synthesis, a partial-answer note), exactly as
      // the budget-exhausted path does.
      const reason = "The AI returned an empty response.";
      const { answer, answerFormat } = partialAnswer(reason, input.mode);
      const files = curating ? curatedResult() : uniqueFiles(state.referencedFiles);
      await writeDebugLog({
        event: "agent.completed",
        requestId,
        reason: "model_returned_no_message",
        durationMs: Date.now() - startedAt,
        step,
        searchCallCount: state.searchCallCount,
        openFileCallCount: state.openFileCallCount,
        referencedFileCount: state.referencedFiles.length,
        keptFileCount: state.keptFiles.length,
        reviewedFileCount: state.reviewedFiles.length,
        returnedFileCount: files.length,
        answerFormat,
        answerLength: answer.length
      });
      await emit({ type: "final", answer, answerFormat, files });
      return;
    }

    messages.push({
      role: "assistant",
      content: message.content,
      tool_calls: message.tool_calls
    });

    if (!message.tool_calls?.length) {
      const { answer, answerFormat } = parseFinalAnswer(message.content, input.mode);
      const files = curating ? curatedResult() : uniqueFiles(state.referencedFiles);
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
        reviewedFileCount: state.reviewedFiles.length,
        returnedFileCount: files.length,
        answerFormat,
        answerLength: answer.length
      });
      await emit({ type: "final", answer, answerFormat, files });
      return;
    }

    for (const toolCall of message.tool_calls) {
      messages.push(await dispatchToolCall(context, state, step, toolCall));
    }
  }

  const reason = `Agent stopped after reaching the ${budget.maxToolSteps}-step tool-use budget.`;

  // Budget exhausted: force one final, tool-free turn so the agent still
  // respects the requested mode. Without this, synthesis runs that ran out of
  // steps would skip synthesis and return only the raw list of files read.
  // List mode needs no model turn: un-curated returns the files found, and
  // curated returns the files the grader already kept live via review_file. So
  // only synthesis needs the extra call.
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
  const files = curating ? curatedResult() : uniqueFiles(state.referencedFiles);
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
    reviewedFileCount: state.reviewedFiles.length,
    returnedFileCount: files.length,
    answerFormat,
    answerLength: answer.length
  });
  await emit({ type: "final", answer, answerFormat, files });
}
