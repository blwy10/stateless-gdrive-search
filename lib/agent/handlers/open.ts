// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { GOOGLE_DRIVE_FOLDER_MIME_TYPE, openDriveFile, type DriveFile } from "@/lib/drive";
import { debugError, hashForDebug, writeDebugLog } from "@/lib/debug-log";
import { openArgs, type ToolCall, type ToolResultMessage } from "../types";
import { recordTouched, type AgentRunContext, type AgentRunState } from "../state";
import {
  errorText,
  parseToolArgs,
  safeJson,
  toolErrorObservation,
  withToolRetries
} from "../tool-runtime";
import { recordUsefulProgress } from "../budget";
import { fileKey, formatFileProgressLabel } from "../files";

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
  const fileRef = { connectionId: args.connectionId, id: args.fileId };
  const key = fileKey(fileRef);
  if (state.opened.has(fileRef)) {
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
  state.opened.claim(fileRef);
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
  // A folder has no readable content — redirect to list_folder instead of
  // returning its (placeholder) content as if it were a file. We still record it
  // in the touched audit set, but it is NOT collected into `opened` (so it can
  // never become a synthesis source) and reading it is NOT useful progress.
  if (opened.file.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE) {
    await writeDebugLog({
      event: "agent.tool.open_file.folder_redirect",
      requestId,
      step,
      durationMs: Date.now() - toolStartedAt,
      fileKeyHash: hashForDebug(fileKey(opened.file)),
      openFileCallCount: state.openFileCallCount
    });
    state.knownFileKeys.add(fileKey(opened.file));
    await emit({ type: "progress", message: `Found ${formatFileProgressLabel(opened.file)}` });
    await recordTouched(state, opened.file, emit);
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: safeJson({
        isFolder: true,
        connectionId: opened.file.connectionId,
        fileId: opened.file.id,
        message: `"${opened.file.name}" is a folder, not a readable file. Call list_folder with this connectionId and fileId to see the files inside it, then open the ones you need.`
      })
    };
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
  state.opened.collect(opened.file);
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
