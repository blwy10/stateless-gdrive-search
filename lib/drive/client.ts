// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { updateDriveAccessToken, type DriveConnection } from "@/lib/drive-connections";
import { expiresAtFromNow, refreshDriveToken } from "@/lib/google-oauth";
import { debugError, debugText, hashForDebug, writeDebugLog } from "@/lib/debug-log";
import type { DriveDebugContext, DriveFile } from "./types";

/**
 * Per-request timeout for outbound Google Drive calls. Without it, a hung
 * connection would stall the agent run indefinitely, holding its SSE stream and
 * server resources open. Applied via {@link AbortSignal.timeout}, so it bounds
 * connect + response-body read for each individual request (including retries,
 * which create a fresh signal per attempt).
 */
const DRIVE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Caps for the fields pulled out of a Google Drive error body. `reason` is a
 * short machine code (e.g. `cannotExportFile`); `message` is a human sentence we
 * surface to the model. Both are bounded so a hostile or oversized body cannot
 * bloat the thrown error (which `errorText` hands to the model verbatim) or the
 * debug log.
 */
const MAX_DRIVE_ERROR_REASON_CHARS = 80;
const MAX_DRIVE_ERROR_MESSAGE_CHARS = 300;

/**
 * Pull the machine `reason` and human `message` out of a Google Drive API error
 * body. Drive returns a JSON envelope on failure:
 *
 *   { "error": { "code": 403, "message": "...",
 *                "errors": [{ "reason": "cannotExportFile", "message": "..." }] } }
 *
 * The `reason` code (e.g. `cannotExportFile`, `notFound`,
 * `insufficientFilePermissions`, `exportSizeLimitExceeded`) explains *why* the
 * request failed. Threading it into the thrown error lets the agent tell the
 * model a file is genuinely unreadable — so it stops retrying it and can note the
 * gap in its answer — and lets `drive.google.failed` record the reason even when
 * DEBUG_LOG_CONTENT is off (the raw body stays gated behind that flag).
 *
 * Defensive by design: the body may be empty, truncated, or HTML (gateway/proxy
 * errors are not JSON), so anything non-conforming yields nulls and the caller
 * falls back to the bare status.
 */
export function parseDriveApiError(body: string): {
  reason: string | null;
  message: string | null;
} {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; errors?: Array<{ reason?: unknown } | null> | null };
    };
    const apiError = parsed?.error;
    const rawMessage = typeof apiError?.message === "string" ? apiError.message.trim() : "";
    let reason: string | null = null;
    if (Array.isArray(apiError?.errors)) {
      for (const entry of apiError.errors) {
        if (entry && typeof entry.reason === "string" && entry.reason.trim()) {
          reason = entry.reason.trim().slice(0, MAX_DRIVE_ERROR_REASON_CHARS);
          break;
        }
      }
    }
    return {
      reason,
      message: rawMessage ? rawMessage.slice(0, MAX_DRIVE_ERROR_MESSAGE_CHARS) : null
    };
  } catch {
    return { reason: null, message: null };
  }
}

async function ensureAccessToken(
  connection: DriveConnection,
  requestId?: string
): Promise<DriveConnection> {
  if (!connection.expiresAt || connection.expiresAt.getTime() > Date.now() + 30_000) {
    return connection;
  }
  if (!connection.refreshToken) {
    throw new Error(`Drive ${connection.driveEmail} has no refresh token; reconnect it.`);
  }
  const refreshed = await refreshDriveToken(connection.refreshToken);
  const expiresAt = expiresAtFromNow(refreshed.expires_in);
  await updateDriveAccessToken({
    id: connection.id,
    ownerSub: connection.ownerSub,
    accessToken: refreshed.access_token,
    expiresAt,
    scope: refreshed.scope
  });
  await writeDebugLog({
    event: "drive.token.refreshed",
    requestId,
    connectionIdHash: hashForDebug(connection.id),
    ownerSubHash: hashForDebug(connection.ownerSub),
    expiresAt: expiresAt?.toISOString() ?? null,
    scopeHash: refreshed.scope ? hashForDebug(refreshed.scope) : null
  });
  return {
    ...connection,
    accessToken: refreshed.access_token,
    expiresAt,
    scope: refreshed.scope ?? connection.scope
  };
}

