// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import type { QuerySession } from "./types";

const STORAGE_KEY = "stateless-gdrive-search:queries:v1";

/**
 * Load persisted query sessions from localStorage, applying field migrations for
 * sessions saved by older versions. Returns null when nothing valid is stored
 * (and clears a corrupt entry). A `running` session can never resume across a
 * reload, so it is downgraded to `error`.
 */
export function loadStoredSessions(): QuerySession[] | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as QuerySession[];
    if (!Array.isArray(parsed)) return null;
    return parsed.map((session) => ({
      ...session,
      curateList: session.curateList ?? false,
      answerFormat: session.answerFormat ?? ("plain" as const),
      // Sessions persisted before the touched/sources split stored every found
      // file in `files`; treat that as the touched set so the disclosure still
      // renders for old runs.
      touchedFiles: session.touchedFiles ?? session.files ?? [],
      reviewingFiles: [],
      ...(session.status === "running"
        ? {
            status: "error" as const,
            error: session.error || "This run was interrupted before it finished."
          }
        : {})
    }));
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

/** Persist the query sessions to localStorage. */
export function saveStoredSessions(sessions: QuerySession[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}
