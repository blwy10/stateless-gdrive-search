"use client";

import { signIn, signOut } from "next-auth/react";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

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

type DriveFile = {
  connectionId: string;
  driveEmail: string;
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  modifiedTime?: string;
  size?: string;
};

type StreamEvent =
  | { type: "progress"; message: string }
  | { type: "file"; file: DriveFile }
  | { type: "final"; answer: string; answerFormat: "markdown" | "plain"; files: DriveFile[] }
  | { type: "error"; message: string };

type QuerySession = {
  id: string;
  query: string;
  mode: "synthesis" | "list";
  curateList: boolean;
  selectedDrive: string;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "running" | "finished" | "error";
  events: string[];
  files: DriveFile[];
  answer: string;
  answerFormat: "markdown" | "plain";
  error: string;
};

const STORAGE_KEY = "stateless-gdrive-search:queries:v1";

export function SearchApp({
  user,
  initialConnections
}: {
  user: User | null;
  initialConnections: DriveConnection[];
}) {
  const [connections, setConnections] = useState(initialConnections);
  const [selectedDrive, setSelectedDrive] = useState("all");
  const [mode, setMode] = useState<"synthesis" | "list">("synthesis");
  const [curateList, setCurateList] = useState(false);
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<QuerySession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [hasLoadedSessions, setHasLoadedSessions] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as QuerySession[];
        if (Array.isArray(parsed)) {
          const restored = parsed.map((session) => ({
            ...session,
            curateList: session.curateList ?? false,
            answerFormat: session.answerFormat ?? ("plain" as const),
            ...(session.status === "running"
              ? {
                  status: "error" as const,
                  error: session.error || "This run was interrupted before it finished."
                }
              : {})
          }));
          setSessions(restored);
          setActiveSessionId(restored[0]?.id ?? null);
          if (restored[0]) {
            setQuery(restored[0].query);
            setMode(restored[0].mode);
            setCurateList(restored[0].curateList);
            setSelectedDrive(restored[0].selectedDrive);
          }
        }
      }
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    } finally {
      setHasLoadedSessions(true);
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedSessions) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }, [hasLoadedSessions, sessions]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions]
  );

  const hasConnections = connections.length > 0;
  const uniqueFiles = useMemo(() => {
    const seen = new Set<string>();
    return (activeSession?.files ?? []).filter((file) => {
      const key = `${file.connectionId}:${file.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [activeSession]);

  const runningSessionCount = sessions.filter((session) => session.status === "running").length;

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

  async function refreshConnections() {
    const response = await fetch("/api/drive/connections");
    if (!response.ok) return;
    const data = (await response.json()) as { connections: DriveConnection[] };
    setConnections(data.connections);
    if (data.connections.length === 0) setSelectedDrive("all");
  }

  async function disconnectDrive(id: string) {
    await fetch(`/api/drive/connections?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshConnections();
  }

  function newQuery() {
    if (activeSession?.status === "draft") {
      if (query.trim()) {
        saveDraft(activeSession.id, { query, mode, curateList, selectedDrive });
      }
      return;
    }

    const existingDraft = sessions.find((session) => session.status === "draft");
    if (existingDraft) {
      setActiveSessionId(existingDraft.id);
      setQuery(existingDraft.query);
      setMode(existingDraft.mode);
      setCurateList(existingDraft.curateList);
      setSelectedDrive(existingDraft.selectedDrive);
      return;
    }

    const now = new Date().toISOString();
    const session: QuerySession = {
      id: crypto.randomUUID(),
      query: "",
      mode: "synthesis",
      curateList: false,
      selectedDrive: "all",
      createdAt: now,
      updatedAt: now,
      status: "draft",
      events: [],
      files: [],
      answer: "",
      answerFormat: "plain",
      error: ""
    };

    upsertSession(session);
    setActiveSessionId(session.id);
    setQuery("");
    setMode("synthesis");
    setCurateList(false);
    setSelectedDrive("all");
  }

  function selectSession(session: QuerySession) {
    if (session.id === activeSessionId) return;

    if (activeSession?.status === "draft") {
      if (query.trim()) {
        saveDraft(activeSession.id, { query, mode, curateList, selectedDrive });
      } else {
        setSessions((current) => current.filter((item) => item.id !== activeSession.id));
      }
    }

    setActiveSessionId(session.id);
    setQuery(session.query);
    setMode(session.mode);
    setCurateList(session.curateList);
    setSelectedDrive(session.selectedDrive);
  }

  function updateQuery(value: string) {
    setQuery(value);
    if (activeSession?.status === "draft") {
      saveDraft(activeSession.id, { query: value });
    }
  }

  function updateMode(value: "synthesis" | "list") {
    setMode(value);
    if (activeSession?.status === "draft") {
      saveDraft(activeSession.id, { mode: value });
    }
  }

  function updateCurateList(value: boolean) {
    setCurateList(value);
    if (activeSession?.status === "draft") {
      saveDraft(activeSession.id, { curateList: value });
    }
  }

  function updateSelectedDrive(value: string) {
    setSelectedDrive(value);
    if (activeSession?.status === "draft") {
      saveDraft(activeSession.id, { selectedDrive: value });
    }
  }

  function saveDraft(
    sessionId: string,
    updates:
      | Pick<QuerySession, "query" | "mode" | "curateList" | "selectedDrive">
      | Partial<Pick<QuerySession, "query" | "mode" | "curateList" | "selectedDrive">>
  ) {
    setSessions((current) =>
      current.map((item) =>
        item.id === sessionId && item.status === "draft"
          ? { ...item, ...updates, updatedAt: new Date().toISOString() }
          : item
      )
    );
  }

  function upsertSession(session: QuerySession) {
    setSessions((current) => {
      const withoutSession = current.filter((item) => item.id !== session.id);
      return [session, ...withoutSession];
    });
  }

  function archiveSession(sessionId: string) {
    const remainingSessions = sessions.filter((session) => session.id !== sessionId);
    setSessions(remainingSessions);

    if (sessionId !== activeSessionId) return;

    const nextSession = remainingSessions[0] ?? null;
    setActiveSessionId(nextSession?.id ?? null);
    setQuery(nextSession?.query ?? "");
    setMode(nextSession?.mode ?? "synthesis");
    setCurateList(nextSession?.curateList ?? false);
    setSelectedDrive(nextSession?.selectedDrive ?? "all");
  }

  async function runAgent() {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;

    const now = new Date().toISOString();
    const session: QuerySession = {
      id: activeSession?.status === "draft" ? activeSession.id : crypto.randomUUID(),
      query: trimmedQuery,
      mode,
      curateList,
      selectedDrive,
      createdAt: activeSession?.status === "draft" ? activeSession.createdAt : now,
      updatedAt: now,
      status: "running",
      events: [],
      files: [],
      answer: "",
      answerFormat: "plain",
      error: ""
    };

    setActiveSessionId(session.id);
    upsertSession(session);
    let receivedTerminalEvent = false;

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: trimmedQuery,
          mode,
          curateList,
          driveIds: [selectedDrive]
        })
      });

      if (!response.ok || !response.body) {
        throw new Error(await response.text());
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part
            .split("\n")
            .find((candidate) => candidate.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as StreamEvent;
          if (event.type === "progress") {
            setSessions((current) =>
              current.map((item) =>
                item.id === session.id
                  ? { ...item, events: [...item.events, event.message], updatedAt: new Date().toISOString() }
                  : item
              )
            );
          } else if (event.type === "file") {
            setSessions((current) =>
              current.map((item) =>
                item.id === session.id
                  ? { ...item, files: [...item.files, event.file], updatedAt: new Date().toISOString() }
                  : item
              )
            );
          } else if (event.type === "final") {
            receivedTerminalEvent = true;
            setSessions((current) =>
              current.map((item) =>
                item.id === session.id
                  ? {
                      ...item,
                      status: "finished",
                      answer: event.answer,
                      answerFormat: event.answerFormat,
                      files: event.files,
                      error: "",
                      updatedAt: new Date().toISOString()
                    }
                  : item
              )
            );
          } else if (event.type === "error") {
            receivedTerminalEvent = true;
            setSessions((current) =>
              current.map((item) =>
                item.id === session.id
                  ? {
                      ...item,
                      status: "error",
                      error: event.message,
                      updatedAt: new Date().toISOString()
                    }
                  : item
              )
            );
          }
        }
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Agent request failed";
      setSessions((current) =>
        current.map((item) =>
          item.id === session.id
            ? { ...item, status: "error", error: message, updatedAt: new Date().toISOString() }
            : item
        )
      );
    } finally {
      if (!receivedTerminalEvent) {
        setSessions((current) =>
          current.map((item) =>
            item.id === session.id && item.status === "running"
              ? {
                  ...item,
                  status: "error",
                  error: "The agent stopped before returning a final result.",
                  updatedAt: new Date().toISOString()
                }
              : item
          )
        );
      }
    }
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
                        <strong>Curate opened files</strong>
                        <span>Return only files the model opens and keeps as relevant.</span>
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
                <section className="panel">
                  <div className="panel-header">
                    <h2>Progress</h2>
                  </div>
                  <div className="panel-body stream">
                    {activeSession?.events.map((event, index) => (
                      <div className="stream-line" key={`${event}-${index}`}>
                        {event}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {activeSession?.mode === "synthesis" && activeSession.answer ? (
                <section className="panel">
                  <div className="panel-header">
                    <h2>Answer</h2>
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
                          <span className="muted">{file.driveEmail}</span>
                          <span className="muted">{file.mimeType}</span>
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

function AnswerView({ answer, format }: { answer: string; format: "markdown" | "plain" }) {
  if (format === "markdown") {
    return <div className="answer markdown-answer">{renderMarkdown(answer)}</div>;
  }
  return <div className="answer">{answer}</div>;
}

function renderMarkdown(markdown: string) {
  const blocks: ReactNode[] = [];
  const lines = markdown.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`code-${index}`}>
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const tableStart = index;
      const headers = splitMarkdownTableRow(lines[index]);
      const alignments = splitMarkdownTableRow(lines[index + 1]).map(parseMarkdownTableAlignment);
      const rows: string[][] = [];
      index += 2;

      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        rows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }

      blocks.push(
        <div className="markdown-table-wrap" key={`table-${tableStart}`}>
          <table>
            <thead>
              <tr>
                {headers.map((header, cellIndex) => (
                  <th
                    key={`table-${tableStart}-head-${cellIndex}`}
                    style={tableCellStyle(alignments[cellIndex])}
                  >
                    {renderInlineMarkdown(header, `table-${tableStart}-head-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`table-${tableStart}-row-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td
                      key={`table-${tableStart}-row-${rowIndex}-${cellIndex}`}
                      style={tableCellStyle(alignments[cellIndex])}
                    >
                      {renderInlineMarkdown(
                        row[cellIndex] ?? "",
                        `table-${tableStart}-row-${rowIndex}-${cellIndex}`
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2], `heading-${index}`);
      blocks.push(
        level === 1 ? (
          <h3 key={`heading-${index}`}>{content}</h3>
        ) : level === 2 ? (
          <h4 key={`heading-${index}`}>{content}</h4>
        ) : (
          <h5 key={`heading-${index}`}>{content}</h5>
        )
      );
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        const item = lines[index].replace(/^\s*[-*]\s+/, "");
        items.push(<li key={`li-${index}`}>{renderInlineMarkdown(item, `li-${index}`)}</li>);
        index += 1;
      }
      blocks.push(<ul key={`ul-${index}`}>{items}</ul>);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        const item = lines[index].replace(/^\s*\d+\.\s+/, "");
        items.push(<li key={`oli-${index}`}>{renderInlineMarkdown(item, `oli-${index}`)}</li>);
        index += 1;
      }
      blocks.push(<ol key={`ol-${index}`}>{items}</ol>);
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith("```") &&
      !isMarkdownTableStart(lines, index) &&
      !/^(#{1,3})\s+/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`p-${index}`}>{renderInlineMarkdown(paragraph.join(" "), `p-${index}`)}</p>
    );
  }

  return blocks;
}

function isMarkdownTableStart(lines: string[], index: number) {
  return Boolean(
    lines[index] &&
      lines[index + 1] &&
      isMarkdownTableRow(lines[index]) &&
      isMarkdownTableSeparator(lines[index + 1]) &&
      splitMarkdownTableRow(lines[index]).length === splitMarkdownTableRow(lines[index + 1]).length
  );
}

function isMarkdownTableRow(line: string) {
  return line.includes("|") && splitMarkdownTableRow(line).length > 1;
}

function isMarkdownTableSeparator(line: string) {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitMarkdownTableRow(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const character of trimmed) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }

  if (escaped) current += "\\";
  cells.push(current.trim());
  return cells;
}

function parseMarkdownTableAlignment(cell: string) {
  const trimmed = cell.trim();
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center";
  if (trimmed.endsWith(":")) return "right";
  return "left";
}

function tableCellStyle(alignment?: string): CSSProperties | undefined {
  if (alignment === "center" || alignment === "right") {
    return { textAlign: alignment };
  }
  return undefined;
}

function renderInlineMarkdown(value: string, keyPrefix: string) {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value))) {
    if (match.index > lastIndex) {
      nodes.push(value.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = safeMarkdownHref(link?.[2] ?? "");
      nodes.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {link?.[1]}
          </a>
        ) : (
          link?.[1]
        )
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < value.length) {
    nodes.push(value.slice(lastIndex));
  }

  return nodes;
}

function safeMarkdownHref(href: string) {
  return /^(https?:|mailto:)/i.test(href) ? href : "";
}
