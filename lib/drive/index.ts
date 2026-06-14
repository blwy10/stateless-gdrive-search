// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

// Public API barrel for the Drive client. The implementation is split into
// focused modules under lib/drive/*; this file preserves the original
// `@/lib/drive` import surface (consumed by the agent modules and the unit
// tests) so callers are unaffected by the internal decomposition.

export {
  MAX_FILE_CHARS,
  type ContentDisposition,
  type DriveFile,
  type OversizeSummarizer
} from "./types";
export { buildDriveSearchQuery, escapeDriveQuery } from "./query";
export { emptyExtractionNote, resolveFileContent } from "./content";
export { searchDriveFiles } from "./search";
export { openDriveFile } from "./open";
