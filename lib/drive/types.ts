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

/**
 * The mimeType Google Drive assigns to a folder. A folder has no extractable
 * text, so the read paths (open_file/review_file) redirect it to list_folder
 * instead of trying to download/grade it (see lib/drive/open.ts and the agent
 * handlers). Also used by {@link listDriveFolder} as the navigation target.
 */
export const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export const MAX_FILE_CHARS = 32_000;

/**
 * Floor on an accepted oversize-file summary, as a fraction of {@link MAX_FILE_CHARS}
 * (the budget the summarizer is told to roughly fill). A summary shorter than this
 * is treated as pathological over-compression — a model that returned a few
 * sentences for a large document — and {@link resolveFileContent} discards it in
 * favour of hard truncation, which preserves more of the document than a near-empty
 * "summary". This is a safety net only; the summarizer's own prompt is the primary
 * length control. Tune alongside MAX_FILE_CHARS.
 */
export const MIN_SUMMARY_CHARS = MAX_FILE_CHARS / 4;

/**
 * Optional hook injected into {@link openDriveFile} to condense a file whose
 * extracted text exceeds {@link MAX_FILE_CHARS} instead of hard-truncating it.
 * Receives the assembled {@link DriveFile} and the full (normalized) text and
 * returns a summary, or null to fall back to truncation (the hook owns its own
 * failure handling — see summarizeOversizeContent in lib/agent/summarizer.ts). Kept as a
 * plain function so lib/drive stays free of any model/provider dependency and is
 * still usable (with truncation) by callers that pass no hook (tests, utils).
 */
export type OversizeSummarizer = (args: {
  file: DriveFile;
  fullText: string;
}) => Promise<string | null>;

/**
 * How {@link resolveFileContent} produced the returned text. `full` (within the
 * cap), `empty` (nothing extractable), `truncated` (hard cut at the cap), or
 * `summarized` (an {@link OversizeSummarizer} condensed it into the cap).
 */
export type ContentDisposition = "full" | "empty" | "truncated" | "summarized";

export type DriveDebugContext = {
  requestId?: string;
  operation: string;
  connectionId?: string;
  fileId?: string;
};
