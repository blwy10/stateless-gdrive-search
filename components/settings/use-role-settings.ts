// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import { useState } from "react";
import {
  ROLE_META,
  type ModelProvider,
  type ModelRole,
  type ModelSettingsSummary,
  type ReasoningEffort,
  type RoleSettingsSummary
} from "./constants";

/**
 * Owns one role's transient settings-form draft plus the save/delete requests.
 * The persisted summary lives in the dialog owner; this hook holds the in-flight
 * edits and reconciles them with the server response. Separated from the
 * presentation so the form component stays declarative.
 */
export function useRoleSettings(
  role: ModelRole,
  summary: RoleSettingsSummary | null,
  onSettingsChange: (settings: ModelSettingsSummary) => void
) {
  const meta = ROLE_META[role];
  const hasCustomModel = summary?.hasCustomModel ?? false;
  const [provider, setProvider] = useState<ModelProvider>(() => summary?.provider ?? "openai");
  const [baseUrl, setBaseUrl] = useState(() => (hasCustomModel ? (summary?.baseUrl ?? "") : ""));
  const [model, setModel] = useState(() => (hasCustomModel ? (summary?.model ?? "") : ""));
  // Always one of the levels; "none" is the explicit provider-default choice.
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() =>
    hasCustomModel ? (summary?.reasoningEffort ?? "none") : "none"
  );
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
      const roleBody: {
        provider: ModelProvider;
        model: string;
        baseUrl?: string;
        apiKey?: string;
        reasoningEffort: ReasoningEffort;
      } = {
        provider,
        model,
        // Always sent explicitly ("none" = provider default).
        reasoningEffort
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
      setReasoningEffort(updated.reasoningEffort ?? "none");
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
      setReasoningEffort("none");
      setApiKey("");
      setMessage(`${meta.title} reset to default.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete model settings");
    } finally {
      setSaving(false);
    }
  }

  return {
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
  };
}
