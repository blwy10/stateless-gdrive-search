// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import type { QuerySession } from "@/hooks/use-query-sessions";
import { formatDateTime } from "./format";

export function QueryList({
  sessions,
  activeSessionId,
  onNew,
  onSelect,
  onArchive
}: {
  sessions: QuerySession[];
  activeSessionId: string | null;
  onNew: () => void;
  onSelect: (session: QuerySession) => void;
  onArchive: (sessionId: string) => void;
}) {
  return (
    <aside className="panel">
      <div className="panel-header">
        <h2>Queries</h2>
        <button className="button secondary" type="button" onClick={onNew}>
          New
        </button>
      </div>
      <div className="panel-body">
        {sessions.length === 0 ? (
          <p className="muted">Completed searches will appear here.</p>
        ) : (
          <div className="query-list">
            {sessions.map((session) => (
              <div
                className={`query-item ${session.id === activeSessionId ? "active" : ""}`}
                key={session.id}
              >
                <button
                  className="query-item-select"
                  type="button"
                  onClick={() => onSelect(session)}
                >
                  <span className={`status-dot ${session.status}`} aria-hidden="true" />
                  <span className="query-item-main">
                    <strong>{session.query || "Untitled query"}</strong>
                    <span>{formatDateTime(session.updatedAt)}</span>
                  </span>
                </button>
                <button
                  className="query-archive-button"
                  type="button"
                  title="Archive"
                  aria-label={`Archive ${session.query || "untitled query"}`}
                  onClick={() => onArchive(session.id)}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                  >
                    <path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8" />
                    <path d="M1 3h22v5H1z" />
                    <path d="M10 12h4" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
