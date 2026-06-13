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
 * Coerce a stored/env provider string to a known {@link ModelProvider},
 * defaulting to "openai" for anything unset or unrecognized. DB rows carry a
 * NOT NULL default, so this mainly guards the operator-supplied AI_PROVIDER env.
 */
export function coerceModelProvider(value: string | null | undefined): ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value ?? "")
    ? (value as ModelProvider)
    : "openai";
}

export type ModelSettingsSummary = {
  hasCustomModel: boolean;
  apiKeyConfigured: boolean;
  provider: ModelProvider | null;
  baseUrl: string | null;
  model: string | null;
  updatedAt: string | null;
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

const ModelSettingsInput = z
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

export type ModelSettingsInput = z.infer<typeof ModelSettingsInput>;

type ModelSettingsRow = {
  api_key_ciphertext: string;
  base_url: string | null;
  model: string;
  provider: string;
  updated_at: Date;
};

export function parseModelSettingsInput(value: unknown) {
  return ModelSettingsInput.parse(value);
}

export async function getModelSettingsSummary(ownerSub: string): Promise<ModelSettingsSummary> {
  const row = await getModelSettingsRow(ownerSub);
  if (!row) {
    return {
      hasCustomModel: false,
      apiKeyConfigured: false,
      provider: null,
      baseUrl: null,
      model: null,
      updatedAt: null
    };
  }

  return {
    hasCustomModel: true,
    apiKeyConfigured: true,
    provider: coerceModelProvider(row.provider),
    baseUrl: row.base_url,
    model: row.model,
    updatedAt: row.updated_at.toISOString()
  };
}

export async function getEffectiveModelSettings(ownerSub: string): Promise<EffectiveModelSettings> {
  const row = await getModelSettingsRow(ownerSub);
  if (!row) {
    return {
      provider: coerceModelProvider(env.aiProvider()),
      apiKey: env.aiApiKey(),
      baseUrl: env.aiBaseUrl(),
      model: env.aiModel(),
      source: "default"
    };
  }

  return {
    provider: coerceModelProvider(row.provider),
    apiKey: decryptSecret(row.api_key_ciphertext),
    // Re-validate the stored endpoint at run start (TOCTOU defense), but only
    // when one was saved — native providers have no base_url.
    baseUrl: row.base_url ? await validatePublicHttpsBaseUrl(row.base_url) : null,
    model: row.model,
    source: "custom"
  };
}

export async function upsertModelSettings(ownerSub: string, input: ModelSettingsInput) {
  // Only user-supplied endpoints are SSRF-validated; native providers store no
  // base_url (they use their official endpoint).
  const baseUrl = input.baseUrl ? await validatePublicHttpsBaseUrl(input.baseUrl) : null;
  const existing = await getModelSettingsRow(ownerSub);
  const apiKeyCiphertext = input.apiKey
    ? encryptSecret(input.apiKey)
    : existing?.api_key_ciphertext;

  if (!apiKeyCiphertext) {
    throw new Error("API key is required before custom model settings can be saved");
  }

  await getPool().query(
    `insert into user_model_settings (
       owner_sub, api_key_ciphertext, base_url, model, provider, updated_at
     )
     values ($1, $2, $3, $4, $5, now())
     on conflict (owner_sub)
     do update set
       api_key_ciphertext = excluded.api_key_ciphertext,
       base_url = excluded.base_url,
       model = excluded.model,
       provider = excluded.provider,
       updated_at = now()`,
    [ownerSub, apiKeyCiphertext, baseUrl, input.model, input.provider]
  );
}

export async function deleteModelSettings(ownerSub: string) {
  await getPool().query(`delete from user_model_settings where owner_sub = $1`, [ownerSub]);
}

async function getModelSettingsRow(ownerSub: string): Promise<ModelSettingsRow | null> {
  const result = await getPool().query(
    `select api_key_ciphertext, base_url, model, provider, updated_at
     from user_model_settings
     where owner_sub = $1`,
    [ownerSub]
  );
  return result.rows[0] ?? null;
}
