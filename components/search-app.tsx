// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import { useCallback, useState } from "react";
import { SettingsDialog, type ModelSettingsSummary } from "@/components/settings-dialog";
import { useQuerySessions } from "@/hooks/use-query-sessions";
import { ConnectionsStrip } from "@/components/search/connections-strip";
import { LoginPanel } from "@/components/search/login-panel";
import { QueryForm } from "@/components/search/query-form";
import { QueryList } from "@/components/search/query-list";
import { ResultsView } from "@/components/search/results-view";
import { RunStatus } from "@/components/search/run-status";
import { TopBar } from "@/components/search/top-bar";
import type { DriveConnection, User } from "@/components/search/types";

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
  } = useQuerySessions();

  const hasConnections = connections.length > 0;

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
      <TopBar user={user} onOpenSettings={openSettings} />

      <main className="main">
        {!user ? (
          <LoginPanel />
        ) : (
          <>
            {settingsOpen ? (
              <SettingsDialog
                modelSettings={modelSettings}
                onSettingsChange={setModelSettings}
                onClose={closeSettings}
              />
            ) : null}

            <ConnectionsStrip connections={connections} onDisconnect={disconnectDrive} />

            <section className="layout">
              <QueryList
                sessions={sessions}
                activeSessionId={activeSessionId}
                onNew={newQuery}
                onSelect={selectSession}
                onArchive={archiveSession}
              />

              <div className="form-grid">
                <QueryForm
                  connections={connections}
                  hasConnections={hasConnections}
                  selectedDrive={selectedDrive}
                  mode={mode}
                  curateList={curateList}
                  query={query}
                  runningSessionCount={runningSessionCount}
                  onUpdateSelectedDrive={updateSelectedDrive}
                  onUpdateMode={updateMode}
                  onUpdateCurateList={updateCurateList}
                  onUpdateQuery={updateQuery}
                  onRun={runAgent}
                />

                <RunStatus activeSession={activeSession} runningSessionCount={runningSessionCount} />

                <ResultsView
                  activeSession={activeSession}
                  uniqueFiles={uniqueFiles}
                  touchedFiles={touchedFiles}
                  reviewingFiles={reviewingFiles}
                  progressOpen={progressOpen}
                  setProgressOpen={setProgressOpen}
                />
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
