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

export const MAX_FILE_CHARS = 32_000;

/**
 * Optional hook injected into {@link openDriveFile} to condense a file whose
 * extracted text exceeds {@link MAX_FILE_CHARS} instead of hard-truncating it.
 * Receives the assembled {@link DriveFile} and the full (normalized) text and
 * returns a summary, or null to fall back to truncation (the hook owns its own
 * failure handling — see summarizeOversizeContent in lib/agent.ts). Kept as a
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
