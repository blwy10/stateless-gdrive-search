// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import type { AgentBudget, AgentRequest } from "./types";
import type { AgentRunState } from "./state";

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
 * Build a short corrective note for a `search_drive` observation in the two cases
 * worth flagging even under the cheap-search philosophy: an *exact* repeat (pure
 * token waste, zero chance of new information) and a query that matched *nothing*
 * (the model should vary terms). Overlap with already-seen files is deliberately
 * NOT flagged here — searches are cheap and an overlapping query is often the
 * model triangulating toward a new angle; whether returns are diminishing is
 * judged holistically by {@link diminishingReturnsNote} over tokens, not by any
 * single search's novelty. Returns null otherwise.
 */
export function searchResultNote(wasRepeatedQuery: boolean, totalResultCount: number): string | null {
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
export function recordUsefulProgress(state: AgentRunState) {
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
export function diminishingReturnsNote(state: AgentRunState, budget: AgentBudget): string | null {
  if (tokensSinceProgress(state) >= budget.softProgressTokenLimit) {
    return "Returns are diminishing: recent work has not produced new useful results. Wrap up and answer with what you have, unless you have a genuinely new angle to search (e.g. a name, project, or term you just learned).";
  }
  return null;
}

/** Join a search-specific note with the diminishing-returns nudge, if either fires. */
export function combineNotes(...notes: (string | null)[]): string | null {
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
export function evaluateTokenBudget(state: AgentRunState, budget: AgentBudget) {
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
