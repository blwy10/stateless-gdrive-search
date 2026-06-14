// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import type { QuerySession } from "@/hooks/use-query-sessions";
import { formatDateTime } from "./format";

export function RunStatus({
  activeSession,
  runningSessionCount
}: {
  activeSession: QuerySession | null;
  runningSessionCount: number;
}) {
  const statusState =
    activeSession?.status === "running"
      ? "running"
      : activeSession?.status === "finished"
        ? "finished"
        : activeSession?.status === "error"
          ? "error"
          : "ready";

  const statusText =
    statusState === "running"
      ? "Agent running"
      : statusState === "finished"
        ? "Finished"
        : statusState === "error"
          ? "Needs attention"
          : activeSession?.status === "draft"
            ? "Draft"
            : "Ready";

  const statusDetail =
    statusState === "running"
      ? "Streaming progress and results for the active query."
      : statusState === "finished"
        ? `Completed ${formatDateTime(activeSession?.updatedAt)}.`
        : statusState === "error"
          ? activeSession?.error || "The latest run failed."
          : activeSession?.status === "draft"
            ? "Unsaved question. Run search when ready."
            : runningSessionCount > 0
              ? `${runningSessionCount} search${runningSessionCount === 1 ? "" : "es"} running. Choose one from the query list to watch it.`
              : "Choose a saved query or start a new one.";

  return (
    <section className={`run-status ${statusState}`} aria-live="polite">
      <div className="status-icon" aria-hidden="true">
        {statusState === "running"
          ? ""
          : statusState === "finished"
            ? "OK"
            : statusState === "error"
              ? "!"
              : ""}
      </div>
      <div>
        <strong>{statusText}</strong>
        <span>{statusDetail}</span>
      </div>
    </section>
  );
}
