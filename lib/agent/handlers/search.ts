// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { searchDriveFiles, type DriveFile } from "@/lib/drive";
import { debugError, debugText, hashForDebug, writeDebugLog } from "@/lib/debug-log";
import { searchArgs, type ToolCall, type ToolResultMessage } from "../types";
import { recordTouched, type AgentRunContext, type AgentRunState } from "../state";
import {
  errorText,
  parseToolArgs,
  safeJson,
  toolErrorObservation,
  withToolRetries
} from "../tool-runtime";
import {
  combineNotes,
  noteDiminishingReturns,
  recordUsefulProgress,
  searchResultNote
} from "../budget";
import { fileKey } from "../files";

function normalizeSearchQuery(query: string) {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
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
    await noteDiminishingReturns(requestId, step, state, budget)
  );
  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content: safeJson(note ? { files, note } : { files })
  };
}
