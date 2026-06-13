"use client";

import { signIn, signOut } from "next-auth/react";
import { useMemo, useState } from "react";

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
  | { type: "final"; answer: string; files: DriveFile[] }
  | { type: "error"; message: string };

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
  const [query, setQuery] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [answer, setAnswer] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");

  const hasConnections = connections.length > 0;
  const uniqueFiles = useMemo(() => {
    const seen = new Set<string>();
    return files.filter((file) => {
      const key = `${file.connectionId}:${file.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [files]);

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

  async function runAgent() {
    setIsRunning(true);
    setError("");
    setAnswer("");
    setFiles([]);
    setEvents([]);

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query,
          mode,
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
            setEvents((current) => [...current, event.message]);
          } else if (event.type === "file") {
            setFiles((current) => [...current, event.file]);
          } else if (event.type === "final") {
            setAnswer(event.answer);
            setFiles(event.files);
          } else if (event.type === "error") {
            setError(event.message);
          }
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Agent request failed");
    } finally {
      setIsRunning(false);
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
          <section className="layout">
            <aside className="panel">
              <div className="panel-header">
                <h2>Connected Drives</h2>
                <a className="button secondary" href="/api/drive/oauth/start">
                  Connect
                </a>
              </div>
              <div className="panel-body">
                {connections.length === 0 ? (
                  <p className="muted">No Drive accounts connected.</p>
                ) : (
                  <div className="drive-list">
                    {connections.map((connection) => (
                      <div className="drive-item" key={connection.id}>
                        <strong>{connection.driveName || connection.driveEmail}</strong>
                        <span className="muted">{connection.driveEmail}</span>
                        <button
                          className="button danger"
                          type="button"
                          onClick={() => disconnectDrive(connection.id)}
                        >
                          Disconnect
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
                      onChange={(event) => setSelectedDrive(event.target.value)}
                      disabled={!hasConnections || isRunning}
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
                          onChange={() => setMode("synthesis")}
                          disabled={isRunning}
                        />
                        Synthesis
                      </label>
                      <label className="radio-card">
                        <input
                          type="radio"
                          checked={mode === "list"}
                          onChange={() => setMode("list")}
                          disabled={isRunning}
                        />
                        File list
                      </label>
                    </div>
                  </div>

                  <div className="field">
                    <label htmlFor="query">Question</label>
                    <textarea
                      id="query"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Find the latest roadmap notes about enterprise search"
                      disabled={isRunning}
                    />
                  </div>

                  <button
                    className="button"
                    type="button"
                    onClick={runAgent}
                    disabled={!hasConnections || !query.trim() || isRunning}
                  >
                    {isRunning ? "Running..." : "Run agent"}
                  </button>
                  {error ? <p className="muted">{error}</p> : null}
                </div>
              </section>

              {events.length > 0 ? (
                <section className="panel">
                  <div className="panel-header">
                    <h2>Progress</h2>
                  </div>
                  <div className="panel-body stream">
                    {events.map((event, index) => (
                      <div className="stream-line" key={`${event}-${index}`}>
                        {event}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {answer ? (
                <section className="panel">
                  <div className="panel-header">
                    <h2>Answer</h2>
                  </div>
                  <div className="panel-body">
                    <div className="answer">{answer}</div>
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
        )}
      </main>
    </div>
  );
}
