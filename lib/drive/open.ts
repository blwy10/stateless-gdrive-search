// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { getDriveConnection } from "@/lib/drive-connections";
import { debugText, hashForDebug, writeDebugLog } from "@/lib/debug-log";
import { downloadBuffer, exportBuffer, getDriveFileMetadata } from "./client";
import {
  extractDocxText,
  extractPdfText,
  extractPptxText,
  extractXlsxText
} from "./extract";
import {
  folderRedirectContent,
  normalizeFileContent,
  resolveFileContent,
  unsupportedGoogleAppsContent
} from "./content";
import { GOOGLE_DRIVE_FOLDER_MIME_TYPE, type DriveFile, type OversizeSummarizer } from "./types";

export async function openDriveFile(input: {
  ownerSub: string;
  connectionId: string;
  fileId: string;
  debugRequestId?: string;
  /**
   * Optional: condense the file instead of hard-truncating it when its extracted
   * text exceeds {@link MAX_FILE_CHARS}. Passed only by the synthesis read path
   * (open_file); list-mode review_file omits it and keeps truncation.
   */
  summarizeOversize?: OversizeSummarizer;
}): Promise<{ file: DriveFile; content: string }> {
  const startedAt = Date.now();
  await writeDebugLog({
    event: "drive.open.started",
    requestId: input.debugRequestId,
    connectionIdHash: hashForDebug(input.connectionId),
    fileIdHash: hashForDebug(input.fileId)
  });

  const connection = await getDriveConnection(input.ownerSub, input.connectionId);
  if (!connection) {
    await writeDebugLog({
      event: "drive.open.connection_missing",
      level: "warn",
      requestId: input.debugRequestId,
      connectionIdHash: hashForDebug(input.connectionId),
      fileIdHash: hashForDebug(input.fileId)
    });
    throw new Error("Drive connection not found");
  }

  const metadata = await getDriveFileMetadata(connection, input.fileId, input.debugRequestId);
  await writeDebugLog({
    event: "drive.open.metadata_loaded",
    requestId: input.debugRequestId,
    connectionIdHash: hashForDebug(input.connectionId),
    fileIdHash: hashForDebug(input.fileId),
    name: debugText(metadata.name),
    mimeType: metadata.mimeType,
    size: metadata.size ?? null,
    modifiedTime: metadata.modifiedTime ?? null
  });
  let content: string;

  switch (metadata.mimeType) {
    case GOOGLE_DRIVE_FOLDER_MIME_TYPE:
      // A folder has no extractable text — return a redirect to list_folder
      // rather than attempting a download/export. The agent handlers detect the
      // folder mimeType on the returned file and short-circuit to a structured
      // redirect (so review_file never grades it), but this keeps the content
      // sensible for any caller that reads it directly.
      content = folderRedirectContent(metadata);
      break;
    case "application/vnd.google-apps.document":
      content = (await exportBuffer(connection, input.fileId, "text/plain", input.debugRequestId)).toString("utf8");
      break;
    case "application/vnd.google-apps.spreadsheet":
      content = (await exportBuffer(connection, input.fileId, "text/csv", input.debugRequestId)).toString("utf8");
      break;
    case "application/vnd.google-apps.presentation":
      content = (await exportBuffer(connection, input.fileId, "text/plain", input.debugRequestId)).toString("utf8");
      break;
    case "application/pdf":
      content = await extractPdfText(await downloadBuffer(connection, input.fileId, input.debugRequestId));
      break;
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/msword":
      content = await extractDocxText(await downloadBuffer(connection, input.fileId, input.debugRequestId));
      break;
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      content = await extractXlsxText(await downloadBuffer(connection, input.fileId, input.debugRequestId));
      break;
    case "application/vnd.ms-excel":
      content =
        "Legacy .xls parsing is not enabled. Export this file to .xlsx or Google Sheets to read it.";
      break;
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    case "application/vnd.ms-powerpoint":
      content = await extractPptxText(await downloadBuffer(connection, input.fileId, input.debugRequestId));
      break;
    case "text/plain":
    case "text/markdown":
    case "text/csv":
    case "application/json":
      content = (await downloadBuffer(connection, input.fileId, input.debugRequestId)).toString("utf8");
      break;
    default:
      if (metadata.mimeType.startsWith("application/vnd.google-apps.")) {
        content = unsupportedGoogleAppsContent(metadata);
        break;
      }
      content = (await downloadBuffer(connection, input.fileId, input.debugRequestId)).toString("utf8");
  }

  const file: DriveFile = {
    ...metadata,
    connectionId: connection.id,
    driveEmail: connection.driveEmail
  };
  const normalized = normalizeFileContent(content);
  const { content: finalContent, disposition } = await resolveFileContent({
    normalized,
    file,
    summarizeOversize: input.summarizeOversize
  });
  await writeDebugLog({
    event: "drive.open.completed",
    requestId: input.debugRequestId,
    durationMs: Date.now() - startedAt,
    connectionIdHash: hashForDebug(input.connectionId),
    fileIdHash: hashForDebug(input.fileId),
    mimeType: metadata.mimeType,
    rawContentLength: content.length,
    returnedContentLength: finalContent.length,
    // Disposition makes the oversize path auditable: "summarized" vs "truncated"
    // tells you whether the summarizer ran or we fell back to a hard cut.
    contentDisposition: disposition,
    emptyExtraction: disposition === "empty"
  });

  return { file, content: finalContent };
}
