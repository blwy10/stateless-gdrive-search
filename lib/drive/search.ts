// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { getDriveConnection } from "@/lib/drive-connections";
import { debugText, hashForDebug, writeDebugLog } from "@/lib/debug-log";
import { googleFetch } from "./client";
import { buildDriveSearchQuery } from "./query";
import type { DriveFile } from "./types";

/**
 * Upper bound on how many Drive connections we search concurrently. Searches
 * across connections are independent, so we fan them out in parallel instead of
 * awaiting each in turn (which multiplied latency on a path the agent hits
 * repeatedly). The cap keeps a user with many connected drives from opening an
 * unbounded number of simultaneous outbound requests (and DB reads) per search.
 */
const MAX_SEARCH_CONCURRENCY = 5;

/**
 * Maps over {@link items} with at most {@link limit} workers running at once,
 * preserving input order in the returned array. Behaves like
 * {@link Promise.all} when {@link limit} is at least the number of items, and
 * rejects with the first error a worker throws.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runnerCount = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: runnerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) break;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function searchDriveConnection(input: {
  ownerSub: string;
  connectionId: string;
  query: string;
  limit: number;
  debugRequestId?: string;
}): Promise<DriveFile[]> {
  const { connectionId } = input;
  const connection = await getDriveConnection(input.ownerSub, connectionId);
  if (!connection) {
    await writeDebugLog({
      event: "drive.search.connection_missing",
      level: "warn",
      requestId: input.debugRequestId,
      connectionIdHash: hashForDebug(connectionId)
    });
    return [];
  }
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", buildDriveSearchQuery(input.query));
  url.searchParams.set("pageSize", String(input.limit));
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
  return (data.files ?? []).map((file) => ({
    ...file,
    connectionId,
    driveEmail: connection.driveEmail
  }));
}

export async function searchDriveFiles(input: {
  ownerSub: string;
  connectionIds: string[];
  query: string;
  limit?: number;
  debugRequestId?: string;
}): Promise<DriveFile[]> {
  const startedAt = Date.now();
  // Pass the raw (trimmed) query down; buildDriveSearchQuery tokenizes and
  // escapes each term when it assembles the `q` for each connection.
  const query = input.query.trim();
  const limit = Math.min(input.limit ?? 10, 20);

  await writeDebugLog({
    event: "drive.search.started",
    requestId: input.debugRequestId,
    connectionCount: input.connectionIds.length,
    query: debugText(input.query),
    limit
  });

  // Search every connection in parallel (bounded by MAX_SEARCH_CONCURRENCY).
  // Results stay in connection order because mapWithConcurrency preserves it.
  const perConnectionFiles = await mapWithConcurrency(
    input.connectionIds,
    MAX_SEARCH_CONCURRENCY,
    (connectionId) =>
      searchDriveConnection({
        ownerSub: input.ownerSub,
        connectionId,
        query,
        limit,
        debugRequestId: input.debugRequestId
      })
  );
  const files = perConnectionFiles.flat();

  await writeDebugLog({
    event: "drive.search.completed",
    requestId: input.debugRequestId,
    durationMs: Date.now() - startedAt,
    resultCount: files.length
  });

  return files;
}
