// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import {
  PROVIDER_LABELS,
  PROVIDER_OPTIONS,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_OPTIONS,
  type ModelProvider,
  type ModelRole,
  type ModelSettingsSummary,
  type ReasoningEffort,
  type RoleSettingsSummary
} from "./constants";
import { useRoleSettings } from "./use-role-settings";

/** Read-only summary of the currently-persisted custom settings for a role. */
function RoleSummaryDetails({ summary }: { summary: RoleSettingsSummary | null }) {
  return (
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
        <dt>Reasoning effort</dt>
        <dd>
          {summary?.reasoningEffort
            ? REASONING_EFFORT_LABELS[summary.reasoningEffort]
            : "Provider default"}
        </dd>
      </div>
      <div>
        <dt>API key</dt>
        <dd>Configured</dd>
      </div>
    </dl>
  );
}

export function RoleSettingsForm({
  role,
  summary,
  onSettingsChange
}: {
  role: ModelRole;
  summary: RoleSettingsSummary | null;
  onSettingsChange: (settings: ModelSettingsSummary) => void;
}) {
  const {
    meta,
    hasCustomModel,
    provider,
    setProvider,
    baseUrl,
    setBaseUrl,
    model,
    setModel,
    reasoningEffort,
    setReasoningEffort,
    apiKey,
    setApiKey,
    message,
    error,
    saving,
    baseUrlRequired,
    save,
    remove
  } = useRoleSettings(role, summary, onSettingsChange);

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
        <RoleSummaryDetails summary={summary} />
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
        <label htmlFor={`${role}-reasoning-effort`}>Reasoning effort</label>
        <select
          id={`${role}-reasoning-effort`}
          value={reasoningEffort}
          onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
        >
          {REASONING_EFFORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="settings-help">
          Higher effort spends more reasoning tokens. Anthropic maps this to an extended-thinking
          budget; ignored by non-reasoning models. Choose “None” to use the provider default.
        </p>
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
