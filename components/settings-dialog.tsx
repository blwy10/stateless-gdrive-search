// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import { useEffect } from "react";
import type { ModelSettingsSummary } from "@/components/settings/constants";
import { RoleSettingsForm } from "@/components/settings/role-settings-form";

export type {
  ModelProvider,
  ReasoningEffort,
  RoleSettingsSummary,
  ModelSettingsSummary
} from "@/components/settings/constants";

// Modal for managing the optional bring-your-own provider. The main, grader,
// summarizer, and ranker roles are configured independently; each RoleSettingsForm
// owns its transient draft plus the save/delete requests (see useRoleSettings),
// while the persisted summary lives in the owner.
export function SettingsDialog({
  modelSettings,
  onSettingsChange,
  onClose
}: {
  modelSettings: ModelSettingsSummary | null;
  onSettingsChange: (settings: ModelSettingsSummary) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <section className="settings-panel" aria-labelledby="settings-title">
      <div className="settings-backdrop" onClick={onClose} />
      <div className="settings-dialog">
        <div className="panel-header">
          <h2 id="settings-title">Settings</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="Close settings"
            onClick={onClose}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.4"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <div className="panel-body form-grid">
          <div className="settings-note">
            API keys are write-only. After saving, a key cannot be viewed here again. The main,
            grader, summarizer, and ranker models are configured independently.
          </div>
          <RoleSettingsForm
            key="main"
            role="main"
            summary={modelSettings?.main ?? null}
            onSettingsChange={onSettingsChange}
          />
          <RoleSettingsForm
            key="grader"
            role="grader"
            summary={modelSettings?.grader ?? null}
            onSettingsChange={onSettingsChange}
          />
          <RoleSettingsForm
            key="summarizer"
            role="summarizer"
            summary={modelSettings?.summarizer ?? null}
            onSettingsChange={onSettingsChange}
          />
          <RoleSettingsForm
            key="ranker"
            role="ranker"
            summary={modelSettings?.ranker ?? null}
            onSettingsChange={onSettingsChange}
          />
        </div>
      </div>
    </section>
  );
}
