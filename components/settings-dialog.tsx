// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import { useEffect, useState } from "react";

export type ModelSettingsSummary = {
  hasCustomModel: boolean;
  apiKeyConfigured: boolean;
  baseUrl: string | null;
  model: string | null;
  updatedAt: string | null;
};

// Modal for managing the optional bring-your-own OpenAI-compatible provider.
// The persisted summary lives in the owner so it survives close/reopen; this
// component owns only the transient form draft plus the save/delete requests.
export function SettingsDialog({
  modelSettings,
  onSettingsChange,
  onClose
}: {
  modelSettings: ModelSettingsSummary | null;
  onSettingsChange: (settings: ModelSettingsSummary) => void;
  onClose: () => void;
}) {
  const hasCustomModel = modelSettings?.hasCustomModel ?? false;
  const [baseUrl, setBaseUrl] = useState(() =>
    modelSettings?.hasCustomModel ? (modelSettings.baseUrl ?? "") : ""
  );
  const [model, setModel] = useState(() =>
    modelSettings?.hasCustomModel ? (modelSettings.model ?? "") : ""
  );
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function saveModelSettings() {
    setSaving(true);
    setMessage("");
    setError("");

    try {
      const body: { baseUrl: string; model: string; apiKey?: string } = {
        baseUrl,
        model
      };
      if (apiKey.trim()) {
        body.apiKey = apiKey;
      }

      const response = await fetch("/api/settings/model", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = (await response.json()) as {
        settings?: ModelSettingsSummary;
        error?: string;
      };
      if (!response.ok || !data.settings) {
        throw new Error(data.error || "Unable to save model settings");
      }

      onSettingsChange(data.settings);
      setBaseUrl(data.settings.baseUrl ?? "");
      setModel(data.settings.model ?? "");
      setApiKey("");
      setMessage("Custom model settings saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save model settings");
    } finally {
      setSaving(false);
    }
  }

  async function deleteModelSettings() {
    setSaving(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/settings/model", { method: "DELETE" });
      const data = (await response.json()) as {
        settings?: ModelSettingsSummary;
        error?: string;
      };
      if (!response.ok || !data.settings) {
        throw new Error(data.error || "Unable to delete model settings");
      }

      onSettingsChange(data.settings);
      setBaseUrl("");
      setModel("");
      setApiKey("");
      setMessage("Default provider restored.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete model settings");
    } finally {
      setSaving(false);
    }
  }

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
          <section className="settings-current-provider" aria-labelledby="current-provider-title">
            <div className="settings-section-heading">
              <h3 id="current-provider-title">Current provider</h3>
              <span className={`provider-badge ${hasCustomModel ? "custom" : "default"}`}>
                {hasCustomModel ? "Custom" : "Default"}
              </span>
            </div>
            <p>
              {hasCustomModel
                ? "Searches are using your saved endpoint and model."
                : "Searches are using the app-managed model provider."}
            </p>
            {hasCustomModel ? (
              <dl className="provider-details">
                <div>
                  <dt>Endpoint</dt>
                  <dd>{modelSettings?.baseUrl}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{modelSettings?.model}</dd>
                </div>
                <div>
                  <dt>API key</dt>
                  <dd>Configured</dd>
                </div>
              </dl>
            ) : null}
          </section>

          <div className="settings-note">
            API keys are write-only. After saving, the key cannot be viewed here again.
          </div>

          <section className="settings-form-section" aria-labelledby="custom-provider-title">
            <div className="settings-section-heading">
              <h3 id="custom-provider-title">Custom provider</h3>
            </div>
            <p className="settings-help">
              {hasCustomModel
                ? "Update your saved OpenAI-compatible endpoint, model, or API key."
                : "Add your own OpenAI-compatible endpoint, model, and API key."}
            </p>

          <div className="field">
            <label htmlFor="model-base-url">OpenAI-compatible endpoint</label>
            <input
              id="model-base-url"
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </div>

          <div className="field">
            <label htmlFor="model-name">Model name</label>
            <input
              id="model-name"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="gpt-4.1-mini"
            />
          </div>

          <div className="field">
            <label htmlFor="model-api-key">
              API key
              {modelSettings?.apiKeyConfigured ? (
                <span className="inline-status">configured</span>
              ) : null}
            </label>
            <input
              id="model-api-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                modelSettings?.apiKeyConfigured
                  ? "Leave blank to keep existing key"
                  : "Required for custom provider"
              }
              autoComplete="new-password"
              spellCheck={false}
            />
          </div>

          {error ? <div className="form-message error">{error}</div> : null}
          {message ? (
            <div className="form-message success">{message}</div>
          ) : null}

          <div className="settings-actions">
            <button
              className="button"
              type="button"
              onClick={saveModelSettings}
              disabled={saving}
            >
              {hasCustomModel ? "Update custom provider" : "Save custom provider"}
            </button>
            {hasCustomModel ? (
              <button
                className="button secondary"
                type="button"
                onClick={deleteModelSettings}
                disabled={saving}
              >
                Use default provider
              </button>
            ) : null}
          </div>
          </section>
        </div>
      </div>
    </section>
  );
}
