// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { DriveFile } from "@/lib/drive";

/**
 * Retry attempts for a failed model call, passed to the AI SDK as `maxRetries`.
 * The SDK retries only transient failures (network errors, timeouts, HTTP 5xx,
 * and 429) with exponential backoff and never retries 4xx — matching the policy
 * the old hand-rolled `callModel` enforced. The per-request timeout now lives in
 * the SSRF-safe fetch wrapper (see lib/model-provider.ts).
 */
export const MODEL_REQUEST_MAX_RETRIES = 2;

const AgentRequest = z.object({
  query: z.string().trim().min(1).max(2000),
  mode: z.enum(["list", "synthesis"]),
  driveIds: z.array(z.string().min(1)).min(1).max(20),
  curateList: z.boolean().optional().default(false)
});

export type AgentRequest = z.infer<typeof AgentRequest>;

/**
 * Minimal OpenAI-style tool-call shape used only to bridge the AI SDK's parsed
 * tool input into the existing tool handlers, which were written against this
 * shape and remain the tested, run-resilient core of the agent. The SDK now
 * validates and routes tool calls itself; this is just the adapter currency (see
 * {@link buildAgentTools}). Reasoning round-trip and the assistant/tool message
 * bookkeeping that the old loop did by hand are handled inside the SDK.
 */
export type ToolCall = {
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
export type ToolResultMessage = { role: "tool"; tool_call_id: string; content: string };

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

export const searchArgs = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).optional()
});

export const openArgs = z.object({
  connectionId: z.string().min(1),
  fileId: z.string().min(1)
});

export const reviewArgs = z.object({
  connectionId: z.string().min(1),
  fileId: z.string().min(1)
});

export function isCuratingRequest(input: AgentRequest) {
  return input.mode === "list" && input.curateList;
}

export function parseAgentRequest(value: unknown) {
  return AgentRequest.parse(value);
}
