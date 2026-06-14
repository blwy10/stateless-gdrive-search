// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { validatePublicHttpsBaseUrl } from "@/lib/ssrf";
import { coerceModelProvider, coerceReasoningEffort } from "./constants";
import type { EffectiveModelSettings, RoleColumns, RoleSettingsSummary } from "./types";

/**
 * Resolve one role's effective settings from its (already-decrypted) stored
 * columns, falling back to the role's env default when the row has no override
 * for it. A role counts as overridden only when BOTH its model and api key are
 * present, so a row that only overrides the other role leaves this one on its env
 * default. Pure (no DB/network) so the selection logic stays unit-testable;
 * baseUrl validation for custom rows is applied separately by the async caller.
 */
export function resolveRoleSettings(
  columns: {
    apiKey: string | null;
    baseUrl: string | null;
    model: string | null;
    provider: string | null;
    reasoningEffort: string | null;
  },
  envDefault: EffectiveModelSettings
): EffectiveModelSettings {
  if (!columns.model || !columns.apiKey) {
    return envDefault;
  }
  return {
    provider: coerceModelProvider(columns.provider),
    apiKey: columns.apiKey,
    baseUrl: columns.baseUrl,
    model: columns.model,
    reasoningEffort: coerceReasoningEffort(columns.reasoningEffort),
    source: "custom"
  };
}

// Re-validate a stored (custom) endpoint at run start (TOCTOU defense). Env
// defaults are operator-trusted and skip validation, matching prior behaviour.
export async function withValidatedBaseUrl(
  settings: EffectiveModelSettings
): Promise<EffectiveModelSettings> {
  if (settings.source === "custom" && settings.baseUrl) {
    return { ...settings, baseUrl: await validatePublicHttpsBaseUrl(settings.baseUrl) };
  }
  return settings;
}

export function emptyRoleSummary(): RoleSettingsSummary {
  return {
    hasCustomModel: false,
    apiKeyConfigured: false,
    provider: null,
    baseUrl: null,
    model: null,
    reasoningEffort: null,
    updatedAt: null
  };
}

export function roleSummary(columns: RoleColumns, updatedAt: string): RoleSettingsSummary {
  if (!columns.model || !columns.apiKeyCiphertext) {
    return emptyRoleSummary();
  }
  return {
    hasCustomModel: true,
    apiKeyConfigured: true,
    provider: coerceModelProvider(columns.provider),
    baseUrl: columns.baseUrl,
    model: columns.model,
    reasoningEffort: coerceReasoningEffort(columns.reasoningEffort),
    updatedAt
  };
}
