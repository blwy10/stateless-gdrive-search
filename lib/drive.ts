// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import JSZip from "jszip";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import {
  getDriveConnection,
  updateDriveAccessToken,
  type DriveConnection
} from "@/lib/drive-connections";
import { expiresAtFromNow, refreshDriveToken } from "@/lib/google-oauth";
import { debugError, debugText, hashForDebug, writeDebugLog } from "@/lib/debug-log";

export type DriveFile = {
  connectionId: string;
  driveEmail: string;
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  modifiedTime?: string;
  size?: string;
};

const MAX_FILE_CHARS = 32_000;

type DriveDebugContext = {
  requestId?: string;
  operation: string;
  connectionId?: string;
  fileId?: string;
};

function escapeDriveQuery(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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

async function googleFetch(connection: DriveConnection, url: URL, context: DriveDebugContext) {
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
      headers: { authorization: `Bearer ${active.accessToken}` }
    });
    if (!response.ok) {
      const responseBody = await response.text();
      await writeDebugLog({
        event: "drive.google.failed",
        level: "error",
        requestId: context.requestId,
        operation: context.operation,
        status: response.status,
        durationMs: Date.now() - startedAt,
        path: url.pathname,
        connectionIdHash: hashForDebug(connectionId),
        fileIdHash: context.fileId ? hashForDebug(context.fileId) : null,
        response: debugText(responseBody)
      });
      throw new Error(`Google Drive request failed: ${response.status} ${responseBody}`);
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

export async function searchDriveFiles(input: {
  ownerSub: string;
  connectionIds: string[];
  query: string;
  limit?: number;
  debugRequestId?: string;
}): Promise<DriveFile[]> {
  const startedAt = Date.now();
  const query = escapeDriveQuery(input.query.trim());
  const limit = Math.min(input.limit ?? 10, 20);
  const files: DriveFile[] = [];

  await writeDebugLog({
    event: "drive.search.started",
    requestId: input.debugRequestId,
    connectionCount: input.connectionIds.length,
    query: debugText(input.query),
    limit
  });

  for (const connectionId of input.connectionIds) {
    const connection = await getDriveConnection(input.ownerSub, connectionId);
    if (!connection) {
      await writeDebugLog({
        event: "drive.search.connection_missing",
        level: "warn",
        requestId: input.debugRequestId,
        connectionIdHash: hashForDebug(connectionId)
      });
      continue;
    }
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set(
      "q",
      `trashed = false and (name contains '${query}' or fullText contains '${query}')`
    );
    url.searchParams.set("pageSize", String(limit));
    url.searchParams.set(
      "fields",
      "files(id,name,mimeType,webViewLink,modifiedTime,size)"
    );
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    const response = await googleFetch(connection, url, {
      requestId: input.debugRequestId,
      operation: "search_files",
      connectionId
    });
    const data = (await response.json()) as { files?: Omit<DriveFile, "connectionId" | "driveEmail">[] };
    await writeDebugLog({
      event: "drive.search.connection_completed",
      requestId: input.debugRequestId,
      connectionIdHash: hashForDebug(connectionId),
      resultCount: data.files?.length ?? 0
    });
    for (const file of data.files ?? []) {
      files.push({
        ...file,
        connectionId,
        driveEmail: connection.driveEmail
      });
    }
  }

  await writeDebugLog({
    event: "drive.search.completed",
    requestId: input.debugRequestId,
    durationMs: Date.now() - startedAt,
    resultCount: files.length
  });

  return files;
}

async function getDriveFileMetadata(
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

async function downloadBuffer(connection: DriveConnection, fileId: string, requestId?: string) {
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

async function exportBuffer(
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

async function extractPptxText(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const chunks: string[] = [];
  for (const path of slidePaths) {
    const xml = await zip.files[path].async("text");
    const text = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)]
      .map((match) =>
        match[1]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
      )
      .join(" ");
    if (text.trim()) chunks.push(text);
  }
  return chunks.join("\n\n");
}

function xmlText(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function extractXlsxText(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const sharedStringsXml = zip.files["xl/sharedStrings.xml"]
    ? await zip.files["xl/sharedStrings.xml"].async("text")
    : "";
  const sharedStrings = [...sharedStringsXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((textMatch) => xmlText(textMatch[1]))
      .join("")
  );

  const sheetNames = new Map<string, string>();
  if (zip.files["xl/workbook.xml"]) {
    const workbookXml = await zip.files["xl/workbook.xml"].async("text");
    for (const match of workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*sheetId="([^"]+)"/g)) {
      sheetNames.set(`xl/worksheets/sheet${match[2]}.xml`, xmlText(match[1]));
    }
  }

  const sheetPaths = Object.keys(zip.files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const chunks: string[] = [];
  for (const path of sheetPaths) {
    const xml = await zip.files[path].async("text");
    const rows: string[] = [];
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map(
        (cellMatch) => {
          const attrs = cellMatch[1];
          const cellXml = cellMatch[2];
          const inline = cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
          if (inline) return xmlText(inline);
          const raw = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
          if (attrs.includes('t="s"')) return sharedStrings[Number(raw)] ?? "";
          return xmlText(raw);
        }
      );
      if (cells.some(Boolean)) rows.push(cells.join(","));
    }
    chunks.push(`Sheet: ${sheetNames.get(path) ?? path}\n${rows.join("\n")}`);
  }
  return chunks.join("\n\n");
}

function trimContent(content: string) {
  const normalized = content.replace(/\u0000/g, "").trim();
  if (normalized.length <= MAX_FILE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_FILE_CHARS)}\n\n[Truncated at ${MAX_FILE_CHARS} characters]`;
}

function googleAppsTypeName(mimeType: string) {
  return mimeType.replace("application/vnd.google-apps.", "Google ");
}

function unsupportedGoogleAppsContent(file: Omit<DriveFile, "connectionId" | "driveEmail">) {
  const linkText = file.webViewLink ? ` Open it in Drive: ${file.webViewLink}` : "";
  return [
    `${file.name} is a ${googleAppsTypeName(file.mimeType)} file.`,
    `This app can extract text from Google Docs, Sheets, and Slides, but it cannot extract text from this Google Drive file type yet.${linkText}`
  ].join("\n");
}

export async function openDriveFile(input: {
  ownerSub: string;
  connectionId: string;
  fileId: string;
  debugRequestId?: string;
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
      content = (await pdfParse(await downloadBuffer(connection, input.fileId, input.debugRequestId))).text;
      break;
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/msword":
      content = (await mammoth.extractRawText({ buffer: await downloadBuffer(connection, input.fileId, input.debugRequestId) }))
        .value;
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

  const trimmedContent = trimContent(content);
  await writeDebugLog({
    event: "drive.open.completed",
    requestId: input.debugRequestId,
    durationMs: Date.now() - startedAt,
    connectionIdHash: hashForDebug(input.connectionId),
    fileIdHash: hashForDebug(input.fileId),
    mimeType: metadata.mimeType,
    rawContentLength: content.length,
    returnedContentLength: trimmedContent.length
  });

  return {
    file: {
      ...metadata,
      connectionId: connection.id,
      driveEmail: connection.driveEmail
    },
    content: trimmedContent
  };
}
