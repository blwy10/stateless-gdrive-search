// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import {
  generateObject,
  generateText,
  jsonSchema,
  stepCountIs,
  tool,
  type ModelMessage,
  type StepResult,
  type ToolSet
} from "ai";
import { z } from "zod";
import { listDriveConnections } from "@/lib/drive-connections";
import { openDriveFile, searchDriveFiles, type DriveFile } from "@/lib/drive";
import { formatMimeType } from "@/lib/file-types";
import { getEffectiveModelSettings, type ModelProvider } from "@/lib/model-settings";
import { resolveModel, type ResolvedModel } from "@/lib/model-provider";
import {
  createDebugRequestId,
  debugError,
  debugText,
  hashForDebug,
  isDebugTranscriptLogEnabled,
  writeDebugLog
} from "@/lib/debug-log";

/**
 * Retry attempts for a failed model call, passed to the AI SDK as `maxRetries`.
 * The SDK retries only transient failures (network errors, timeouts, HTTP 5xx,
 * and 429) with exponential backoff and never retries 4xx — matching the policy
 * the old hand-rolled `callModel` enforced. The per-request timeout now lives in
 * the SSRF-safe fetch wrapper (see lib/model-provider.ts).
 */
const MODEL_REQUEST_MAX_RETRIES = 2;

const AgentRequest = z.object({
  query: z.string().trim().min(1).max(2000),
  mode: z.enum(["list", "synthesis"]),
  driveIds: z.array(z.string().min(1)).min(1).max(20),
  curateList: z.boolean().optional().default(false)
});

type AgentRequest = z.infer<typeof AgentRequest>;

/**
 * Minimal OpenAI-style tool-call shape used only to bridge the AI SDK's parsed
 * tool input into the existing tool handlers, which were written against this
 * shape and remain the tested, run-resilient core of the agent. The SDK now
 * validates and routes tool calls itself; this is just the adapter currency (see
 * {@link buildAgentTools}). Reasoning round-trip and the assistant/tool message
 * bookkeeping that the old loop did by hand are handled inside the SDK.
 */
type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: "search_drive" | "open_file" | "review_file";
    arguments: string;
  };
};

/**
 * Tool-result observation appended after a tool call. Every handler returns
 * exactly one of these (never throwing — see the run-resilience invariant); the
 * adapter unwraps `content` into the value handed back to the model.
 */
type ToolResultMessage = { role: "tool"; tool_call_id: string; content: string };

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

