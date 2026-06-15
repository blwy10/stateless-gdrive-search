// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

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

export type QuerySession = {
  id: string;
  query: string;
  mode: "synthesis" | "list";
  curateList: boolean;
  selectedDrive: string;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "running" | "finished" | "error";
  events: string[];
  // Primary result list: synthesis -> the files the answer cites; curated list ->
  // examiner-kept files; uncurated list -> every match. A subset of touchedFiles.
  files: DriveFile[];
  // Audit/disclosure list: every file the agent encountered this run (search
  // candidates + opened/reviewed), across all modes. Streamed live via `file`
  // events and finalized authoritatively by the `final` event.
  touchedFiles: DriveFile[];
  // Curated list mode only: files the agent is reading and grading right now.
  // Each one resolves to either `files` (kept) or removal (discarded), and the
  // list is cleared when the run settles. Transient/UI-only, but kept on the
  // session so the UI renders from a single source of truth.
  reviewingFiles: DriveFile[];
  // The agent's live "thinking" stream, accumulated from `reasoning` events during
  // a run. Display-only and ephemeral: kept in memory while viewing a run but
  // stripped before persistence (see saveStoredSessions) since it can be large and
  // is not useful to restore across reloads.
  reasoning: string;
  answer: string;
  answerFormat: "markdown" | "plain";
  error: string;
};

/** Stable per-file key (connection + file id) used for dedup and matching. */
export function fileKey(file: Pick<DriveFile, "connectionId" | "id">): string {
  return `${file.connectionId}:${file.id}`;
}

/** Deduplicate a file list by {@link fileKey}, preserving first-seen order. */
export function dedupeFiles(files: DriveFile[]): DriveFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = fileKey(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
