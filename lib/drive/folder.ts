// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { getDriveConnection } from "@/lib/drive-connections";
import { debugText, hashForDebug, writeDebugLog } from "@/lib/debug-log";
import { googleFetch } from "./client";
import { escapeDriveQuery } from "./query";
import type { DriveFile } from "./types";

/**
 * Default and maximum number of children {@link listDriveFolder} returns. A
 * folder's child list enters the main agent context (like a search result), so
 * the cap keeps a large folder from blowing the context window. Higher than the
 * search cap (20) because folders legitimately hold more than a page of files;
 * a folder with more children than this is truncated by Drive's `pageSize` (we
 * fetch a single page — folder navigation is direct-children-only, see the
 * agent's list_folder tool).
 */
const DEFAULT_FOLDER_PAGE_SIZE = 100;
const MAX_FOLDER_PAGE_SIZE = 200;

/**
 * Build the Drive `q` that lists a folder's direct children. Unlike the search
 * query builder this needs no term tokenization — it filters strictly by parent
 * and trashed-state — but the folderId is still escaped defensively in case an id
 * ever contains a quote/backslash. Pure and unit-tested (see test/drive.test.ts).
 */
export function buildFolderChildrenQuery(folderId: string): string {
  return `'${escapeDriveQuery(folderId)}' in parents and trashed = false`;
}

/**
 * List the files and subfolders directly inside a Drive folder, returning them in
 * the same {@link DriveFile} shape as {@link searchDriveFiles} so the agent's
 * list_folder handler can feed them through the shared touched-set / candidate
 * machinery. Only direct children are returned (one level); the agent navigates
 * deeper by listing a child folder in turn. A non-folder id simply has no
 * children and yields an empty list — the caller surfaces that as a note.
 */
export async function listDriveFolder(input: {
  ownerSub: string;
  connectionId: string;
  folderId: string;
  limit?: number;
  debugRequestId?: string;
}): Promise<DriveFile[]> {
  const startedAt = Date.now();
  const { connectionId } = input;
  const limit = Math.min(input.limit ?? DEFAULT_FOLDER_PAGE_SIZE, MAX_FOLDER_PAGE_SIZE);
  await writeDebugLog({
    event: "drive.folder.started",
    requestId: input.debugRequestId,
    connectionIdHash: hashForDebug(connectionId),
    fileIdHash: hashForDebug(input.folderId),
    limit
  });

  const connection = await getDriveConnection(input.ownerSub, connectionId);
  if (!connection) {
    await writeDebugLog({
      event: "drive.folder.connection_missing",
      level: "warn",
      requestId: input.debugRequestId,
      connectionIdHash: hashForDebug(connectionId)
    });
    throw new Error("Drive connection not found");
  }

  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", buildFolderChildrenQuery(input.folderId));
  url.searchParams.set("pageSize", String(limit));
  url.searchParams.set("fields", "files(id,name,mimeType,webViewLink,modifiedTime,size)");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  const response = await googleFetch(connection, url, {
    requestId: input.debugRequestId,
    operation: "list_folder",
    connectionId,
    fileId: input.folderId
  });
  const data = (await response.json()) as {
    files?: Omit<DriveFile, "connectionId" | "driveEmail">[];
  };
  const children = (data.files ?? []).map((file) => ({
    ...file,
    connectionId,
    driveEmail: connection.driveEmail
  }));
  await writeDebugLog({
    event: "drive.folder.completed",
    requestId: input.debugRequestId,
    durationMs: Date.now() - startedAt,
    connectionIdHash: hashForDebug(connectionId),
    fileIdHash: hashForDebug(input.folderId),
    childCount: children.length,
    childName: children.length > 0 ? debugText(children[0].name) : null
  });
  return children;
}
