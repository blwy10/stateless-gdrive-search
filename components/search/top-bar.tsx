// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import { signOut } from "next-auth/react";
import type { User } from "./types";

export function TopBar({ user, onOpenSettings }: { user: User | null; onOpenSettings: () => void }) {
  return (
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
            <button className="button secondary" type="button" onClick={onOpenSettings}>
              Settings
            </button>
            <button className="button secondary" type="button" onClick={() => signOut()}>
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