export async function googleFetch(connection: DriveConnection, url: URL, context: DriveDebugContext) {
  const startedAt = Date.now();
  const connectionId = context.connectionId ?? connection.id;
  await writeDebugLog({
    event: "drive.google.request",
    requestId: context.requestId,
    operation: context.operation,
    method: "GET",
    path: url.pathname,
    queryParamNames: [...url.searchParams.keys()],
    connectionIdHash: hashForDebug(connectionId),
    fileIdHash: context.fileId ? hashForDebug(context.fileId) : null
  });

  try {
    const active = await ensureAccessToken(connection, context.requestId);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${active.accessToken}` },
      signal: AbortSignal.timeout(DRIVE_REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      const responseBody = await response.text();
      const { reason, message } = parseDriveApiError(responseBody);
      await writeDebugLog({
        event: "drive.google.failed",
        level: "error",
        requestId: context.requestId,
        operation: context.operation,
        status: response.status,
        // `reason` is a stable, non-sensitive Google error code, logged
        // unconditionally so a 403 is diagnosable without DEBUG_LOG_CONTENT; the
        // raw body (which may carry identifiers) stays gated in `response`.
        reason,
        durationMs: Date.now() - startedAt,
        path: url.pathname,
        connectionIdHash: hashForDebug(connectionId),
        fileIdHash: context.fileId ? hashForDebug(context.fileId) : null,
        response: debugText(responseBody)
      });
      // Append Google's own explanation so the model learns the failure is
      // permanent (e.g. an export-disabled file) instead of seeing a bare status
      // and pointlessly retrying. Keep the "status <N>" prefix verbatim — the
      // retry classifier keys off it (see isRetryableToolError).
      const detail = message ? `: ${message}` : "";
      const reasonSuffix = reason ? ` (${reason})` : "";
      throw new Error(
        `Google Drive request failed with status ${response.status}${detail}${reasonSuffix}`
      );
    }
    await writeDebugLog({
      event: "drive.google.completed",
      requestId: context.requestId,
      operation: context.operation,
      status: response.status,
      durationMs: Date.now() - startedAt,
      path: url.pathname,
      connectionIdHash: hashForDebug(connectionId),
      fileIdHash: context.fileId ? hashForDebug(context.fileId) : null
    });
    return response;
  } catch (error) {
    await writeDebugLog({
      event: "drive.google.error",
      level: "error",
      requestId: context.requestId,
      operation: context.operation,
      durationMs: Date.now() - startedAt,
      path: url.pathname,
      connectionIdHash: hashForDebug(connectionId),
      fileIdHash: context.fileId ? hashForDebug(context.fileId) : null,
      error: debugError(error)
    });
    throw error;
  }
}

export async function getDriveFileMetadata(
  connection: DriveConnection,
  fileId: string,
  requestId?: string
) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,name,mimeType,webViewLink,modifiedTime,size");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await googleFetch(connection, url, {
    requestId,
    operation: "get_metadata",
    connectionId: connection.id,
    fileId
  });
  return (await response.json()) as Omit<DriveFile, "connectionId" | "driveEmail">;
}

export async function downloadBuffer(connection: DriveConnection, fileId: string, requestId?: string) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await googleFetch(connection, url, {
    requestId,
    operation: "download_file",
    connectionId: connection.id,
    fileId
  });
  return Buffer.from(await response.arrayBuffer());
}

export async function exportBuffer(
  connection: DriveConnection,
  fileId: string,
  mimeType: string,
  requestId?: string
) {
  const url = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`
  );
  url.searchParams.set("mimeType", mimeType);
  const response = await googleFetch(connection, url, {
    requestId,
    operation: "export_file",
    connectionId: connection.id,
    fileId
  });
  return Buffer.from(await response.arrayBuffer());
}
