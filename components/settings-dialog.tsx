// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import { useEffect, useState } from "react";

export type ModelProvider = "openai" | "anthropic" | "openai-compatible";

export type RoleSettingsSummary = {
  hasCustomModel: boolean;
  apiKeyConfigured: boolean;
  provider: ModelProvider | null;
  baseUrl: string | null;
  model: string | null;
  updatedAt: string | null;
};

export type ModelSettingsSummary = {
  main: RoleSettingsSummary;
  grader: RoleSettingsSummary;
};

type ModelRole = "main" | "grader";

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

const ROLE_META: Record<ModelRole, { title: string; help: string }> = {
  main: {
    title: "Main model",
    help: "Runs the research agent and writes the synthesis answer."
  },
  grader: {
    title: "Grader model",
    help: "A separate, cheaper model that only judges per-file relevance."
  }
};

// Modal for managing the optional bring-your-own provider. The main and grader
// roles are configured independently; each section owns its transient form draft
// plus the save/delete requests, while the persisted summary lives in the owner.
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
            API keys are write-only. After saving, a key cannot be viewed here again. The main and
            grader models are configured independently.
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
        </div>
      </div>
    </section>
  );
}

function RoleSettingsForm({
  role,
  summary,
  onSettingsChange
}: {
  role: ModelRole;
  summary: RoleSettingsSummary | null;
  onSettingsChange: (settings: ModelSettingsSummary) => void;
}) {
  const meta = ROLE_META[role];
  const hasCustomModel = summary?.hasCustomModel ?? false;
  const [provider, setProvider] = useState<ModelProvider>(() => summary?.provider ?? "openai");
  const [baseUrl, setBaseUrl] = useState(() => (hasCustomModel ? (summary?.baseUrl ?? "") : ""));
  const [model, setModel] = useState(() => (hasCustomModel ? (summary?.model ?? "") : ""));
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const baseUrlRequired = provider === "openai-compatible";

  async function save() {
    setSaving(true);
    setMessage("");
    setError("");

    try {
      const roleBody: { provider: ModelProvider; model: string; baseUrl?: string; apiKey?: string } = {
        provider,
        model
      };
      // Native providers use their official endpoint; only send a base URL when
      // one was actually entered (required for openai-compatible).
      if (baseUrl.trim()) {
        roleBody.baseUrl = baseUrl.trim();
      }
      if (apiKey.trim()) {
        roleBody.apiKey = apiKey;
      }

      const response = await fetch("/api/settings/model", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [role]: roleBody })
      });
      const data = (await response.json()) as { settings?: ModelSettingsSummary; error?: string };
      if (!response.ok || !data.settings) {
        throw new Error(data.error || "Unable to save model settings");
      }

      onSettingsChange(data.settings);
      const updated = data.settings[role];
      setProvider(updated.provider ?? "openai");
      setBaseUrl(updated.baseUrl ?? "");
      setModel(updated.model ?? "");
      setApiKey("");
      setMessage(`${meta.title} saved.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save model settings");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch(`/api/settings/model?role=${role}`, { method: "DELETE" });
      const data = (await response.json()) as { settings?: ModelSettingsSummary; error?: string };
      if (!response.ok || !data.settings) {
        throw new Error(data.error || "Unable to delete model settings");
      }

      onSettingsChange(data.settings);
      setProvider("openai");
      setBaseUrl("");
      setModel("");
      setApiKey("");
      setMessage(`${meta.title} reset to default.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete model settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-form-section" aria-label={meta.title}>
      <div className="settings-section-heading">
        <h3>{meta.title}</h3>
        <span className={`provider-badge ${hasCustomModel ? "custom" : "default"}`}>
          {hasCustomModel ? "Custom" : "Default"}
        </span>
      </div>
      <p className="settings-help">{meta.help}</p>

      {hasCustomModel ? (
        <dl className="provider-details">
          <div>
            <dt>Provider</dt>
            <dd>{summary?.provider ? PROVIDER_LABELS[summary.provider] : "—"}</dd>
          </div>
          {summary?.baseUrl ? (
            <div>
              <dt>Endpoint</dt>
              <dd>{summary.baseUrl}</dd>
            </div>
          ) : null}
          <div>
            <dt>Model</dt>
            <dd>{summary?.model}</dd>
          </div>
          <div>
            <dt>API key</dt>
            <dd>Configured</dd>
          </div>
        </dl>
      ) : (
        <p>Using the app-managed provider for this role.</p>
      )}

      <div className="field">
        <label htmlFor={`${role}-model-provider`}>Provider</label>
        <select
          id={`${role}-model-provider`}
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
        <label htmlFor={`${role}-model-base-url`}>
          Endpoint URL
          <span className="inline-status">{baseUrlRequired ? "required" : "optional"}</span>
        </label>
        <input
          id={`${role}-model-base-url`}
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
        <label htmlFor={`${role}-model-name`}>Model name</label>
        <input
          id={`${role}-model-name`}
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="gpt-4.1-mini"
        />
      </div>

      <div className="field">
        <label htmlFor={`${role}-model-api-key`}>
          API key
          {summary?.apiKeyConfigured ? <span className="inline-status">configured</span> : null}
        </label>
        <input
          id={`${role}-model-api-key`}
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={
            summary?.apiKeyConfigured
              ? "Leave blank to keep existing key"
              : "Required for custom provider"
          }
          autoComplete="new-password"
          spellCheck={false}
        />
      </div>

      {error ? <div className="form-message error">{error}</div> : null}
      {message ? <div className="form-message success">{message}</div> : null}

      <div className="settings-actions">
        <button className="button" type="button" onClick={save} disabled={saving}>
          {hasCustomModel ? "Update" : "Save"}
        </button>
        {hasCustomModel ? (
          <button className="button secondary" type="button" onClick={remove} disabled={saving}>
            Use default
          </button>
        ) : null}
      </div>
    </section>
  );
}
