// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export type DriveFile = {
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
  | { type: "reviewing"; file: DriveFile }
  | { type: "kept"; file: DriveFile }
  | { type: "discarded"; file: DriveFile }
  | {
      type: "final";
      answer: string;
      answerFormat: "markdown" | "plain";
      files: DriveFile[];
      touchedFiles: DriveFile[];
    }
  | { type: "error"; message: string };

export type QuerySession = {
  id: string;
  query: string;
  mode: "synthesis" | "list";
  curateList: boolean;
  selectedDrive: string;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "running" | "finished" | "error";
  events: string[];
  // Primary result list: synthesis -> the files the answer cites; curated list ->
  // examiner-kept files; uncurated list -> every match. A subset of touchedFiles.
  files: DriveFile[];
  // Audit/disclosure list: every file the agent encountered this run (search
  // candidates + opened/reviewed), across all modes. Streamed live via `file`
  // events and finalized authoritatively by the `final` event.
  touchedFiles: DriveFile[];
  // Curated list mode only: files the agent is reading and grading right now.
  // Each one resolves to either `files` (kept) or removal (discarded), and the
  // list is cleared when the run settles. Transient/UI-only, but kept on the
  // session so the UI renders from a single source of truth.
  reviewingFiles: DriveFile[];
  answer: string;
  answerFormat: "markdown" | "plain";
  error: string;
};

const STORAGE_KEY = "stateless-gdrive-search:queries:v1";

// Owns the saved-query sessions: the in-progress form state, localStorage
// persistence, the SSE streaming loop, and the derived values the UI renders.
export function useQuerySessions() {
  const [selectedDrive, setSelectedDrive] = useState("all");
  const [mode, setMode] = useState<"synthesis" | "list">("synthesis");
  const [curateList, setCurateList] = useState(false);
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<QuerySession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [hasLoadedSessions, setHasLoadedSessions] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);

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
            // Sessions persisted before the touched/sources split stored every
            // found file in `files`; treat that as the touched set so the
            // disclosure still renders for old runs.
            touchedFiles: session.touchedFiles ?? session.files ?? [],
            reviewingFiles: [],
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

  const uniqueFiles = useMemo(() => {
    const seen = new Set<string>();
    return (activeSession?.files ?? []).filter((file) => {
      const key = `${file.connectionId}:${file.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [activeSession]);

  // The audit/disclosure set: every file the agent touched this run, deduped.
  const touchedFiles = useMemo(() => {
    const seen = new Set<string>();
    return (activeSession?.touchedFiles ?? []).filter((file) => {
      const key = `${file.connectionId}:${file.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [activeSession]);

  // Curated mode: files still being judged, with anything already promoted to
  // results (kept) or duplicated filtered out.
  const reviewingFiles = useMemo(() => {
    const resultKeys = new Set(uniqueFiles.map((file) => `${file.connectionId}:${file.id}`));
    const seen = new Set<string>();
    return (activeSession?.reviewingFiles ?? []).filter((file) => {
      const key = `${file.connectionId}:${file.id}`;
      if (resultKeys.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [activeSession, uniqueFiles]);

  const runningSessionCount = sessions.filter((session) => session.status === "running").length;

  // Drive connections live outside this hook; when the last one is removed the
  // owner resets the scope here without persisting it onto the active draft.
  const resetDriveScope = useCallback(() => setSelectedDrive("all"), []);

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
      touchedFiles: [],
      reviewingFiles: [],
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
    setProgressOpen(session.status === "running");
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
      touchedFiles: [],
      reviewingFiles: [],
      answer: "",
      answerFormat: "plain",
      error: ""
    };

    setActiveSessionId(session.id);
    upsertSession(session);
    setProgressOpen(true);
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
            // A file the agent encountered. It always joins the "touched" audit
            // list; in uncurated list mode it is also a result, so mirror it into
            // `files` for live streaming. Synthesis sources and curated keeps
            // arrive authoritatively via `final`/`kept`, so they are not mirrored.
            setSessions((current) =>
              current.map((item) => {
                if (item.id !== session.id) return item;
                const isUncuratedList = item.mode === "list" && !item.curateList;
                return {
                  ...item,
                  touchedFiles: [...item.touchedFiles, event.file],
                  ...(isUncuratedList ? { files: [...item.files, event.file] } : {}),
                  updatedAt: new Date().toISOString()
                };
              })
            );
          } else if (event.type === "reviewing") {
            // Curated mode: a provisional candidate the agent is still judging.
            setSessions((current) =>
              current.map((item) =>
                item.id === session.id
                  ? {
                      ...item,
                      reviewingFiles: [...item.reviewingFiles, event.file],
                      updatedAt: new Date().toISOString()
                    }
                  : item
              )
            );
          } else if (event.type === "kept") {
            // Curated mode: promote the file from "reviewing" into the results.
            const keptKey = `${event.file.connectionId}:${event.file.id}`;
            setSessions((current) =>
              current.map((item) =>
                item.id === session.id
                  ? {
                      ...item,
                      files: [...item.files, event.file],
                      reviewingFiles: item.reviewingFiles.filter(
                        (file) => `${file.connectionId}:${file.id}` !== keptKey
                      ),
                      updatedAt: new Date().toISOString()
                    }
                  : item
              )
            );
          } else if (event.type === "discarded") {
            // Curated mode: the grader judged this file irrelevant, so drop it
            // from "reviewing" without adding it to the results.
            const discardedKey = `${event.file.connectionId}:${event.file.id}`;
            setSessions((current) =>
              current.map((item) =>
                item.id === session.id
                  ? {
                      ...item,
                      reviewingFiles: item.reviewingFiles.filter(
                        (file) => `${file.connectionId}:${file.id}` !== discardedKey
                      ),
                      updatedAt: new Date().toISOString()
                    }
                  : item
              )
            );
          } else if (event.type === "final") {
            receivedTerminalEvent = true;
            setProgressOpen(false);
            setSessions((current) =>
              current.map((item) =>
                item.id === session.id
                  ? {
                      ...item,
                      status: "finished",
                      answer: event.answer,
                      answerFormat: event.answerFormat,
                      files: event.files,
                      touchedFiles: event.touchedFiles,
                      reviewingFiles: [],
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
                      reviewingFiles: [],
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

  return {
    sessions,
    activeSessionId,
    activeSession,
    uniqueFiles,
    touchedFiles,
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
  };
}
