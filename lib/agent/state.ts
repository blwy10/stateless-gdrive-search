// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import type { DriveFile } from "@/lib/drive";
import type { AgentBudget, AgentProgress, AgentRequest } from "./types";
import type { GradeVerdict } from "./examiner";
import { fileKey } from "./files";

/**
 * A run-scoped, deduplicated collection of {@link DriveFile}s keyed by
 * connection+file id. Encapsulates the (Set of keys, array of files) pairing the
 * run state previously repeated four times by hand. Supports a two-phase
 * {@link FileSet.claim} -> {@link FileSet.collect} for the open/review handlers,
 * which must reserve a file's key synchronously (before the async fetch) so two
 * parallel tool calls for the same file can't both proceed, then attach the
 * fetched object once it arrives. When the file object is already in hand
 * (touched/kept), {@link FileSet.add} does both at once.
 */
export class FileSet {
  private readonly keys = new Set<string>();
  private readonly files: DriveFile[] = [];

  /** True if a file with this key has already been seen (claimed or collected). */
  has(file: Pick<DriveFile, "connectionId" | "id">): boolean {
    return this.keys.has(fileKey(file));
  }

  /** Number of collected file objects. */
  get size(): number {
    return this.files.length;
  }

  /** A defensive copy of the collected files, in insertion order. */
  list(): DriveFile[] {
    return [...this.files];
  }

  /**
   * Reserve a file's key synchronously, before its object is available. Returns
   * true if newly claimed, false if the key was already seen — the race-safe
   * claim the open/review handlers make before their async fetch.
   */
  claim(file: Pick<DriveFile, "connectionId" | "id">): boolean {
    const key = fileKey(file);
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }

  /** Store a fetched file object (its key must already be {@link FileSet.claim}ed). */
  collect(file: DriveFile): void {
    this.files.push(file);
  }

  /**
   * Claim and collect a file in one step, for when the object is already in hand.
   * Returns true if it was newly added, false if its key was already seen.
   */
  add(file: DriveFile): boolean {
    if (!this.claim(file)) return false;
    this.collect(file);
    return true;
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
   * ({@link resolveSources}) looks cited files up in. Appended (and streamed as a
   * `file` event) by {@link recordTouched}.
   */
  touched: FileSet;
  /** Synthesis only: files opened with open_file (the {@link resolveSources} fallback). */
  opened: FileSet;
  /**
   * List modes: every file run through the examiner. Tracked for visibility/
   * logging; in curated mode the kept subset ({@link AgentRunState.kept}) is the result.
   */
  reviewed: FileSet;
  /**
   * Curated list mode only: files the examiner judged relevant. This is the
   * authoritative curated result, populated live as the run progresses.
   */
  kept: FileSet;
  /**
   * Curated list mode only: the examiner verdict for each kept file, keyed by
   * {@link fileKey}. Retained (the verdict is otherwise only logged and returned
   * to the model) so the terminal reranker can order the kept set on the
   * already-computed `reason`/`entities`/`aboutSubject` — see lib/agent/ranker.ts.
   */
  keptVerdicts: Map<string, GradeVerdict>;
  /** Keys of every file seen in any search result, for the new-results diff. */
  knownFileKeys: Set<string>;
  searchedQueries: Set<string>;
  searchCallCount: number;
  openFileCallCount: number;
  reviewFileCallCount: number;
  listFolderCallCount: number;
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
 * Construct a fresh, empty {@link AgentRunState} for a single run: every counter
 * at zero, every collection empty, no stop reason set. The one place the run's
 * initial state is shaped, so {@link runDriveAgent} stays a readable orchestration.
 */
export function createRunState(): AgentRunState {
  return {
    touched: new FileSet(),
    opened: new FileSet(),
    reviewed: new FileSet(),
    kept: new FileSet(),
    keptVerdicts: new Map<string, GradeVerdict>(),
    knownFileKeys: new Set<string>(),
    searchedQueries: new Set<string>(),
    searchCallCount: 0,
    openFileCallCount: 0,
    reviewFileCallCount: 0,
    listFolderCallCount: 0,
    tokensSpent: 0,
    tokensAtLastProgress: 0,
    lastInputTokens: 0,
    stopSearchingReason: null,
    windDownReason: null,
    currentStep: 0
  };
}

/**
 * Record a file in the run's "touched" set — the audit/disclosure list shown in
 * the UI and the lookup table for {@link resolveSources} — exactly once, and
 * stream it as a `file` event. Idempotent via the touched {@link FileSet}: a
 * file surfaced by several searches (or surfaced and later opened/reviewed) is
 * tracked and emitted a single time.
 * Touched is a superset of every per-mode result list (see the `file`/`final`
 * events on {@link AgentProgress}).
 */
export async function recordTouched(
  state: AgentRunState,
  file: DriveFile,
  emit: AgentRunContext["emit"]
) {
  if (!state.touched.add(file)) return;
  await emit({ type: "file", file });
}
