// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { GOOGLE_DRIVE_FOLDER_MIME_TYPE, openDriveFile, type DriveFile } from "@/lib/drive";
import { debugError, debugText, hashForDebug, writeDebugLog } from "@/lib/debug-log";
import { isCuratingRequest, reviewArgs, type ToolCall, type ToolResultMessage } from "../types";
import { recordTouched, type AgentRunContext, type AgentRunState } from "../state";
import {
  errorText,
  parseToolArgs,
  safeJson,
  toolErrorObservation,
  withToolRetries
} from "../tool-runtime";
import { noteDiminishingReturns, recordUsefulProgress } from "../budget";
import { fileKey, formatFileProgressLabel } from "../files";

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
  const fileRef = { connectionId: args.connectionId, id: args.fileId };
  const key = fileKey(fileRef);
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
  if (state.reviewed.has(fileRef)) {
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
  state.reviewed.claim(fileRef);
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

  // A folder has no readable content to grade — redirect to list_folder and
  // return BEFORE the examiner runs, so gradeFile never sees a folder and no
  // keep/discard decision is made for it (folders are navigation, never a
  // result). Recorded in the touched audit set, but not collected into
  // `reviewed` (it was never graded) and no reviewing/examining event is emitted.
  if (opened.file.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE) {
    await writeDebugLog({
      event: "agent.tool.review_file.folder_redirect",
      requestId,
      step,
      durationMs: Date.now() - toolStartedAt,
      fileKeyHash: hashForDebug(fileKey(opened.file)),
      reviewFileCallCount: state.reviewFileCallCount
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
        message: `"${opened.file.name}" is a folder, not a readable file. Call list_folder with this connectionId and fileId to list the files inside it, then review the ones you need.`
      })
    };
  }

  const openedKey = fileKey(opened.file);
  const curating = isCuratingRequest(context.input);
  state.knownFileKeys.add(openedKey);
  state.reviewed.collect(opened.file);
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
    // Subject-awareness audit trail (see GradeVerdict.aboutSubject): surfaces the
    // entity-conflation risk of a kept file without exposing content.
    aboutSubject: verdict.aboutSubject,
    curating,
    reviewFileCallCount: state.reviewFileCallCount,
    keptFileCount: state.kept.size
  });

  // Only curated mode keeps/discards by relevance; in uncurated the file is
  // already a result (surfaced at search time). Keeping a new file is useful
  // progress that resets the diminishing-returns clock.
  if (curating) {
    if (verdict.relevant) {
      if (state.kept.add(opened.file)) {
        // Retain the verdict so the terminal reranker can order the kept set on
        // the already-computed reason/entities/aboutSubject (see lib/agent/ranker.ts).
        state.keptVerdicts.set(openedKey, verdict);
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
  const drNote = await noteDiminishingReturns(requestId, step, state, budget);
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
