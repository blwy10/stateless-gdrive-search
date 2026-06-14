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
import { listDriveConnections, type DriveConnectionSummary } from "@/lib/drive-connections";
import { MAX_FILE_CHARS, openDriveFile, searchDriveFiles, type DriveFile } from "@/lib/drive";
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
 *
 * Philosophy (see the long design thread in git history): the *normal* stop is
 * diminishing returns — we keep going while the run is still producing new useful
 * results per token spent, and stop once it isn't ({@link softProgressTokenLimit}
 * / {@link hardProgressTokenLimit}). Everything else here is a deterministic
 * *backstop* — the seatbelt for degenerate cases (a provider that doesn't report
 * token usage, a runaway examiner, an outright loop), never the thing that should
 * normally bind. We measure spend in tokens because that's the resource we care
 * about; searches and steps are bounded only as loop insurance.
 */
export type AgentBudget = {
  /**
   * Hard ceiling on model tool-use steps. A backstop only — it exists mainly
   * because it's the one limiter that still works when a provider doesn't report
   * token usage (so the token guards below can't fire). Set high so diminishing
   * returns normally stops the run long before this binds.
   */
  maxToolSteps: number;
  /**
   * Hard ceiling on `search_drive` calls. A backstop — searches are cheap (only
   * a small result list enters context), so this is set high and the
   * diminishing-returns guard normally stops searching first.
   */
  maxSearchCalls: number;
  /**
   * Cumulative-token cost seatbelt across ALL model calls in the run (the main
   * loop *and* the isolated examiner). Last-resort wind-down if the run keeps
   * spending without diminishing returns tripping (e.g. an examiner stuck
   * marking everything useful). Set high so DR is the normal stop.
   */
  maxTotalTokens: number;
  /**
   * Per-call context-window health limit: when a single model call's input
   * exceeds this many tokens, wind down. Mainly bites synthesis, which reads file
   * content into the main context; list modes keep content out of context (the
   * examiner reads it in isolation) so they rarely approach it. Set comfortably
   * below the model's actual context window.
   */
  maxContextInputTokens: number;
  /**
   * Diminishing-returns SOFT nudge: tokens spent since the result set last grew,
   * after which a corrective note is attached to tool results telling the model
   * returns are diminishing (wrap up unless it has a genuinely new angle). The
   * clock resets whenever the run produces a new useful result. This is a prompt
   * nudge, not enforcement — the model, which has the task context, decides.
   */
  softProgressTokenLimit: number;
  /**
   * Diminishing-returns HARD wind-down: tokens since the result set last grew
   * after which tools are dropped and the model must finish. The deterministic
   * floor under {@link softProgressTokenLimit}; set generously above it so the
   * model gets a window to pivot (e.g. follow a newly-discovered search term)
   * before this enforces.
   */
  hardProgressTokenLimit: number;
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
  // A file the agent encountered this run — a new search candidate, or one it
  // opened/reviewed. Streams into the UI's "files touched" disclosure (all
  // modes); in uncurated list mode it is also a result. Every emitted file is a
  // member of the `touchedFiles` audit set on the `final` event.
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
  // Terminal event. `files` is the primary result list (synthesis -> the files
  // the answer cites; curated list -> examiner-kept; uncurated list -> every
  // match); `touchedFiles` is the full audit set the agent encountered this run
  // (a superset of `files`), surfaced behind the UI's disclosure.
  | {
      type: "final";
      answer: string;
      answerFormat: "markdown" | "plain";
      files: DriveFile[];
      touchedFiles: DriveFile[];
    }
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

/**
 * Default budget, applied uniformly across modes (see the design thread: we trust
 * the model to explore widely and govern by diminishing returns, not per-mode
 * caps). Numbers are deliberately generous starting points — instrument the
 * `tokensSpent` / progress logs and tune the two `*ProgressTokenLimit`s from real
 * runs rather than treating these as load-bearing constants. Rough sizing on an
 * ~8k-token-per-file read: 32k soft ≈ ~4 unproductive examinations before a
 * nudge, 80k hard ≈ ~10 before a forced wind-down; `maxContextInputTokens` 96k
 * sits below a 128k window (lower it for smaller-window models).
 */
const UNIFORM_BUDGET: AgentBudget = {
  maxToolSteps: 100,
  maxSearchCalls: 50,
  maxTotalTokens: 1_000_000,
  maxContextInputTokens: 96_000,
  softProgressTokenLimit: 32_000,
  hardProgressTokenLimit: 80_000,
  maxToolRetries: 1
};

export const defaultAgentBudgets: Record<AgentRequest["mode"], AgentBudget> = {
  list: UNIFORM_BUDGET,
  synthesis: UNIFORM_BUDGET
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

/**
 * Build a human-readable identity for the owner of the selected Drive
 * connection(s) — `Name <email>` per connection, deduped. This anchors the
 * agent's notion of *who* "my"/"I" in the query refers to, so it can tell a
 * document that is *about* the subject apart from one the subject merely
 * authored, was sent, or is mentioned in (e.g. a reference letter they wrote for
 * a colleague — whose name must not become the subject's alias). Returns null
 * when no name/email is resolvable, in which case the prompts omit the anchor.
 * The value is content (PII), so it is only ever logged through debugText.
 */
export function describeSubjectIdentity(
  connections: DriveConnectionSummary[],
  selectedDriveIds: string[]
): string | null {
  const selected = new Set(selectedDriveIds);
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const connection of connections) {
    if (!selected.has(connection.id)) continue;
    const name = connection.driveName?.trim();
    const email = connection.driveEmail.trim();
    if (!name && !email) continue;
    const label = name && email ? `${name} <${email}>` : name || email;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels.length > 0 ? labels.join(", ") : null;
}

function basePrompt(allowedDriveIds: string[], listMode = false, subject: string | null = null) {
  // List modes read files with the isolated examiner (review_file); synthesis
  // reads them directly (open_file).
  const examineTool = listMode ? "review_file" : "open_file";
  // Smaller models occasionally fabricate a connectionId — e.g. inventing a
  // second connection even when only one exists. Spell out that ids are opaque
  // values to be copied verbatim, and when there is a single connection pin it
  // to one literal so there is nothing to "guess".
  const idRule =
    allowedDriveIds.length === 1
      ? `There is exactly one connection: every connectionId you pass must be exactly "${allowedDriveIds[0]}" — never any other value.`
      : `Every connectionId you pass must be exactly one of those IDs.`;
  // Identify the owner as a *fact* (so first-person queries resolve), and warn
  // that matching/authorship/mention is not the same as aboutness. Deliberately
  // NOT phrased as "the request is about the owner": most queries are topical, not
  // about a person, so this must stay neutral to avoid over-correcting them. The
  // aboutness caution is universally true. Omitted when no identity is resolvable.
  const subjectRule = subject
    ? `\nThe owner of the connected Drive(s) is ${subject}; treat first-person words in the query ("my", "me", "I") as referring to them.\nA file can mention, be addressed to, or be authored by a person without being about that person — for example a reference or recommendation letter someone wrote for a colleague, or a file merely shared with them. A name in a title often identifies the author or recipient, not the topic, so don't assume a file is about a person just because it matched a search or carries their name.`
    : "";
  return `You are a Google Drive research agent.

You have exactly two tools: search_drive and ${examineTool}.
You may only work with these selected Drive connection IDs: ${allowedDriveIds.join(", ")}.
Every connectionId and fileId you pass to a tool is an opaque identifier you must copy verbatim from a search_drive result — never invent, guess, modify, or take an id from a different file.
${idRule}${subjectRule}
Search broadly with varied, targeted terms. When a file you read reveals a new name, project, product, person, or term, search for that too — it often surfaces relevant files a generic query misses.
Do not repeat an identical search.
There is no fixed limit on how many times you may search or ${examineTool}: keep going while you are still finding new useful files, and stop once you are not. If a tool result tells you returns are diminishing, wrap up unless you have a genuinely new angle.
Never claim you searched outside Google Drive.
Never ask for permissions or tokens.
If evidence is weak, say that directly.`;
}

function synthesisSystemPrompt(allowedDriveIds: string[], subject: string | null) {
  // Output-side half of the entity-conflation guard. The first sentence is a
  // universal correctness rule (safe for any query, personal or topical). The
  // owner-profile behavior is GATED on the request actually being about a person,
  // so a generic/topical query is NOT forced to be "about the owner" (avoids the
  // over-correction where every answer gets filtered down to the owner).
  const subjectRule = subject
    ? `\nAttribute every fact to the correct person and keep distinct people distinct: never merge one person's name, roles, or achievements into another, and never present one person's name as an alias of another unless a source explicitly states they are the same person. When the request is specifically about a person — e.g. the Drive owner (${subject}) referred to as "my"/"me"/"I" — base the answer on facts that are actually about that person, not merely on files they authored or are mentioned in; prefer identity details corroborated across multiple sources such as CVs or resumes.`
    : "";
  return `${basePrompt(allowedDriveIds, false, subject)}

Open files whose titles look relevant; what you read can suggest new searches.
Return a concise synthesis answering the user's query.${subjectRule}
Your final response must start with exactly one format line:
FORMAT: markdown
or
FORMAT: plain
Then put the answer body after that line.
Use markdown only when headings, lists, links, or other markdown structure materially improve readability.
Never return HTML or any format other than markdown or plain.
After the answer body, cite the files you actually relied on as a trailing block: a line containing exactly SOURCES: on its own, then one line per file in the form connectionId/fileId, copying both ids verbatim from a search_drive or open_file result.
List only files whose content you used; omit the SOURCES block entirely if you relied on none. Do not list or mention the source files anywhere else in the answer body.`;
}

function listSystemPrompt(
  allowedDriveIds: string[],
  curateList: boolean,
  subject: string | null
) {
  if (curateList) {
    return `${basePrompt(allowedDriveIds, true, subject)}

Find relevant files only. Do not synthesize an answer.
For every file that looks promising from its title, call review_file with its connectionId and fileId.
review_file reads the file in isolation and judges its relevance for you: relevant files are kept in the results automatically and irrelevant ones are dropped. You do not judge relevance yourself, and there is no separate step to open or keep a file.
review_file also reports notable names, projects, or terms found in the file — use those to search for related files you would not have found from the query alone.
Only files you review can be kept, so review every promising file.
When further searches and reviews stop turning up new relevant files, stop calling tools and reply with exactly:
FORMAT: plain
DONE`;
  }

  return `${basePrompt(allowedDriveIds, true, subject)}

Return the files that match the query. Do not synthesize an answer.
Every file a search surfaces is included in the results automatically — you do not keep, mark, or judge files.
Use review_file on promising files to read them and discover related names, projects, or terms, then search for those to widen coverage.
When further searches stop surfacing new files, return exactly:
FORMAT: plain
FILE_LIST_COMPLETE`;
}

export function systemPrompt(input: AgentRequest, allowedDriveIds: string[], subject: string | null) {
  return input.mode === "synthesis"
    ? synthesisSystemPrompt(allowedDriveIds, subject)
    : listSystemPrompt(allowedDriveIds, input.curateList, subject);
}

function safeJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

/** Rough chars-per-token for the estimate-only fallback (see {@link resolveUsageTokens}). */
const CHARS_PER_TOKEN = 4;
/**
 * Calibration applied ONLY to the char-based estimate fallback, never to real
 * provider usage. char/4 tends to under-count code/structured text; bump this if
 * your no-usage endpoints consistently under-report. Default 1 (no adjustment).
 */
const TOKEN_ESTIMATE_MULTIPLIER = 1;

/** Minimal structural view of the SDK's LanguageModelUsage we read. */
type UsageLike =
  | {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      reasoningTokens?: number;
    }
  | undefined;

function estimateTokensFromText(text: string) {
  return Math.ceil((text.length / CHARS_PER_TOKEN) * TOKEN_ESTIMATE_MULTIPLIER);
}

/**
 * Resolve one model call's token cost for the run-wide total that drives the
 * diminishing-returns budget and cost seatbelt. Order of preference:
 *  1. `totalTokens` — the provider's reported total. On every provider we use this
 *     ALREADY includes reasoning/thinking tokens (they are billed as output), so
 *     we never add `reasoningTokens` on top — that would double-count.
 *  2. `inputTokens + outputTokens` — when only those are reported.
 *  3. a char-based estimate of the visible text (`estimateText`) — only when a
 *     provider reports no usage at all. Pass the assistant text AND reasoning text
 *     so "thinking" is still counted (it isn't invisible to us — it's in
 *     `reasoningText`). Only this path is scaled by TOKEN_ESTIMATE_MULTIPLIER.
 * Returns 0 when there's neither usage nor text, leaving the step backstop as the
 * floor (the documented no-usage-provider case).
 */
export function resolveUsageTokens(usage: UsageLike, estimateText = ""): number {
  if (typeof usage?.totalTokens === "number") return usage.totalTokens;
  const sum = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (sum > 0) return sum;
  return estimateText ? estimateTokensFromText(estimateText) : 0;
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

/**
 * Verdict from examining one file against the query. `reason` is a short,
 * auditable justification (surfaced in debug logs and the review_file tool
 * result), not shown to the end user. `entities` are notable, specific terms the
 * examiner found in the file (names, projects, products, people, codenames,
 * jargon) that the agent can search for to find related files — the "berry
 * picking" channel that lets discovery follow leads only knowable after reading,
 * without ever pulling file content into the main loop's context.
 */
export type GradeVerdict = { relevant: boolean; reason: string; entities: string[] };

const MAX_GRADE_REASON_CHARS = 300;
const MAX_GRADE_ENTITIES = 8;
const MAX_GRADE_ENTITY_CHARS = 60;

/** Structured verdict the examiner is asked to produce. */
const gradeSchema = z.object({
  relevant: z
    .boolean()
    .describe("True if the document would help answer or directly concerns the query."),
  reason: z.string().optional().describe("One short sentence justifying the decision."),
  entities: z
    .array(z.string())
    .optional()
    .describe(
      "Up to a few notable, specific terms from the document (names, projects, products, people, codenames, domain jargon) worth searching for to find related files. Prefer distinctive terms over generic words; return an empty list if none stand out."
    )
});

const GRADE_SYSTEM_PROMPT = `You examine a single document for a research agent.
Decide whether it is relevant to the user's search query — relevant means its content would help answer or directly concerns the query; sharing a keyword alone is not enough.
Also extract a few notable, specific terms from the document (names, projects, products, people, codenames, or domain jargon) that could be used to search for related files. Prefer distinctive terms over generic ones; if none stand out, return an empty list.`;

/**
 * Normalize the grader's structured output into a {@link GradeVerdict}: trim and
 * cap the reason, and supply a default sentence when the model omits one. Kept
 * pure (and exported) so the keep/discard + reason behaviour stays unit-testable
 * without exercising the model call.
 */
export function normalizeGradeVerdict(object: {
  relevant: boolean;
  reason?: string | null;
  entities?: (string | null)[] | null;
}): GradeVerdict {
  const reason =
    typeof object.reason === "string" && object.reason.trim()
      ? object.reason.trim().slice(0, MAX_GRADE_REASON_CHARS)
      : object.relevant
        ? "Judged relevant."
        : "Judged not relevant.";
  // Dedupe case-insensitively, trim/cap each term, and cap the count, so a noisy
  // or oversized entity list can't bloat the berry-picking channel.
  const seen = new Set<string>();
  const entities: string[] = [];
  for (const raw of object.entities ?? []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().slice(0, MAX_GRADE_ENTITY_CHARS);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push(trimmed);
    if (entities.length >= MAX_GRADE_ENTITIES) break;
  }
  return { relevant: object.relevant, reason, entities };
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
 * Examine one already-read file against the query using an isolated, single-shot
 * structured model call (`generateObject`, no tools, its own minimal prompt).
 * The file's content never enters the main agent loop's context — only the
 * verdict (relevance + a few entities) does. On any failure — the request
 * erroring out after retries, or output that fails schema validation — we KEEP
 * the file rather than abort or drop it, so a transient examiner problem degrades
 * to extra recall instead of a missing result. Logs under `agent.grade.*`,
 * distinct from the main loop's `agent.model.*`, tagged with the file it judges.
 *
 * Returns the verdict together with the call's token usage so the caller can fold
 * it into the run-wide token total that drives the diminishing-returns budget
 * (the examiner is the dominant token cost in list modes, so it must be counted).
 */
export async function gradeFileRelevance(
  resolved: ResolvedModel,
  logSettings: { model: string; provider: ModelProvider },
  query: string,
  file: DriveFile,
  content: string,
  requestId: string,
  step: number
): Promise<{ verdict: GradeVerdict; usageTokens: number }> {
  const fileKeyHash = hashForDebug(fileKey(file));
  try {
    const { object, usage } = await generateObject({
      model: resolved.model,
      providerOptions: resolved.providerOptions,
      ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
      ...(resolved.maxOutputTokens !== undefined ? { maxOutputTokens: resolved.maxOutputTokens } : {}),
      maxRetries: MODEL_REQUEST_MAX_RETRIES,
      schema: gradeSchema,
      schemaName: "FileExamination",
      schemaDescription:
        "Whether a document is relevant to the query, plus notable terms to search next.",
      system: GRADE_SYSTEM_PROMPT,
      prompt: buildGradePrompt(query, file, content)
    });
    const verdict = normalizeGradeVerdict(object);
    // Estimate basis when the provider reports no usage: the file content
    // dominates the examiner's input (the prompt scaffolding is tiny), so it's a
    // good proxy. Real usage is preferred via resolveUsageTokens.
    const usageTokens = resolveUsageTokens(usage, `${content}${verdict.reason}`);
    await writeDebugLog({
      event: "agent.grade.completed",
      requestId,
      step,
      model: logSettings.model,
      provider: logSettings.provider,
      fileKeyHash,
      relevant: verdict.relevant,
      // The examiner's justification is auditable (see GradeVerdict); surface it
      // at the metadata tier (gated via debugText) so a keep/discard decision is
      // explained even without the full DEBUG_LOG_TRANSCRIPT dump.
      reason: debugText(verdict.reason),
      entityCount: verdict.entities.length,
      usageTokens,
      totalTokens: usage?.totalTokens ?? null,
      reasoningTokens: usage?.reasoningTokens ?? null
    });
    return { verdict, usageTokens };
  } catch (error) {
    await writeDebugLog({
      event: "agent.grade.failed",
      level: "warn",
      requestId,
      step,
      model: logSettings.model,
      provider: logSettings.provider,
      fileKeyHash,
      error: debugError(error)
    });
    return {
      verdict: { relevant: true, reason: "Relevance check unavailable; kept by default.", entities: [] },
      usageTokens: 0
    };
  }
}

/**
 * Upper bound on the text fed to the summarizer in one shot. The full file can be
 * far larger than any context window (the sampling study found a p99 ~500k tokens),
 * so cap the INPUT at ~100k tokens (4 chars/token) — comfortably inside a modern
 * window alongside the prompt and the ~8k-token output. Files beyond this are
 * head-truncated before summarizing (so the extreme tail becomes a "summary of the
 * first ~100k tokens"); full map-reduce chunking is a deliberate follow-up.
 */
const MAX_SUMMARY_INPUT_CHARS = 400_000;

/**
 * Floor on the summarizer call's output budget so it can actually fill the
 * MAX_FILE_CHARS target (~8k tokens at 4 chars/token). Applied as a max() with the
 * resolved value, which only matters for Anthropic-with-thinking (where resolve
 * already sets budget + margin); every other provider has no maxOutputTokens, so
 * this becomes the explicit cap for the call.
 */
const SUMMARY_MIN_OUTPUT_TOKENS = 8192;

/** Approx token target for the summary, derived from the char cap (4 chars/token). */
const SUMMARY_TARGET_TOKENS = Math.floor(MAX_FILE_CHARS / 4);

const SUMMARIZE_SYSTEM_PROMPT = `You compress one long document for a research agent so it fits a strict size budget without losing what matters for the user's query.
Produce a faithful, query-focused condensation of the document:
- Keep everything relevant to the query; drop boilerplate, navigation chrome, and repetition.
- Preserve specific facts verbatim — names, dates, numbers, figures, quotes, identifiers, codenames, and domain terms. Never paraphrase, round, or invent these.
- Keep the document's own section order where it aids understanding.
- Add nothing that is not in the document: no interpretation, commentary, or outside knowledge.
- Do not mention that the document was long, truncated, or summarized; output only the condensation itself.
Keep the result within roughly ${SUMMARY_TARGET_TOKENS} tokens.`;

/**
 * Build the single user prompt for condensing one oversize file. A fresh, minimal
 * context — the query plus this one (input-capped) document — mirroring the
 * examiner so the call stays isolated and bounded.
 */
function buildSummarizePrompt(query: string, file: DriveFile, content: string) {
  return `Query: ${query}

File name: ${file.name}
File type: ${formatMimeType(file.mimeType)}

Document:
${content}`;
}

/**
 * Condense an oversize file's full text into the synthesis budget using an
 * isolated, single-shot model call (`generateText`, no tools, its own minimal
 * prompt). Used only by the synthesis read path (open_file), as openDriveFile's
 * summarizeOversize hook, so a file that would otherwise be hard-truncated still
 * surfaces its whole substance to synthesis. The input is capped at
 * {@link MAX_SUMMARY_INPUT_CHARS}; the output budget is floored so the summary can
 * reach the {@link MAX_FILE_CHARS} target (drive.ts re-caps defensively).
 *
 * On any failure — the request erroring out after retries, or an empty/blank
 * result — returns `{ summary: null }` so the caller falls back to hard truncation
 * rather than aborting the run (truncation is the safe, pre-existing behaviour).
 * Logs under `agent.summarize.*`, distinct from the main loop and the examiner.
 *
 * Returns the summary together with the call's token usage so the caller can fold
 * it into the run-wide token total that drives the diminishing-returns budget.
 */
export async function summarizeOversizeContent(
  resolved: ResolvedModel,
  logSettings: { model: string; provider: ModelProvider },
  query: string,
  file: DriveFile,
  fullText: string,
  requestId: string,
  step: number
): Promise<{ summary: string | null; usageTokens: number }> {
  const fileKeyHash = hashForDebug(fileKey(file));
  const input = fullText.slice(0, MAX_SUMMARY_INPUT_CHARS);
  const inputTruncated = fullText.length > MAX_SUMMARY_INPUT_CHARS;
  try {
    const { text, usage } = await generateText({
      model: resolved.model,
      providerOptions: resolved.providerOptions,
      ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
      // Always set an output cap so the summary can reach the ~8k-token target,
      // overriding small provider defaults (see SUMMARY_MIN_OUTPUT_TOKENS).
      maxOutputTokens: Math.max(resolved.maxOutputTokens ?? 0, SUMMARY_MIN_OUTPUT_TOKENS),
      maxRetries: MODEL_REQUEST_MAX_RETRIES,
      system: SUMMARIZE_SYSTEM_PROMPT,
      prompt: buildSummarizePrompt(query, file, input)
    });
    const summary = text.trim() ? text.trim() : null;
    // The file content dominates the summarizer's input, so it's a good estimate
    // basis when the provider reports no usage. Real usage preferred.
    const usageTokens = resolveUsageTokens(usage, `${input}${summary ?? ""}`);
    await writeDebugLog({
      event: "agent.summarize.completed",
      requestId,
      step,
      model: logSettings.model,
      provider: logSettings.provider,
      fileKeyHash,
      rawContentLength: fullText.length,
      summaryInputLength: input.length,
      inputTruncated,
      summaryLength: summary?.length ?? 0,
      summarized: summary !== null,
      usageTokens,
      totalTokens: usage?.totalTokens ?? null,
      reasoningTokens: usage?.reasoningTokens ?? null
    });
    return { summary, usageTokens };
  } catch (error) {
    await writeDebugLog({
      event: "agent.summarize.failed",
      level: "warn",
      requestId,
      step,
      model: logSettings.model,
      provider: logSettings.provider,
      fileKeyHash,
      rawContentLength: fullText.length,
      error: debugError(error)
    });
    // Fall back to hard truncation (the pre-existing behaviour) rather than abort.
    return { summary: null, usageTokens: 0 };
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

/**
 * Build a short corrective note for a `search_drive` observation in the two cases
 * worth flagging even under the cheap-search philosophy: an *exact* repeat (pure
 * token waste, zero chance of new information) and a query that matched *nothing*
 * (the model should vary terms). Overlap with already-seen files is deliberately
 * NOT flagged here — searches are cheap and an overlapping query is often the
 * model triangulating toward a new angle; whether returns are diminishing is
 * judged holistically by {@link diminishingReturnsNote} over tokens, not by any
 * single search's novelty. Returns null otherwise.
 */
function searchResultNote(wasRepeatedQuery: boolean, totalResultCount: number): string | null {
  if (wasRepeatedQuery) {
    return "This is the exact query you already ran — do not repeat it. To find more, search with different terms: a related name, project, or term you have learned, a synonym, or a single distinctive keyword. Otherwise finish with the files found so far.";
  }
  if (totalResultCount === 0) {
    return "This query matched no files. Try different terms: synonyms, a broader phrasing, or a single distinctive keyword.";
  }
  return null;
}

/**
 * Tokens spent since the run last produced a new useful result (a kept file in
 * curated mode, or a newly-surfaced/read file otherwise). This is the
 * diminishing-returns signal, denominated in the resource we actually care about
 * (tokens) rather than a step or call count.
 */
function tokensSinceProgress(state: AgentRunState) {
  return state.tokensSpent - state.tokensAtLastProgress;
}

/**
 * Mark that the run's result set just grew, resetting the diminishing-returns
 * clock. Called wherever a new useful result is recorded so a productive run
 * keeps going and only a genuine plateau in useful output trips the guard.
 */
function recordUsefulProgress(state: AgentRunState) {
  state.tokensAtLastProgress = state.tokensSpent;
}

/**
 * Diminishing-returns SOFT nudge, attached to tool results once
 * {@link AgentBudget.softProgressTokenLimit} tokens have been spent without the
 * result set growing. A prompt-time hint, not enforcement — it deliberately also
 * tells the model it may stop, and explicitly preserves the berry-picking escape
 * hatch (a genuinely new angle), so it nudges toward wrapping up without killing
 * a productive pivot. The hard floor lives in {@link evaluateTokenBudget}.
 */
function diminishingReturnsNote(state: AgentRunState, budget: AgentBudget): string | null {
  if (tokensSinceProgress(state) >= budget.softProgressTokenLimit) {
    return "Returns are diminishing: recent work has not produced new useful results. Wrap up and answer with what you have, unless you have a genuinely new angle to search (e.g. a name, project, or term you just learned).";
  }
  return null;
}

/** Join a search-specific note with the diminishing-returns nudge, if either fires. */
function combineNotes(...notes: (string | null)[]): string | null {
  const joined = notes.filter((note): note is string => Boolean(note)).join(" ");
  return joined || null;
}

/**
 * Evaluate the token-based budget guards before a step and set the matching stop
 * reason on `state`. Diminishing returns (tokens since the result set last grew)
 * is the primary, normal stop; the cumulative-token seatbelt and per-call
 * context-window limit are backstops. All three set `windDownReason` (drop every
 * tool and finish) — they mean "stop spending", not "stop searching". The
 * `stopSearchingReason` (search-call backstop) is set in the search handler
 * instead, so a search plateau stops searching while still letting the model
 * finish reading/examining what it already found.
 */
function evaluateTokenBudget(state: AgentRunState, budget: AgentBudget) {
  if (state.windDownReason) return;
  if (state.tokensSpent >= budget.maxTotalTokens) {
    state.windDownReason = `Total-token seatbelt reached (${state.tokensSpent} tokens).`;
    return;
  }
  if (state.lastInputTokens >= budget.maxContextInputTokens) {
    state.windDownReason = `Context-window limit reached (${state.lastInputTokens} input tokens in one call).`;
    return;
  }
  if (tokensSinceProgress(state) >= budget.hardProgressTokenLimit) {
    state.windDownReason = `Diminishing returns: ${tokensSinceProgress(state)} tokens spent with no new useful results.`;
  }
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

/** A source citation the synthesis model emits in its trailing `SOURCES:` block. */
export type SourceCitation = { connectionId: string; fileId: string };

/**
 * Split a synthesis answer into its prose body and the structured source
 * citations the model lists in a trailing `SOURCES:` block (it is instructed to
 * end with one — see {@link synthesisSystemPrompt}). The block starts at a line
 * that is just `SOURCES:` (case-insensitive, an optional `-`/`*` bullet
 * tolerated, must be alone on its line so prose like "the sources: a, b" is not
 * mistaken for it) and runs to the end of the text; each following non-empty
 * line is a `connectionId/fileId` pair (leading bullet tolerated, split on the
 * first `/` — Drive ids contain no slash). The block is stripped from the
 * returned `body` so the UI renders structured source cards instead of a
 * duplicated prose list. Unparseable lines are skipped and citations are deduped;
 * with no block the body is returned unchanged and the citation list is empty.
 * Only meaningful for synthesis (list modes have no answer body).
 */
export function parseSources(answer: string): { body: string; citations: SourceCitation[] } {
  const match = answer.match(/(?:^|\n)[ \t]*(?:[-*]\s*)?SOURCES:[ \t]*\n?([\s\S]*)$/i);
  if (!match) return { body: answer.trim(), citations: [] };
  const body = answer.slice(0, match.index).trim();
  const citations: SourceCitation[] = [];
  const seen = new Set<string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const entry = line.trim().replace(/^[-*]\s*/, "");
    if (!entry) continue;
    const slash = entry.indexOf("/");
    if (slash <= 0 || slash >= entry.length - 1) continue;
    const connectionId = entry.slice(0, slash).trim();
    const fileId = entry.slice(slash + 1).trim();
    if (!connectionId || !fileId) continue;
    const dedupeKey = `${connectionId}:${fileId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    citations.push({ connectionId, fileId });
  }
  return { body, citations };
}

/**
 * Resolve a synthesis answer's source citations to full {@link DriveFile}s for
 * display, looking each `connectionId/fileId` up among the files the agent
 * actually encountered this run (`touched`). Citations the agent never saw are
 * dropped — the hallucination guard, so a fabricated id can't show up as a
 * "source". If nothing resolves (the model omitted the block, or only cited
 * unknown ids) we fall back to the files it opened: the best available proxy for
 * "relied on", so a synthesis that read files never shows a sourceless result.
 * Returns a deduped list.
 */
export function resolveSources(
  citations: SourceCitation[],
  touched: DriveFile[],
  opened: DriveFile[]
): DriveFile[] {
  const byKey = new Map(touched.map((file) => [fileKey(file), file] as const));
  const resolved: DriveFile[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    const key = fileKey({ connectionId: citation.connectionId, id: citation.fileId });
    const matched = byKey.get(key);
    if (!matched || seen.has(key)) continue;
    seen.add(key);
    resolved.push(matched);
  }
  return resolved.length > 0 ? resolved : uniqueFiles(opened);
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
  /**
   * Synthesis only: condense a file whose extracted text exceeds MAX_FILE_CHARS
   * into the synthesis budget (returns null to fall back to hard truncation).
   * Wired into open_file's openDriveFile call as its summarizeOversize hook;
   * review_file omits it (list mode keeps truncation). Injected like gradeFile so
   * it is an isolated model call in production but stubbable in tests; folds its
   * token usage into the run total. `step` is forwarded for log correlation.
   */
  summarizeOversize: (file: DriveFile, fullText: string, step: number) => Promise<string | null>;
};

/**
 * Mutable per-run state threaded through the tool handlers. Handlers update
 * these counters/collections in place; the main loop reads them to make
 * budget/stop decisions and to assemble the final result.
 */
export type AgentRunState = {
  /**
   * Every file the agent encountered this run — search candidates plus any it
   * opened or reviewed — across all modes. The audit/"touched" set surfaced in
   * the UI's disclosure, and the superset the synthesis citation resolver
   * ({@link resolveSources}) looks cited files up in. Deduped via
   * {@link touchedFileKeys}; appended (and streamed as a `file` event) by
   * {@link recordTouched}.
   */
  touchedFiles: DriveFile[];
  openedFiles: DriveFile[];
  /**
   * List modes: every file run through the examiner. Tracked for visibility/
   * logging; in curated mode the kept subset is the result (`keptFiles`).
   */
  reviewedFiles: DriveFile[];
  /**
   * Curated list mode only: files the examiner judged relevant. This is the
   * authoritative curated result, populated live as the run progresses.
   */
  keptFiles: DriveFile[];
  searchedQueries: Set<string>;
  knownFileKeys: Set<string>;
  /** Dedupe set backing {@link touchedFiles} (the audit/disclosure set). */
  touchedFileKeys: Set<string>;
  openedFileKeys: Set<string>;
  reviewedFileKeys: Set<string>;
  keptFileKeys: Set<string>;
  searchCallCount: number;
  openFileCallCount: number;
  reviewFileCallCount: number;
  /**
   * Cumulative tokens across every model call in the run — the main loop (folded
   * in by `onStepFinish`) and the isolated examiner (folded in by the `gradeFile`
   * closure). The unit the diminishing-returns budget and the cost seatbelt are
   * measured in.
   */
  tokensSpent: number;
  /**
   * Value of {@link tokensSpent} when the result set last grew. `tokensSpent`
   * minus this is the diminishing-returns signal (see {@link tokensSinceProgress}).
   */
  tokensAtLastProgress: number;
  /**
   * Input tokens of the most recent model step, used for the per-call
   * context-window health guard (mainly synthesis). Updated in `onStepFinish`.
   */
  lastInputTokens: number;
  /**
   * Set when searching should stop (the search-call backstop) but reading/
   * examining may continue. `prepareStep` drops `search_drive` while keeping the
   * read tool, so the model can still finish with the files it already found.
   */
  stopSearchingReason: string | null;
  /**
   * Set when the run should wind down entirely (diminishing-returns hard limit,
   * cost seatbelt, or context-window limit). `prepareStep` drops every tool so
   * the model must produce its final result.
   */
  windDownReason: string | null;
  /**
   * Zero-based index of the step currently executing, set by `prepareStep`
   * before each step so the tool handlers (which the SDK may run in parallel
   * within a step) can attribute their debug logs to the right step.
   */
  currentStep: number;
};

/**
 * Record a file in the run's "touched" set — the audit/disclosure list shown in
 * the UI and the lookup table for {@link resolveSources} — exactly once, and
 * stream it as a `file` event. Idempotent via
 * {@link AgentRunState.touchedFileKeys}: a file surfaced by several searches (or
 * surfaced and later opened/reviewed) is tracked and emitted a single time.
 * Touched is a superset of every per-mode result list (see the `file`/`final`
 * events on {@link AgentProgress}).
 */
async function recordTouched(
  state: AgentRunState,
  file: DriveFile,
  emit: AgentRunContext["emit"]
) {
  const key = fileKey(file);
  if (state.touchedFileKeys.has(key)) return;
  state.touchedFileKeys.add(key);
  state.touchedFiles.push(file);
  await emit({ type: "file", file });
}

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
    const reason = `Search backstop reached after ${state.searchCallCount} search_drive call(s).`;
    await emit({ type: "progress", message: reason });
    await writeDebugLog({
      event: "agent.tool.search_drive.skipped",
      level: "warn",
      requestId,
      step,
      reason: "search_backstop_reached",
      searchCallCount: state.searchCallCount
    });
    // Stop *searching* but let the model keep reading/examining what it found.
    state.stopSearchingReason = reason;
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
  // Record every newly-seen file in the run's "touched" set and stream it to the
  // UI (all modes — touched is the audit/disclosure list). Surfacing a candidate
  // counts as "useful progress" (resetting the diminishing-returns clock) only
  // when surfaced files ARE the result: non-curated runs (synthesis/uncurated)
  // return what searches surface, while curated returns only examiner-kept
  // files, so a bare search hit there is a candidate, not progress.
  if (newFiles.length > 0) {
    for (const file of newFiles) {
      await recordTouched(state, file, emit);
    }
    if (!input.curateList) recordUsefulProgress(state);
  }
  const note = combineNotes(
    searchResultNote(wasRepeatedQuery, files.length),
    diminishingReturnsNote(state, budget)
  );
  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content: safeJson(note ? { files, note } : { files })
  };
}

/**
 * Handle a single `open_file` tool call (synthesis only): enforce drive scope,
 * dedupe already-opened files, read the file, and emit progress. There is no
 * open-count budget — reading is governed by diminishing returns and the
 * per-call context-window guard. Mutates {@link state} in place and returns the
 * tool message to append.
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
  const { requestId, budget, selectedDriveIds, ownerSub, emit, summarizeOversize } = context;
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
  // No open-count budget: reading is governed by diminishing returns and the
  // per-call context-window guard (open_file pulls file content into the main
  // context, so synthesis is bounded by maxContextInputTokens), not a fixed cap.
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
          debugRequestId: requestId,
          // Synthesis reads pull content straight into context, so condense an
          // oversize file instead of dropping its tail (list-mode review_file
          // omits this hook and keeps truncation). Returns null -> truncation.
          summarizeOversize: ({ file, fullText }) => summarizeOversize(file, fullText, step)
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
  // open_file is offered only in synthesis (list modes examine via review_file).
  // An opened file belongs to the run's touched set (recordTouched is idempotent,
  // so a file already surfaced by a prior search is not double-tracked or
  // re-emitted), and reading a new file is useful progress that resets the
  // diminishing-returns clock. Whether it becomes a *result* is decided at the
  // end by the model's citations (see resolveSources), not by opening alone.
  recordUsefulProgress(state);
  await emit({ type: "progress", message: `Opened ${formatFileProgressLabel(opened.file)}` });
  await recordTouched(state, opened.file, emit);
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
 * Handle a single `review_file` tool call (both list modes): open a candidate
 * file, examine it in an isolated model call, and return a compact verdict
 * (relevance + entities). Unlike open_file, the file's content is never returned
 * into the main loop's context — only the verdict — so the conversation stays
 * small however many files are examined, and the extracted entities feed the
 * berry-picking search loop.
 *
 * Curated mode additionally keeps the file iff the examiner judged it relevant
 * (emitting the provisional `reviewing` -> `kept`/`discarded` sequence the UI
 * shows). Uncurated mode returns every match regardless, so it only examines for
 * entities and emits a neutral progress line. Mirrors open_file's guards
 * (out-of-scope connectionId, dedupe, open failure) as recoverable observations
 * rather than throws, so a single bad file never aborts the run.
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
      content: safeJson({ examined: true, alreadyExamined: true })
    };
  }
  // No review-count budget: examining is governed by diminishing returns (the
  // examiner's token usage is folded into the run total) and the cost seatbelt.

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
  const curating = isCuratingRequest(context.input);
  state.knownFileKeys.add(openedKey);
  state.reviewedFileKeys.add(openedKey);
  state.reviewedFiles.push(opened.file);
  // A reviewed file is part of the touched set too. In practice it was already a
  // search candidate (so this is a no-op), but recording it here keeps the
  // invariant "everything the agent read is touched" even for any edge path.
  await recordTouched(state, opened.file, emit);
  // The provisional `reviewing` -> `kept`/`discarded` event sequence is a curated
  // UI concept (it shows files being filtered live). Uncurated returns every match
  // regardless, so it only emits a neutral "Examining" progress line.
  if (curating) {
    await emit({ type: "progress", message: `Reviewing ${formatFileProgressLabel(opened.file)}` });
    await emit({ type: "reviewing", file: opened.file });
  } else {
    await emit({ type: "progress", message: `Examining ${formatFileProgressLabel(opened.file)}` });
  }

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
    // The examiner's justification is meant to be auditable (see GradeVerdict);
    // surface it here at the metadata tier (gated like other model-derived text
    // via debugText) so a keep/discard decision is explained even without the
    // full DEBUG_LOG_TRANSCRIPT dump.
    reason: debugText(verdict.reason),
    entityCount: verdict.entities.length,
    curating,
    reviewFileCallCount: state.reviewFileCallCount,
    keptFileCount: state.keptFiles.length
  });

  // Only curated mode keeps/discards by relevance; in uncurated the file is
  // already a result (surfaced at search time). Keeping a new file is useful
  // progress that resets the diminishing-returns clock.
  if (curating) {
    if (verdict.relevant) {
      if (!state.keptFileKeys.has(openedKey)) {
        state.keptFileKeys.add(openedKey);
        state.keptFiles.push(opened.file);
        recordUsefulProgress(state);
      }
      await emit({ type: "progress", message: `Kept ${formatFileProgressLabel(opened.file)}` });
      await emit({ type: "kept", file: opened.file });
    } else {
      await emit({ type: "progress", message: `Discarded ${formatFileProgressLabel(opened.file)}` });
      await emit({ type: "discarded", file: opened.file });
    }
  }

  // Surface the verdict and — the berry-picking channel — the extracted entities
  // back to the model so it can search for related files. The file's CONTENT is
  // never returned into the main loop's context, only this compact verdict.
  const drNote = diminishingReturnsNote(state, budget);
  const payload = {
    examined: true,
    relevant: verdict.relevant,
    reason: verdict.reason,
    entities: verdict.entities
  };
  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content: safeJson(drNote ? { ...payload, note: drNote } : payload)
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
 * Build the AI SDK tool set for a run, closing over its context and state. Both
 * list modes (curated and uncurated) use `review_file`, which examines files in
 * isolation so content never enters this loop's context; synthesis uses
 * `open_file`, which reads content directly into context for synthesis. Each tool
 * defers to its tested handler via {@link runToolHandler}.
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
      ...(resolved.maxOutputTokens !== undefined ? { maxOutputTokens: resolved.maxOutputTokens } : {}),
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
  const resolvedMain = resolveModel(modelSettings.main);
  const resolvedGrader = resolveModel(modelSettings.grader);
  const resolvedSummarizer = resolveModel(modelSettings.summarizer);
  const logSettings = {
    model: modelSettings.main.model,
    provider: modelSettings.main.provider,
    source: modelSettings.main.source
  };
  const graderLogSettings = {
    model: modelSettings.grader.model,
    provider: modelSettings.grader.provider,
    source: modelSettings.grader.source
  };
  const summarizerLogSettings = {
    model: modelSettings.summarizer.model,
    provider: modelSettings.summarizer.provider,
    source: modelSettings.summarizer.source
  };
  await writeDebugLog({
    event: "agent.started",
    requestId,
    mode: input.mode,
    curateList: input.curateList,
    query: debugText(input.query),
    requestedDriveCount: input.driveIds.length,
    ownerSubHash: hashForDebug(ownerSub),
    modelSettingsSource: modelSettings.main.source,
    provider: modelSettings.main.provider,
    model: modelSettings.main.model,
    // Reasoning effort is a coarse enum (not content/PII), so it's logged plainly.
    reasoningEffort: modelSettings.main.reasoningEffort,
    graderModelSettingsSource: modelSettings.grader.source,
    graderProvider: modelSettings.grader.provider,
    graderModel: modelSettings.grader.model,
    graderReasoningEffort: modelSettings.grader.reasoningEffort,
    summarizerModelSettingsSource: modelSettings.summarizer.source,
    summarizerProvider: modelSettings.summarizer.provider,
    summarizerModel: modelSettings.summarizer.model,
    summarizerReasoningEffort: modelSettings.summarizer.reasoningEffort,
    budget
  });

  const connections = await listDriveConnections(ownerSub);
  const allowed = new Set(connections.map((connection) => connection.id));
  const selectedDriveIds = input.driveIds.includes("all")
    ? connections.map((connection) => connection.id)
    : input.driveIds.filter((id) => allowed.has(id));
  // Who "my"/"I" in the query refers to — anchored into the system prompt so the
  // model can tell documents *about* the owner from ones merely authored by /
  // mentioning them (see describeSubjectIdentity / basePrompt).
  const subjectIdentity = describeSubjectIdentity(connections, selectedDriveIds);

  await writeDebugLog({
    event: "agent.connections.selected",
    requestId,
    availableConnectionCount: connections.length,
    selectedConnectionCount: selectedDriveIds.length,
    selectedConnectionIdHashes: selectedDriveIds.map(hashForDebug),
    subjectIdentity: subjectIdentity ? debugText(subjectIdentity) : null
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

  const state: AgentRunState = {
    touchedFiles: [],
    openedFiles: [],
    reviewedFiles: [],
    keptFiles: [],
    searchedQueries: new Set<string>(),
    knownFileKeys: new Set<string>(),
    touchedFileKeys: new Set<string>(),
    openedFileKeys: new Set<string>(),
    reviewedFileKeys: new Set<string>(),
    keptFileKeys: new Set<string>(),
    searchCallCount: 0,
    openFileCallCount: 0,
    reviewFileCallCount: 0,
    tokensSpent: 0,
    tokensAtLastProgress: 0,
    lastInputTokens: 0,
    stopSearchingReason: null,
    windDownReason: null,
    currentStep: 0
  };
  const context: AgentRunContext = {
    ownerSub,
    input,
    budget,
    selectedDriveIds,
    requestId,
    emit,
    // Fold the isolated examiner's token usage into the run-wide total (it's the
    // dominant token cost in list modes), then hand the verdict to the handler.
    gradeFile: async (file, content, step) => {
      const { verdict, usageTokens } = await gradeFileRelevance(
        resolvedGrader,
        graderLogSettings,
        input.query,
        file,
        content,
        requestId,
        step
      );
      state.tokensSpent += usageTokens;
      return verdict;
    },
    // Fold the isolated summarizer's token usage into the run-wide total (one
    // call per oversize file opened during synthesis), then hand the summary (or
    // null = fall back to truncation) to openDriveFile's hook.
    summarizeOversize: async (file, fullText, step) => {
      const { summary, usageTokens } = await summarizeOversizeContent(
        resolvedSummarizer,
        summarizerLogSettings,
        input.query,
        file,
        fullText,
        requestId,
        step
      );
      state.tokensSpent += usageTokens;
      return summary;
    }
  };
  const curating = isCuratingRequest(input);
  const listMode = input.mode === "list";
  // Assemble the terminal payload from the parsed answer. Two file lists:
  //  - `files` (primary result): synthesis -> the files the answer cites
  //    (resolved from the SOURCES block via resolveSources, falling back to
  //    opened files); curated list -> examiner-kept files (an empty set is a
  //    valid "nothing relevant"); uncurated list -> every touched file (all
  //    matches).
  //  - `touchedFiles` (audit/disclosure): every file the agent encountered.
  // For synthesis the SOURCES block is also stripped from the answer body so the
  // UI shows structured source cards instead of a duplicated prose list.
  const buildResult = (parsed: { answer: string; answerFormat: "markdown" | "plain" }) => {
    let answer = parsed.answer;
    let files: DriveFile[];
    if (input.mode === "synthesis") {
      const parsedSources = parseSources(answer);
      answer = parsedSources.body;
      files = resolveSources(parsedSources.citations, state.touchedFiles, state.openedFiles);
    } else {
      files = curating ? uniqueFiles(state.keptFiles) : uniqueFiles(state.touchedFiles);
    }
    return {
      answer,
      answerFormat: parsed.answerFormat,
      files,
      touchedFiles: uniqueFiles(state.touchedFiles)
    };
  };
  const systemPromptText = systemPrompt(input, selectedDriveIds, subjectIdentity);
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
      model: resolvedMain.model,
      providerOptions: resolvedMain.providerOptions,
      ...(resolvedMain.temperature !== undefined ? { temperature: resolvedMain.temperature } : {}),
      ...(resolvedMain.maxOutputTokens !== undefined ? { maxOutputTokens: resolvedMain.maxOutputTokens } : {}),
      maxRetries: MODEL_REQUEST_MAX_RETRIES,
      system: systemPromptText,
      messages: [{ role: "user", content: userText }],
      tools,
      toolChoice: "auto",
      // maxToolSteps is only the loop-insurance backstop; diminishing returns and
      // the token guards (evaluated in prepareStep) are the normal stop.
      stopWhen: stepCountIs(budget.maxToolSteps),
      // Before each step: record the step index (so possibly-parallel tool
      // executes attribute their logs), evaluate the token-based budget guards,
      // then gate tools. A hard wind-down (diminishing-returns limit, cost
      // seatbelt, or context-window limit) drops every tool so the model must
      // finish; a search backstop drops only search_drive, leaving the read tool
      // so the model can finish with the files it already found.
      prepareStep: ({ stepNumber }) => {
        state.currentStep = stepNumber;
        evaluateTokenBudget(state, budget);
        if (state.windDownReason) return { activeTools: [] };
        if (state.stopSearchingReason) {
          return { activeTools: listMode ? ["review_file"] : ["open_file"] };
        }
        return undefined;
      },
      onStepFinish: (step) => {
        // Fold each main-loop step's tokens into the run total (drives the
        // diminishing-returns budget and cost seatbelt), estimating from the
        // visible text + reasoning when a provider reports no usage. The
        // context-window guard tracks raw input tokens only (never an estimate or
        // fudge) and simply doesn't fire when the provider omits them — the step
        // backstop carries the run then (see AgentBudget docs).
        state.tokensSpent += resolveUsageTokens(
          step.usage,
          `${step.text ?? ""}${step.reasoningText ?? ""}`
        );
        if (typeof step.usage?.inputTokens === "number") {
          state.lastInputTokens = step.usage.inputTokens;
        }
        return logModelStep(requestId, logSettings, step);
      }
    });

    // List mode answers are always empty (results come from state). For synthesis,
    // use the model's text; if the loop hit the step cap mid-tool-use (no text),
    // force one tool-free turn so we still synthesize instead of returning blank.
    let finalText: string | null = result.text;
    let forcedFinalAnswer = false;
    if (input.mode === "synthesis" && !result.text.trim()) {
      finalText = await forceSynthesis(
        resolvedMain,
        systemPromptText,
        userText,
        result.response.messages,
        stopReason,
        requestId,
        logSettings
      );
      forcedFinalAnswer = finalText !== null;
    }

    const { answer, answerFormat, files, touchedFiles } = buildResult(
      finalText !== null && finalText.trim()
        ? parseFinalAnswer(finalText, input.mode)
        : partialAnswer(stopReason, input.mode)
    );
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
      touchedFileCount: state.touchedFiles.length,
      keptFileCount: state.keptFiles.length,
      reviewedFileCount: state.reviewedFiles.length,
      returnedFileCount: files.length,
      tokensSpent: state.tokensSpent,
      windDownReason: state.windDownReason,
      stopSearchingReason: state.stopSearchingReason,
      answerFormat,
      answerLength: answer.length
    });
    await emit({ type: "final", answer, answerFormat, files, touchedFiles });
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
    const { answer, answerFormat, files, touchedFiles } = buildResult(
      partialAnswer("The agent run ended early due to an error.", input.mode)
    );
    await writeDebugLog({
      event: "agent.completed",
      requestId,
      reason: "run_error",
      durationMs: Date.now() - startedAt,
      searchCallCount: state.searchCallCount,
      openFileCallCount: state.openFileCallCount,
      reviewFileCallCount: state.reviewFileCallCount,
      touchedFileCount: state.touchedFiles.length,
      keptFileCount: state.keptFiles.length,
      reviewedFileCount: state.reviewedFiles.length,
      returnedFileCount: files.length,
      tokensSpent: state.tokensSpent,
      answerFormat,
      answerLength: answer.length
    });
    await emit({ type: "final", answer, answerFormat, files, touchedFiles });
  }
}
