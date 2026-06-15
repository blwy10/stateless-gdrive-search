// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { dedupeFiles, fileKey, type DriveFile, type QuerySession } from "./query-sessions/types";
import { loadStoredSessions, saveStoredSessions } from "./query-sessions/storage";
import { applyStreamEvent, streamAgentQuery } from "./query-sessions/stream";

export type { DriveFile, QuerySession } from "./query-sessions/types";

// Owns the saved-query sessions: the in-progress form state, localStorage
// persistence, the SSE streaming loop, and the derived values the UI renders.
// Persistence (./query-sessions/storage) and the stream parsing + per-event
// reducer (./query-sessions/stream) live in their own modules.
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
    const restored = loadStoredSessions();
    if (restored) {
      setSessions(restored);
      setActiveSessionId(restored[0]?.id ?? null);
      if (restored[0]) {
        setQuery(restored[0].query);
        setMode(restored[0].mode);
        setCurateList(restored[0].curateList);
        setSelectedDrive(restored[0].selectedDrive);
      }
    }
    setHasLoadedSessions(true);
  }, []);

  // Persist on change, debounced. Live reasoning deltas update `sessions` very
  // frequently during a run; debouncing coalesces those into one write so we don't
  // hammer localStorage on every token. The trailing timer flushes the final state.
  useEffect(() => {
    if (!hasLoadedSessions) return;
    const handle = window.setTimeout(() => saveStoredSessions(sessions), 300);
    return () => window.clearTimeout(handle);
  }, [hasLoadedSessions, sessions]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions]
  );

  const uniqueFiles = useMemo(() => dedupeFiles(activeSession?.files ?? []), [activeSession]);

  // The audit/disclosure set: every file the agent touched this run, deduped.
  const touchedFiles = useMemo(
    () => dedupeFiles(activeSession?.touchedFiles ?? []),
    [activeSession]
  );

  // Curated mode: files still being judged, with anything already promoted to
  // results (kept) or duplicated filtered out.
  const reviewingFiles = useMemo(() => {
    const resultKeys = new Set(uniqueFiles.map(fileKey));
    return dedupeFiles(activeSession?.reviewingFiles ?? []).filter(
      (file) => !resultKeys.has(fileKey(file))
    );
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
      reasoning: "",
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

  // Update the streamed session in place via the pure reducer; control-flow side
  // effects (progress drawer, terminal-event tracking) stay here.
  function applyEventToSession(sessionId: string, event: Parameters<typeof applyStreamEvent>[1]) {
    setSessions((current) =>
      current.map((item) => (item.id === sessionId ? applyStreamEvent(item, event) : item))
    );
  }

  function markSessionError(sessionId: string, error: string, onlyIfRunning = false) {
    setSessions((current) =>
      current.map((item) =>
        item.id === sessionId && (!onlyIfRunning || item.status === "running")
          ? { ...item, status: "error", error, updatedAt: new Date().toISOString() }
          : item
      )
    );
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
      reasoning: "",
      answer: "",
      answerFormat: "plain",
      error: ""
    };

    setActiveSessionId(session.id);
    upsertSession(session);
    setProgressOpen(true);
    let receivedTerminalEvent = false;

    try {
      await streamAgentQuery({ query: trimmedQuery, mode, curateList, selectedDrive }, (event) => {
        if (event.type === "final") setProgressOpen(false);
        if (event.type === "final" || event.type === "error") receivedTerminalEvent = true;
        applyEventToSession(session.id, event);
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Agent request failed";
      markSessionError(session.id, message);
    } finally {
      if (!receivedTerminalEvent) {
        markSessionError(session.id, "The agent stopped before returning a final result.", true);
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
