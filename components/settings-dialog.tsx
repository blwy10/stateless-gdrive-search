// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import { useEffect, useState } from "react";

export type ModelProvider = "openai" | "anthropic" | "openai-compatible";

export type ModelSettingsSummary = {
  hasCustomModel: boolean;
  apiKeyConfigured: boolean;
  provider: ModelProvider | null;
  baseUrl: string | null;
  model: string | null;
  updatedAt: string | null;
};

const PROVIDER_OPTIONS: { value: ModelProvider; label: string; hint: string }[] = [
  {
    value: "openai",
    label: "OpenAI (Responses API)",
    hint: "Uses OpenAI's official endpoint. Endpoint URL optional."
  },
  {
    value: "anthropic",
    label: "Anthropic (Claude)",
    hint: "Uses Anthropic's official endpoint. Endpoint URL optional."
  },
  {
    value: "openai-compatible",
    label: "OpenAI-compatible (Fireworks, vLLM, …)",
    hint: "Any OpenAI-compatible endpoint. Endpoint URL required."
  }
];

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI-compatible"
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
  const [provider, setProvider] = useState<ModelProvider>(
    () => modelSettings?.provider ?? "openai"
  );
  const [baseUrl, setBaseUrl] = useState(() =>
    modelSettings?.hasCustomModel ? (modelSettings.baseUrl ?? "") : ""
  );
  const [model, setModel] = useState(() =>
    modelSettings?.hasCustomModel ? (modelSettings.model ?? "") : ""
  );
  const [apiKey, setApiKey] = useState("");
  const baseUrlRequired = provider === "openai-compatible";
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
      const body: { provider: ModelProvider; model: string; baseUrl?: string; apiKey?: string } = {
        provider,
        model
      };
      // Native providers use their official endpoint; only send a base URL when
      // one was actually entered (required for openai-compatible).
      if (baseUrl.trim()) {
        body.baseUrl = baseUrl.trim();
      }
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
      setProvider(data.settings.provider ?? "openai");
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
      setProvider("openai");
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
                  <dt>Provider</dt>
                  <dd>{modelSettings?.provider ? PROVIDER_LABELS[modelSettings.provider] : "—"}</dd>
                </div>
                {modelSettings?.baseUrl ? (
                  <div>
                    <dt>Endpoint</dt>
                    <dd>{modelSettings.baseUrl}</dd>
                  </div>
                ) : null}
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
                ? "Update your saved provider, model, or API key."
                : "Use your own model provider, model, and API key."}
            </p>

          <div className="field">
            <label htmlFor="model-provider">Provider</label>
            <select
              id="model-provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value as ModelProvider)}
            >
              {PROVIDER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="settings-help">
              {PROVIDER_OPTIONS.find((option) => option.value === provider)?.hint}
            </p>
          </div>

          <div className="field">
            <label htmlFor="model-base-url">
              Endpoint URL
              <span className="inline-status">{baseUrlRequired ? "required" : "optional"}</span>
            </label>
            <input
              id="model-base-url"
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={
                baseUrlRequired
                  ? "https://api.fireworks.ai/inference/v1"
                  : "Leave blank to use the official endpoint"
              }
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
