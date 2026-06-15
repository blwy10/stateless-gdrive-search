// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import {
  MAX_FILE_CHARS,
  MIN_SUMMARY_CHARS,
  type ContentDisposition,
  type DriveFile,
  type OversizeSummarizer
} from "./types";

/** Strip NUL bytes and surrounding whitespace from extracted text. */
export function normalizeFileContent(content: string) {
  return content.replace(/\u0000/g, "").trim();
}

/** Hard-cut already-normalized text at the cap with an explicit marker. */
function truncateToMaxChars(normalized: string) {
  if (normalized.length <= MAX_FILE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_FILE_CHARS)}\n\n[Truncated at ${MAX_FILE_CHARS} characters]`;
}

/**
 * Decide the text a file read returns, given its already-normalized extracted
 * content. The single place the {@link MAX_FILE_CHARS} cap is applied, so both
 * read paths (synthesis open_file, list review_file) share it:
 *  - empty            -> an {@link emptyExtractionNote} so the gap is explicit;
 *  - within the cap    -> the content unchanged;
 *  - over the cap with a {@link OversizeSummarizer} hook -> the summary
 *    (defensively re-capped if the model overshoots), falling back to a hard
 *    truncation when the hook returns null/blank OR an implausibly short summary
 *    (below {@link MIN_SUMMARY_CHARS} — pathological over-compression);
 *  - over the cap with no hook -> a hard truncation (today's behaviour).
 * Pure aside from the injected hook (no Drive/network), so the disposition logic
 * is unit-testable with a fake summarizer.
 */
export async function resolveFileContent(args: {
  normalized: string;
  file: DriveFile;
  summarizeOversize?: OversizeSummarizer;
}): Promise<{ content: string; disposition: ContentDisposition }> {
  const { normalized, file, summarizeOversize } = args;
  if (normalized.length === 0) {
    return { content: emptyExtractionNote(file), disposition: "empty" };
  }
  if (normalized.length <= MAX_FILE_CHARS) {
    return { content: normalized, disposition: "full" };
  }
  if (summarizeOversize) {
    const summary = (await summarizeOversize({ file, fullText: normalized }))?.trim();
    // Accept the summary only if it's substantial enough to be worth more than
    // truncation. A summary far below MIN_SUMMARY_CHARS is pathological over-
    // compression (a few sentences for a large doc); truncation preserves more, so
    // fall through to it. The summarizer prompt is the primary length control — this
    // is the safety net (see MIN_SUMMARY_CHARS).
    if (summary && summary.length >= MIN_SUMMARY_CHARS) {
      // Defensive re-cap: a summarizer that overshoots the budget must not blow
      // the downstream context guard. Marker distinguishes this from raw truncation.
      const content =
        summary.length > MAX_FILE_CHARS
          ? `${summary.slice(0, MAX_FILE_CHARS)}\n\n[Summary truncated at ${MAX_FILE_CHARS} characters]`
          : summary;
      return { content, disposition: "summarized" };
    }
  }
  return { content: truncateToMaxChars(normalized), disposition: "truncated" };
}

/**
 * Content returned when a read targets a folder. A folder has no extractable
 * text, so instead of the generic "unsupported type" note we point the model at
 * list_folder. The agent handlers also detect the folder mimeType and return a
 * structured redirect before this string is used (so review_file never grades a
 * folder); this is the fallback that keeps openDriveFile's contract intact.
 */
export function folderRedirectContent(file: Omit<DriveFile, "connectionId" | "driveEmail">) {
  const linkText = file.webViewLink ? ` Open it in Drive: ${file.webViewLink}` : "";
  return `"${file.name}" is a Google Drive folder, not a readable file. Use the list_folder tool with this connectionId and fileId to list the files inside it, then open or review the ones you need.${linkText}`;
}

function googleAppsTypeName(mimeType: string) {
  return mimeType.replace("application/vnd.google-apps.", "Google ");
}

export function unsupportedGoogleAppsContent(file: Omit<DriveFile, "connectionId" | "driveEmail">) {
  const linkText = file.webViewLink ? ` Open it in Drive: ${file.webViewLink}` : "";
  return [
    `${file.name} is a ${googleAppsTypeName(file.mimeType)} file.`,
    `This app can extract text from Google Docs, Sheets, and Slides, but it cannot extract text from this Google Drive file type yet.${linkText}`
  ].join("\n");
}

/**
 * Note returned in place of empty extracted content. Some files open
 * successfully but yield no readable text — an image-only/scanned PDF, an empty
 * document, or a layout this parser does not understand. Returning "" would
 * silently tell the agent the file had nothing relevant; this explicit note
 * lets the model report the gap (and point the user at the original file).
 */
export function emptyExtractionNote(file: Pick<DriveFile, "name" | "webViewLink">) {
  const linkText = file.webViewLink ? ` Open it in Drive to view it: ${file.webViewLink}` : "";
  return `No readable text could be extracted from "${file.name}". It may be empty, image-only (such as a scanned PDF), or in a format this app cannot parse.${linkText}`;
}
