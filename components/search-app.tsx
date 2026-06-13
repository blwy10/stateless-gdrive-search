// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import { MarkdownContent } from "@/components/markdown";
import { SettingsDialog, type ModelSettingsSummary } from "@/components/settings-dialog";
import { useQuerySessions } from "@/hooks/use-query-sessions";
import { formatMimeType } from "@/lib/file-types";
import { signIn, signOut } from "next-auth/react";
import { useCallback, useState } from "react";

type User = {
  name: string | null;
  email: string | null;
  image: string | null;
};

type DriveConnection = {
  id: string;
  driveEmail: string;
  driveName: string | null;
  expiresAt: string | null;
  scope: string;
  createdAt: string;
  updatedAt: string;
};

export function SearchApp({
  user,
  initialConnections,
  initialModelSettings
}: {
  user: User | null;
  initialConnections: DriveConnection[];
  initialModelSettings: ModelSettingsSummary | null;
}) {
  const [connections, setConnections] = useState(initialConnections);
  const [modelSettings, setModelSettings] = useState<ModelSettingsSummary | null>(
    initialModelSettings
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  const {
    sessions,
    activeSessionId,
    activeSession,
    uniqueFiles,
    reviewingFiles,
    runningSessionCount,
    query,
    mode,
    curateList,
    selectedDrive,
    progressOpen,
    setProgressOpen,
    resetDriveScope,
    newQuery,
    selectSession,
    archiveSession,
    runAgent,
    updateQuery,
    updateMode,
    updateCurateList,
    updateSelectedDrive
  } = useQuerySessions();

  const hasConnections = connections.length > 0;

  const statusState = activeSession?.status === "running"
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

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  function openSettings() {
    setSettingsOpen(true);
  }

  async function refreshConnections() {
    const response = await fetch("/api/drive/connections");
    if (!response.ok) return;
    const data = (await response.json()) as { connections: DriveConnection[] };
    setConnections(data.connections);
    if (data.connections.length === 0) resetDriveScope();
  }

  async function disconnectDrive(id: string) {
    await fetch(`/api/drive/connections?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshConnections();
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              G
            </div>
            <span>Stateless GDrive Search</span>
          </div>
          {user ? (
            <div className="button-row">
              <span className="muted">{user.email}</span>
              <button className="button secondary" type="button" onClick={openSettings}>
                Settings
              </button>
              <button className="button secondary" type="button" onClick={() => signOut()}>
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <main className="main">
        {!user ? (
          <section className="login-panel">
            <div className="login-box">
              <h1>Search your Drive with a bounded agent</h1>
              <p>
                Sign in with Google, connect one or more read-only Drive accounts, then ask a
                focused question.
              </p>
              <button className="button" type="button" onClick={() => signIn("google")}>
                Continue with Google
              </button>
            </div>
          </section>
        ) : (
          <>
            {settingsOpen ? (
              <SettingsDialog
                modelSettings={modelSettings}
                onSettingsChange={setModelSettings}
                onClose={closeSettings}
              />
            ) : null}

            <section className="connections-strip">
              <div className="connections-strip-main">
                <strong>Connected Drives</strong>
                {connections.length === 0 ? (
                  <span className="muted">No Drive accounts connected.</span>
                ) : (
                  <div className="drive-chip-list">
                    {connections.map((connection) => (
                      <span className="drive-chip" key={connection.id}>
                        <span>{connection.driveName || connection.driveEmail}</span>
                        <button
                          type="button"
                          onClick={() => disconnectDrive(connection.id)}
                          aria-label={`Disconnect ${connection.driveEmail}`}
                        >
                          Disconnect
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <a className="button secondary" href="/api/drive/oauth/start">
                Connect
              </a>
            </section>

            <section className="layout">
              <aside className="panel">
              <div className="panel-header">
                <h2>Queries</h2>
                <button className="button secondary" type="button" onClick={newQuery}>
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
                          onClick={() => selectSession(session)}
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
                          onClick={() => archiveSession(session.id)}
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

            <div className="form-grid">
              <section className="panel">
                <div className="panel-header">
                  <h2>Query</h2>
                </div>
                <div className="panel-body form-grid">
                  <div className="field">
                    <label htmlFor="drive">Drive scope</label>
                    <select
                      id="drive"
                      value={selectedDrive}
                      onChange={(event) => updateSelectedDrive(event.target.value)}
                      disabled={!hasConnections}
                    >
                      <option value="all">All connected drives</option>
                      {connections.map((connection) => (
                        <option value={connection.id} key={connection.id}>
                          {connection.driveName || connection.driveEmail}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="field">
                    <label>Response mode</label>
                    <div className="radio-row">
                      <label className="radio-card">
                        <input
                          type="radio"
                          checked={mode === "synthesis"}
                          onChange={() => updateMode("synthesis")}
                        />
                        Synthesis
                      </label>
                      <label className="radio-card">
                        <input
                          type="radio"
                          checked={mode === "list"}
                          onChange={() => updateMode("list")}
                        />
                        File list
                      </label>
                    </div>
                  </div>

                  {mode === "list" ? (
                    <label className="checkbox-card">
                      <input
                        type="checkbox"
                        checked={curateList}
                        onChange={(event) => updateCurateList(event.target.checked)}
                      />
                      <span>
                        <strong>Curate reviewed files</strong>
                        <span>Return only files the model reviews and judges relevant.</span>
                      </span>
                    </label>
                  ) : null}

                  <div className="field">
                    <label htmlFor="query">Question</label>
                    <textarea
                      id="query"
                      value={query}
                      onChange={(event) => updateQuery(event.target.value)}
                      placeholder="Find the latest roadmap notes about enterprise search"
                    />
                  </div>

                  <button
                    className="button"
                    type="button"
                    onClick={runAgent}
                    disabled={!hasConnections || !query.trim()}
                  >
                    {runningSessionCount > 0 ? "Run another search" : "Run search"}
                  </button>
                </div>
              </section>

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

              {(activeSession?.events.length ?? 0) > 0 ? (
                <section className="panel progress-panel">
                  <div className="panel-header">
                    <h2>Progress</h2>
                    <button
                      className="progress-toggle"
                      type="button"
                      aria-expanded={progressOpen}
                      onClick={() => setProgressOpen((open) => !open)}
                    >
                      {progressOpen ? "Hide" : "Show"}
                      <span className="muted">({activeSession?.events.length ?? 0})</span>
                    </button>
                  </div>
                  {progressOpen ? (
                    <div className="panel-body stream">
                      {activeSession?.events.map((event, index) => (
                        <div className="stream-line" key={`${event}-${index}`}>
                          {event}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}

              {activeSession?.mode === "synthesis" && activeSession.answer ? (
                <section className="panel">
                  <div className="panel-header">
                    <h2>Answer</h2>
                    <button
                      className="download-button"
                      type="button"
                      onClick={() =>
                        downloadAnswer(
                          activeSession.answer,
                          activeSession.answerFormat,
                          activeSession.query
                        )
                      }
                    >
                      Download
                    </button>
                  </div>
                  <div className="panel-body">
                    <AnswerView answer={activeSession.answer} format={activeSession.answerFormat} />
                  </div>
                </section>
              ) : null}

              {uniqueFiles.length > 0 ? (
                <section className="panel">
                  <div className="panel-header">
                    <h2>Files</h2>
                  </div>
                  <div className="panel-body">
                    <ul className="file-list">
                      {uniqueFiles.map((file) => (
                        <li className="file-card" key={`${file.connectionId}:${file.id}`}>
                          {file.webViewLink ? (
                            <a href={file.webViewLink} target="_blank" rel="noreferrer">
                              {file.name}
                            </a>
                          ) : (
                            <strong>{file.name}</strong>
                          )}
                          <span className="muted">Drive account: {file.driveEmail}</span>
                          <span className="muted">Type: {formatMimeType(file.mimeType)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>
              ) : null}

              {reviewingFiles.length > 0 ? (
                <section className="panel">
                  <div className="panel-header">
                    <h2>Reviewing</h2>
                    <p className="panel-subtitle">
                      Files the agent is reading and grading right now. Only the ones judged
                      relevant are kept above.
                    </p>
                  </div>
                  <div className="panel-body">
                    <ul className="file-list">
                      {reviewingFiles.map((file) => (
                        <li className="file-card reviewing" key={`${file.connectionId}:${file.id}`}>
                          <span className="reviewing-badge">Reviewing</span>
                          {file.webViewLink ? (
                            <a href={file.webViewLink} target="_blank" rel="noreferrer">
                              {file.name}
                            </a>
                          ) : (
                            <strong>{file.name}</strong>
                          )}
                          <span className="muted">Drive account: {file.driveEmail}</span>
                          <span className="muted">Type: {formatMimeType(file.mimeType)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>
              ) : null}
            </div>
          </section>
          </>
        )}
      </main>
    </div>
  );
}

function formatDateTime(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function downloadAnswer(answer: string, format: "markdown" | "plain", query: string) {
  const extension = format === "markdown" ? "md" : "txt";
  const mimeType = format === "markdown" ? "text/markdown" : "text/plain";
  const slug = query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const filename = `${slug || "answer"}.${extension}`;
  const blob = new Blob([answer], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function AnswerView({ answer, format }: { answer: string; format: "markdown" | "plain" }) {
  if (format === "markdown") {
    return (
      <div className="answer markdown-answer">
        <MarkdownContent>{answer}</MarkdownContent>
      </div>
    );
  }
  return <div className="answer">{answer}</div>;
}
