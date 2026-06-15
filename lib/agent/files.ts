// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { formatMimeType } from "@/lib/file-types";
import type { DriveFile } from "@/lib/drive";

export function uniqueFiles(files: DriveFile[]) {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = fileKey(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function fileKey(file: Pick<DriveFile, "connectionId" | "id">) {
  return `${file.connectionId}:${file.id}`;
}

export function formatFileProgressLabel(file: DriveFile) {
  return `${formatMimeType(file.mimeType)} "${file.name}"`;
}
