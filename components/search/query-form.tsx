// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import type { DriveConnection } from "./types";

export function QueryForm({
  connections,
  hasConnections,
  selectedDrive,
  mode,
  curateList,
  query,
  runningSessionCount,
  onUpdateSelectedDrive,
  onUpdateMode,
  onUpdateCurateList,
  onUpdateQuery,
  onRun
}: {
  connections: DriveConnection[];
  hasConnections: boolean;
  selectedDrive: string;
  mode: "synthesis" | "list";
  curateList: boolean;
  query: string;
  runningSessionCount: number;
  onUpdateSelectedDrive: (value: string) => void;
  onUpdateMode: (value: "synthesis" | "list") => void;
  onUpdateCurateList: (value: boolean) => void;
  onUpdateQuery: (value: string) => void;
  onRun: () => void;
}) {
  return (
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
            onChange={(event) => onUpdateSelectedDrive(event.target.value)}
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
                onChange={() => onUpdateMode("synthesis")}
              />
              <span>Synthesis</span>
            </label>
            <label className="radio-card">
              <input type="radio" checked={mode === "list"} onChange={() => onUpdateMode("list")} />
              <span>File list</span>
            </label>
          </div>
        </div>

        {mode === "list" ? (
          <label className="checkbox-card">
            <input
              type="checkbox"
              checked={curateList}
              onChange={(event) => onUpdateCurateList(event.target.checked)}
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
            onChange={(event) => onUpdateQuery(event.target.value)}
            placeholder="Find the latest roadmap notes about enterprise search"
          />
        </div>

        <button
          className="button"
          type="button"
          onClick={onRun}
          disabled={!hasConnections || !query.trim()}
        >
          {runningSessionCount > 0 ? "Run another search" : "Run search"}
        </button>
      </div>
    </section>
  );
}
