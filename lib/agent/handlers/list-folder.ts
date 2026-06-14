// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { listDriveFolder, type DriveFile } from "@/lib/drive";
import { debugError, hashForDebug, writeDebugLog } from "@/lib/debug-log";
import { listFolderArgs, type ToolCall, type ToolResultMessage } from "../types";
import { recordTouched, type AgentRunContext, type AgentRunState } from "../state";
import {
  errorText,
  parseToolArgs,
  safeJson,
  toolErrorObservation,
  withToolRetries
} from "../tool-runtime";
import { combineNotes, diminishingReturnsNote, recordUsefulProgress } from "../budget";
import { fileKey } from "../files";

/**
 * Handle a single `list_folder` tool call (all modes): enforce drive scope, list
 * the folder's direct children, record them as candidates, and emit progress.
 *
 * Folders carry no extractable text, so they are navigation rather than results:
 * this returns the children in the same shape as a `search_drive` result so the
 * model can then open_file / review_file the relevant ones. Children flow through
 * the shared touched-set / diminishing-returns machinery exactly like search
 * hits — surfacing new children is useful progress only in non-curated modes
 * (where surfaced files ARE the result); in curated mode a bare candidate is not
 * progress until the examiner keeps it. The folder itself is never a result.
 *
 * Mirrors the other handlers' run-resilience posture: an out-of-scope
 * connectionId or a failed listing is surfaced as a recoverable observation, so a
 * single bad folder never aborts the run.
 */
export async function handleListFolderTool(
  context: AgentRunContext,
  state: AgentRunState,
  step: number,
  toolCall: ToolCall
): Promise<ToolResultMessage> {
  const { requestId, budget, selectedDriveIds, ownerSub, input, emit } = context;
  const parsed = await parseToolArgs(context, step, toolCall, listFolderArgs);
  if (!parsed.ok) return parsed.observation;
  const args = parsed.args;
  await writeDebugLog({
    event: "agent.tool.list_folder.requested",
    requestId,
    step,
    toolCallIdHash: hashForDebug(toolCall.id),
    connectionIdHash: hashForDebug(args.connectionId),
    fileIdHash: hashForDebug(args.fileId),
    listFolderCallCount: state.listFolderCallCount
  });
  if (!selectedDriveIds.includes(args.connectionId)) {
    await writeDebugLog({
      event: "agent.tool.list_folder.rejected",
      level: "error",
      requestId,
      step,
      reason: "outside_selected_drive_scope",
      connectionIdHash: hashForDebug(args.connectionId),
      fileIdHash: hashForDebug(args.fileId)
    });
    // Same security boundary and recovery posture as open_file/review_file: an
    // out-of-scope connectionId is almost always a hallucinated id, so reject it
    // as an observation (never listing) instead of throwing and aborting the run.
    return toolErrorObservation(
      toolCall.id,
      `connectionId "${args.connectionId}" is not one of the selected Drive connections, so this folder cannot be listed. Use the exact connectionId from a search_drive or list_folder result. Selected connectionIds: ${selectedDriveIds.join(", ")}.`
    );
  }

  await emit({ type: "progress", message: "Listing folder contents" });
  state.listFolderCallCount += 1;
  const toolStartedAt = Date.now();
  let children: DriveFile[];
  try {
    children = await withToolRetries(
      () =>
        listDriveFolder({
          ownerSub,
          connectionId: args.connectionId,
          folderId: args.fileId,
          limit: args.limit,
          debugRequestId: requestId
        }),
      budget.maxToolRetries
    );
  } catch (error) {
    await writeDebugLog({
      event: "agent.tool.list_folder.failed",
      level: "error",
      requestId,
      step,
      durationMs: Date.now() - toolStartedAt,
      listFolderCallCount: state.listFolderCallCount,
      error: debugError(error)
    });
    return toolErrorObservation(
      toolCall.id,
      `Could not list this folder: ${errorText(error)}. It may be inaccessible; continue with the other files.`
    );
  }

  const newFiles = children.filter((file) => !state.knownFileKeys.has(fileKey(file)));
  await writeDebugLog({
    event: "agent.tool.list_folder.completed",
    requestId,
    step,
    durationMs: Date.now() - toolStartedAt,
    childCount: children.length,
    newChildCount: newFiles.length,
    listFolderCallCount: state.listFolderCallCount
  });
  for (const file of children) {
    state.knownFileKeys.add(fileKey(file));
  }
  // Mirror handleSearchTool: record each newly-seen child into the run's touched
  // set and stream it (all modes — touched is the audit/disclosure list).
  // Surfacing a candidate counts as useful progress (resetting the
  // diminishing-returns clock) only when surfaced files ARE the result —
  // non-curated runs return what search/list surface, while curated returns only
  // examiner-kept files, so a bare child here is a candidate, not progress.
  if (newFiles.length > 0) {
    for (const file of newFiles) {
      await recordTouched(state, file, emit);
    }
    if (!input.curateList) recordUsefulProgress(state);
  }
  // An empty listing is either an empty folder or a non-folder id (a folder has
  // no children either way); tell the model so it pivots back to search instead
  // of assuming the folder was relevant-but-empty.
  const emptyNote =
    children.length === 0
      ? "This folder has no files directly inside it. It may be empty, or this id may not be a folder — use search_drive to find files instead."
      : null;
  const note = combineNotes(emptyNote, diminishingReturnsNote(state, budget));
  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content: safeJson(note ? { files: children, note } : { files: children })
  };
}
