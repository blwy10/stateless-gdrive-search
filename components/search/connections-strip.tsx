// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import type { DriveConnection } from "./types";

export function ConnectionsStrip({
  connections,
  onDisconnect
}: {
  connections: DriveConnection[];
  onDisconnect: (id: string) => void;
}) {
  return (
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
                  onClick={() => onDisconnect(connection.id)}
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
  );
}