function isCuratingRequest(input: AgentRequest) {
  return input.mode === "list" && input.curateList;
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
 * Log one model step's outcome. The AI SDK drives the loop now, so instead of a
 * hand-rolled per-attempt logger this runs from `generateText`'s onStepFinish.
 * Reasoning is read from the SDK's unified `reasoningText` regardless of provider
 * (OpenAI summaries, Anthropic thinking, Fireworks reasoning_content all land
 * there); the full untruncated transcript (content + reasoning + tool calls +
 * raw response body) is emitted only under DEBUG_LOG_TRANSCRIPT. `caller`
 * separates the main agent (`agent.model.*`) from the curated grader, which logs
 * its own `agent.grade.*` events.
 */
async function logModelStep(
  requestId: string,
  settings: { model: string; provider: ModelProvider; source: "default" | "custom" },
  step: StepResult<ToolSet>
) {
  const reasoning = step.reasoningText ?? null;
  await writeDebugLog({
    event: "agent.model.completed",
    requestId,
    step: step.stepNumber,
    model: settings.model,
    provider: settings.provider,
    modelSettingsSource: settings.source,
    finishReason: step.finishReason,
    toolCallCount: step.toolCalls.length,
    responseContentLength: step.text.length,
    reasoningContentLength: reasoning?.length ?? 0,
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

/**
 * Verdict from grading one file against the query in curated list mode. The
 * `reason` is a short, auditable justification (surfaced in debug logs and the
 * review_file tool result), not shown to the end user.
 */
export type GradeVerdict = { relevant: boolean; reason: string };

const MAX_GRADE_REASON_CHARS = 300;

/** Structured verdict the curated grader is asked to produce. */
const gradeSchema = z.object({
  relevant: z
    .boolean()
    .describe("True if the document would help answer or directly concerns the query."),
  reason: z.string().optional().describe("One short sentence justifying the decision.")
});

const GRADE_SYSTEM_PROMPT = `You decide whether a single document is relevant to a user's search query.
Relevant means the document's content would help answer or directly concerns the query — sharing a keyword alone is not enough.`;

/**
 * Normalize the grader's structured output into a {@link GradeVerdict}: trim and
 * cap the reason, and supply a default sentence when the model omits one. Kept
 * pure (and exported) so the keep/discard + reason behaviour stays unit-testable
 * without exercising the model call.
 */
export function normalizeGradeVerdict(object: { relevant: boolean; reason?: string | null }): GradeVerdict {
  const reason =
    typeof object.reason === "string" && object.reason.trim()
      ? object.reason.trim().slice(0, MAX_GRADE_REASON_CHARS)
      : object.relevant
        ? "Judged relevant."
        : "Judged not relevant.";
  return { relevant: object.relevant, reason };
}

/**
 * Build the single user prompt for grading one file. A fresh, minimal context —
 * just the query and this one file — so the judgement is never polluted by the
 * other files the agent is reviewing. Content is already capped upstream by the
 * Drive reader (MAX_FILE_CHARS), so this stays a small, bounded prompt.
 */
function buildGradePrompt(query: string, file: DriveFile, content: string) {
  return `Query: ${query}

File name: ${file.name}
File type: ${formatMimeType(file.mimeType)}

Content:
${content}`;
}

/**
 * Grade one already-read file against the query using an isolated, single-shot
 * structured model call (`generateObject`, no tools, its own minimal prompt).
 * The file's content never enters the main agent loop's context — only this
 * verdict does. On any failure — the request erroring out after retries, or
 * output that fails schema validation — we KEEP the file rather than abort or
 * drop it, so a transient grader problem degrades to extra recall instead of a
 * missing result. Logs under `agent.grade.*`, distinct from the main loop's
 * `agent.model.*`, tagged with the file it is judging.
 */
export async function gradeFileRelevance(
  resolved: ResolvedModel,
  query: string,
  file: DriveFile,
  content: string,
  requestId: string,
  step: number
): Promise<GradeVerdict> {
  const fileKeyHash = hashForDebug(fileKey(file));
  try {
    const { object } = await generateObject({
      model: resolved.model,
      providerOptions: resolved.providerOptions,
      ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
      maxRetries: MODEL_REQUEST_MAX_RETRIES,
      schema: gradeSchema,
      schemaName: "FileRelevance",
      schemaDescription: "Whether a document is relevant to the user's search query.",
      system: GRADE_SYSTEM_PROMPT,
      prompt: buildGradePrompt(query, file, content)
    });
    const { relevant, reason } = normalizeGradeVerdict(object);
    await writeDebugLog({
      event: "agent.grade.completed",
      requestId,
      step,
      fileKeyHash,
      relevant,
      // The grader's justification is auditable (see GradeVerdict); surface it
      // at the metadata tier (gated via debugText) so a keep/discard decision is
      // explained even without the full DEBUG_LOG_TRANSCRIPT dump.
      reason: debugText(reason)
    });
    return { relevant, reason };
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
  /**
   * Zero-based index of the step currently executing, set by `prepareStep`
   * before each step so the tool handlers (which the SDK may run in parallel
   * within a step) can attribute their debug logs to the right step.
   */
  currentStep: number;
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
 * Build the AI SDK tool set for a run, closing over its context and state.
 * Curated list mode swaps `open_file` for `review_file` (file contents are graded
 * in isolation and never enter this loop's context). Each tool defers to its
 * tested handler via {@link runToolHandler}.
 */
function buildAgentTools(context: AgentRunContext, state: AgentRunState): ToolSet {
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

  if (isCuratingRequest(context.input)) {
    const reviewFile = tool({
      description:
        "Open a file returned by search_drive, read it, and judge whether it is relevant to the query. Relevant files are kept in the curated results automatically; irrelevant ones are discarded. Copy connectionId and fileId verbatim from a single search_drive result — never invent, guess, or modify an id, and never pair the connectionId of one file with the fileId of another. connectionId must be one of the selected Drive connection IDs.",
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

/**
 * Force one final, tool-free synthesis turn after the loop ends without a usable
 * answer (e.g. the step budget was hit mid-tool-use). Without it, a synthesis run
 * that ran out of steps would return only the raw files read. Reuses the run's
 * conversation (system + the original question + the SDK's response messages) and
 * offers no tools, so the model must produce prose. Returns null on failure so
 * the caller falls back to a partial answer.
 */
async function forceSynthesis(
  resolved: ResolvedModel,
  systemPromptText: string,
  userText: string,
  priorMessages: ModelMessage[],
  reason: string,
  requestId: string,
  logSettings: { model: string; provider: ModelProvider; source: "default" | "custom" }
): Promise<string | null> {
  try {
    const forced = await generateText({
      model: resolved.model,
      providerOptions: resolved.providerOptions,
      ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
      maxRetries: MODEL_REQUEST_MAX_RETRIES,
      system: systemPromptText,
      messages: [
        { role: "user", content: userText },
        ...priorMessages,
        { role: "user", content: `${reason} Stop using tools and return the final result now.` }
      ],
      onStepFinish: (step) => logModelStep(requestId, logSettings, step)
    });
    return forced.text;
  } catch (error) {
    await writeDebugLog({
      event: "agent.final_turn.failed",
      level: "error",
      requestId,
      error: debugError(error)
    });
    return null;
  }
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
  const resolved = resolveModel(modelSettings);
  const logSettings = {
    model: modelSettings.model,
    provider: modelSettings.provider,
    source: modelSettings.source
  };
  await writeDebugLog({
    event: "agent.started",
    requestId,
    mode: input.mode,
    curateList: input.curateList,
    query: debugText(input.query),
    requestedDriveCount: input.driveIds.length,
    ownerSubHash: hashForDebug(ownerSub),
    modelSettingsSource: modelSettings.source,
    provider: modelSettings.provider,
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
      gradeFileRelevance(resolved, input.query, file, content, requestId, step)
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
    stopAfterToolUseReason: null,
    currentStep: 0
  };
  const curating = isCuratingRequest(input);
  // In curated mode the result is exactly the set of files the grader kept, built
  // up live as review_file runs. An empty kept set is a valid "nothing relevant"
  // result, so there is no opened-files fallback. Uncurated/synthesis runs return
  // every referenced file.
  const finalFiles = () =>
    curating ? uniqueFiles(state.keptFiles) : uniqueFiles(state.referencedFiles);
  const systemPromptText = systemPrompt(input, selectedDriveIds, budget);
  const userText = `Query: ${input.query}\nMode: ${input.mode}\nCurate list: ${input.curateList}`;
  const tools = buildAgentTools(context, state);
  const stopReason = `Agent stopped after reaching the ${budget.maxToolSteps}-step tool-use budget.`;

  await emit({
    type: "progress",
    message: `Agent started with ${selectedDriveIds.length} Drive connection(s).`
  });

  try {
    // The SDK drives the whole multi-step tool loop: it appends each assistant
    // turn (carrying reasoning, round-tripped automatically per provider) and the
    // tool results, re-prompts, and stops at the step budget. Our per-tool
    // budgets/dedup/emit and the run-resilience invariant live inside the tool
    // handlers (see buildAgentTools); state is mutated in place so a throw can
    // still finalize with whatever was gathered.
    const result = await generateText({
      model: resolved.model,
      providerOptions: resolved.providerOptions,
      ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
      maxRetries: MODEL_REQUEST_MAX_RETRIES,
      system: systemPromptText,
      messages: [{ role: "user", content: userText }],
      tools,
      toolChoice: "auto",
      stopWhen: stepCountIs(budget.maxToolSteps),
      // Set the step index before each step (so the possibly-parallel tool
      // executes can attribute their logs) and gate tools once a budget forces a
      // stop: drop search so the model winds down, but in curated mode keep
      // review_file so a promising file found just before the stop is still
      // reviewable (a review past budget just returns a skipped observation).
      prepareStep: ({ stepNumber }) => {
        state.currentStep = stepNumber;
        if (!state.stopAfterToolUseReason) return undefined;
        return { activeTools: curating ? ["review_file"] : [] };
      },
      onStepFinish: (step) => logModelStep(requestId, logSettings, step)
    });

    // List mode answers are always empty (results come from state). For synthesis,
    // use the model's text; if the loop hit the step cap mid-tool-use (no text),
    // force one tool-free turn so we still synthesize instead of returning blank.
    let finalText: string | null = result.text;
    let forcedFinalAnswer = false;
    if (input.mode === "synthesis" && !result.text.trim()) {
      finalText = await forceSynthesis(
        resolved,
        systemPromptText,
        userText,
        result.response.messages,
        stopReason,
        requestId,
        logSettings
      );
      forcedFinalAnswer = finalText !== null;
    }

    const { answer, answerFormat } =
      finalText !== null && finalText.trim()
        ? parseFinalAnswer(finalText, input.mode)
        : partialAnswer(stopReason, input.mode);
    const files = finalFiles();
    await writeDebugLog({
      event: "agent.completed",
      requestId,
      reason: result.finishReason,
      durationMs: Date.now() - startedAt,
      steps: result.steps.length,
      forcedFinalAnswer,
      searchCallCount: state.searchCallCount,
      openFileCallCount: state.openFileCallCount,
      reviewFileCallCount: state.reviewFileCallCount,
      referencedFileCount: state.referencedFiles.length,
      keptFileCount: state.keptFiles.length,
      reviewedFileCount: state.reviewedFiles.length,
      returnedFileCount: files.length,
      answerFormat,
      answerLength: answer.length
    });
    await emit({ type: "final", answer, answerFormat, files });
  } catch (error) {
    // Never discard gathered work: a throw (model error after retries, an
    // unrepairable/hallucinated tool call, a timeout) finalizes with whatever the
    // in-place state already collected — mirroring the old empty-response path.
    await writeDebugLog({
      event: "agent.run.error",
      level: "error",
      requestId,
      durationMs: Date.now() - startedAt,
      error: debugError(error)
    });
    const { answer, answerFormat } = partialAnswer(
      "The agent run ended early due to an error.",
      input.mode
    );
    const files = finalFiles();
    await writeDebugLog({
      event: "agent.completed",
      requestId,
      reason: "run_error",
      durationMs: Date.now() - startedAt,
      searchCallCount: state.searchCallCount,
      openFileCallCount: state.openFileCallCount,
      reviewFileCallCount: state.reviewFileCallCount,
      referencedFileCount: state.referencedFiles.length,
      keptFileCount: state.keptFiles.length,
      reviewedFileCount: state.reviewedFiles.length,
      returnedFileCount: files.length,
      answerFormat,
      answerLength: answer.length
    });
    await emit({ type: "final", answer, answerFormat, files });
  }
}
