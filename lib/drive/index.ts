// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

// Public API barrel for the Drive client. The implementation is split into
// focused modules under lib/drive/*; this file preserves the original
// `@/lib/drive` import surface (consumed by the agent modules and the unit
// tests) so callers are unaffected by the internal decomposition.

export {
  GOOGLE_DRIVE_FOLDER_MIME_TYPE,
  MAX_FILE_CHARS,
  MIN_SUMMARY_CHARS,
  type ContentDisposition,
  type DriveFile,
  type OversizeSummarizer
} from "./types";
export { parseDriveApiError } from "./client";
export { buildDriveSearchQuery, escapeDriveQuery } from "./query";
export { buildFolderChildrenQuery, listDriveFolder } from "./folder";
export { emptyExtractionNote, resolveFileContent } from "./content";
export { searchDriveFiles } from "./search";
export { openDriveFile } from "./open";
