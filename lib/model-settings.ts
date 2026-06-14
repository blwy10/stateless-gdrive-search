// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getPool } from "@/lib/db";
import { env } from "@/lib/env";
import { validatePublicHttpsBaseUrl } from "@/lib/ssrf";

export const MODEL_PROVIDERS = ["openai", "anthropic", "openai-compatible"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/**
 * The two independent model roles. `main` runs the agent loop and writes the
 * synthesis answer; `grader` is a separate, cheaper model that only judges
 * per-file relevance (see gradeFileRelevance in lib/agent.ts). Each role is
 * configured independently at the env level (both required — there is no fallback
 * between roles) and may be overridden per-user independently.
 */
export const MODEL_ROLES = ["main", "grader"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * Coerce a stored/env provider string to a known {@link ModelProvider},
 * defaulting to "openai" for anything unset or unrecognized. DB rows carry a
 * NOT NULL default, so this mainly guards the operator-supplied AI_PROVIDER env.
 */
export function coerceModelProvider(value: string | null | undefined): ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value ?? "")
    ? (value as ModelProvider)
    : "openai";
}

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

export type EffectiveModelSettings = {
  provider: ModelProvider;
  apiKey: string;
  /**
   * Null for native providers (openai, anthropic) that use their official
   * endpoint; always set for openai-compatible.
   */
  baseUrl: string | null;
  model: string;
  source: "default" | "custom";
};

/** Effective settings for both roles, resolved once per agent run. */
export type EffectiveModelSettingsBundle = {
  main: EffectiveModelSettings;
  grader: EffectiveModelSettings;
};

const RoleSettingsInput = z
  .object({
    provider: z.enum(MODEL_PROVIDERS).optional().default("openai-compatible"),
    apiKey: z.string().trim().min(1).max(4096).optional(),
    baseUrl: z.string().trim().min(1).max(2048).optional(),
    model: z.string().trim().min(1).max(200)
  })
  // Native providers use their official endpoint, but an OpenAI-compatible
  // endpoint has no default, so its URL is mandatory.
  .refine((value) => value.provider !== "openai-compatible" || Boolean(value.baseUrl), {
    message: "An endpoint URL is required for OpenAI-compatible providers",
    path: ["baseUrl"]
  });

export type RoleSettingsInput = z.infer<typeof RoleSettingsInput>;

// A save may target either role independently (or both); at least one must be
// present so an empty request is rejected rather than silently doing nothing.
const ModelSettingsInput = z
  .object({
    main: RoleSettingsInput.optional(),
    grader: RoleSettingsInput.optional()
  })
  .refine((value) => Boolean(value.main || value.grader), {
    message: "Provide settings for at least one role (main or grader)"
  });

export type ModelSettingsInput = z.infer<typeof ModelSettingsInput>;

type ModelSettingsRow = {
  api_key_ciphertext: string | null;
  base_url: string | null;
  model: string | null;
  provider: string | null;
  grader_api_key_ciphertext: string | null;
  grader_base_url: string | null;
  grader_model: string | null;
  grader_provider: string | null;
  updated_at: Date;
};

/** Raw per-role columns pulled off a {@link ModelSettingsRow}. */
type RoleColumns = {
  apiKeyCiphertext: string | null;
  baseUrl: string | null;
  model: string | null;
  provider: string | null;
};

export function parseModelSettingsInput(value: unknown) {
  return ModelSettingsInput.parse(value);
}

/** Map the `role` query param used by the per-role DELETE to a known target. */
export function parseModelRole(value: string | null | undefined): ModelRole | "all" {
  return value === "main" || value === "grader" ? value : "all";
}

function mainColumns(row: ModelSettingsRow | null): RoleColumns {
  return {
    apiKeyCiphertext: row?.api_key_ciphertext ?? null,
    baseUrl: row?.base_url ?? null,
    model: row?.model ?? null,
    provider: row?.provider ?? null
  };
}

function graderColumns(row: ModelSettingsRow | null): RoleColumns {
  return {
    apiKeyCiphertext: row?.grader_api_key_ciphertext ?? null,
    baseUrl: row?.grader_base_url ?? null,
    model: row?.grader_model ?? null,
    provider: row?.grader_provider ?? null
  };
}

function envSettings(role: ModelRole): EffectiveModelSettings {
  if (role === "grader") {
    return {
      provider: coerceModelProvider(env.graderAiProvider()),
      apiKey: env.graderAiApiKey(),
      baseUrl: env.graderAiBaseUrl(),
      model: env.graderAiModel(),
      source: "default"
    };
  }
  return {
    provider: coerceModelProvider(env.aiProvider()),
    apiKey: env.aiApiKey(),
    baseUrl: env.aiBaseUrl(),
    model: env.aiModel(),
    source: "default"
  };
}

/**
 * Resolve one role's effective settings from its (already-decrypted) stored
 * columns, falling back to the role's env default when the row has no override
 * for it. A role counts as overridden only when BOTH its model and api key are
 * present, so a row that only overrides the other role leaves this one on its env
 * default. Pure (no DB/network) so the selection logic stays unit-testable;
 * baseUrl validation for custom rows is applied separately by the async caller.
 */
export function resolveRoleSettings(
  columns: { apiKey: string | null; baseUrl: string | null; model: string | null; provider: string | null },
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
    source: "custom"
  };
}

// Re-validate a stored (custom) endpoint at run start (TOCTOU defense). Env
// defaults are operator-trusted and skip validation, matching prior behaviour.
async function withValidatedBaseUrl(
  settings: EffectiveModelSettings
): Promise<EffectiveModelSettings> {
  if (settings.source === "custom" && settings.baseUrl) {
    return { ...settings, baseUrl: await validatePublicHttpsBaseUrl(settings.baseUrl) };
  }
  return settings;
}

function emptyRoleSummary(): RoleSettingsSummary {
  return {
    hasCustomModel: false,
    apiKeyConfigured: false,
    provider: null,
    baseUrl: null,
    model: null,
    updatedAt: null
  };
}

function roleSummary(columns: RoleColumns, updatedAt: string): RoleSettingsSummary {
  if (!columns.model || !columns.apiKeyCiphertext) {
    return emptyRoleSummary();
  }
  return {
    hasCustomModel: true,
    apiKeyConfigured: true,
    provider: coerceModelProvider(columns.provider),
    baseUrl: columns.baseUrl,
    model: columns.model,
    updatedAt
  };
}

export async function getModelSettingsSummary(ownerSub: string): Promise<ModelSettingsSummary> {
  const row = await getModelSettingsRow(ownerSub);
  if (!row) {
    return { main: emptyRoleSummary(), grader: emptyRoleSummary() };
  }
  const updatedAt = row.updated_at.toISOString();
  return {
    main: roleSummary(mainColumns(row), updatedAt),
    grader: roleSummary(graderColumns(row), updatedAt)
  };
}

export async function getEffectiveModelSettings(
  ownerSub: string
): Promise<EffectiveModelSettingsBundle> {
  const envMain = envSettings("main");
  const envGrader = envSettings("grader");
  const row = await getModelSettingsRow(ownerSub);
  if (!row) {
    return { main: envMain, grader: envGrader };
  }

  const decrypt = (columns: RoleColumns) => ({
    apiKey: columns.apiKeyCiphertext ? decryptSecret(columns.apiKeyCiphertext) : null,
    baseUrl: columns.baseUrl,
    model: columns.model,
    provider: columns.provider
  });

  const main = resolveRoleSettings(decrypt(mainColumns(row)), envMain);
  const grader = resolveRoleSettings(decrypt(graderColumns(row)), envGrader);
  return {
    main: await withValidatedBaseUrl(main),
    grader: await withValidatedBaseUrl(grader)
  };
}

/**
 * Compute the final stored columns for one role on upsert. When the role is
 * present in the input it is (re)written — re-using the existing encrypted key if
 * the caller didn't supply a new one — otherwise the role's existing columns are
 * left untouched, so saving one role never clears the other.
 */
async function resolveRoleUpsert(
  input: RoleSettingsInput | undefined,
  existing: RoleColumns
): Promise<RoleColumns> {
  if (!input) {
    return existing;
  }
  const baseUrl = input.baseUrl ? await validatePublicHttpsBaseUrl(input.baseUrl) : null;
  const apiKeyCiphertext = input.apiKey ? encryptSecret(input.apiKey) : existing.apiKeyCiphertext;
  if (!apiKeyCiphertext) {
    throw new Error("API key is required before custom model settings can be saved");
  }
  return { apiKeyCiphertext, baseUrl, model: input.model, provider: input.provider };
}

export async function upsertModelSettings(ownerSub: string, input: ModelSettingsInput) {
  const existing = await getModelSettingsRow(ownerSub);
  const main = await resolveRoleUpsert(input.main, mainColumns(existing));
  const grader = await resolveRoleUpsert(input.grader, graderColumns(existing));

  await getPool().query(
    `insert into user_model_settings (
       owner_sub,
       api_key_ciphertext, base_url, model, provider,
       grader_api_key_ciphertext, grader_base_url, grader_model, grader_provider,
       updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     on conflict (owner_sub)
     do update set
       api_key_ciphertext = excluded.api_key_ciphertext,
       base_url = excluded.base_url,
       model = excluded.model,
       provider = excluded.provider,
       grader_api_key_ciphertext = excluded.grader_api_key_ciphertext,
       grader_base_url = excluded.grader_base_url,
       grader_model = excluded.grader_model,
       grader_provider = excluded.grader_provider,
       updated_at = now()`,
    [
      ownerSub,
      main.apiKeyCiphertext,
      main.baseUrl,
      main.model,
      main.provider,
      grader.apiKeyCiphertext,
      grader.baseUrl,
      grader.model,
      grader.provider
    ]
  );
}

export async function deleteModelSettings(ownerSub: string, role: ModelRole | "all" = "all") {
  if (role === "all") {
    await getPool().query(`delete from user_model_settings where owner_sub = $1`, [ownerSub]);
    return;
  }
  if (role === "grader") {
    await getPool().query(
      `update user_model_settings
         set grader_api_key_ciphertext = null,
             grader_base_url = null,
             grader_model = null,
             grader_provider = null,
             updated_at = now()
       where owner_sub = $1`,
      [ownerSub]
    );
  } else {
    await getPool().query(
      `update user_model_settings
         set api_key_ciphertext = null,
             base_url = null,
             model = null,
             provider = null,
             updated_at = now()
       where owner_sub = $1`,
      [ownerSub]
    );
  }
  // Drop the row entirely once neither role overrides anything, so an absent row
  // keeps meaning "both roles use their env defaults".
  await getPool().query(
    `delete from user_model_settings
      where owner_sub = $1 and model is null and grader_model is null`,
    [ownerSub]
  );
}

async function getModelSettingsRow(ownerSub: string): Promise<ModelSettingsRow | null> {
  const result = await getPool().query(
    `select api_key_ciphertext, base_url, model, provider,
            grader_api_key_ciphertext, grader_base_url, grader_model, grader_provider,
            updated_at
     from user_model_settings
     where owner_sub = $1`,
    [ownerSub]
  );
  return result.rows[0] ?? null;
}
