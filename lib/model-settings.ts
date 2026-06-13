// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getPool } from "@/lib/db";
import { env } from "@/lib/env";
import { validatePublicHttpsBaseUrl } from "@/lib/ssrf";

export type ModelSettingsSummary = {
  hasCustomModel: boolean;
  apiKeyConfigured: boolean;
  baseUrl: string | null;
  model: string | null;
  updatedAt: string | null;
};

export type EffectiveModelSettings = {
  apiKey: string;
  baseUrl: string;
  model: string;
  source: "default" | "custom";
};

const ModelSettingsInput = z.object({
  apiKey: z.string().trim().min(1).max(4096).optional(),
  baseUrl: z.string().trim().min(1).max(2048),
  model: z.string().trim().min(1).max(200)
});

export type ModelSettingsInput = z.infer<typeof ModelSettingsInput>;

type ModelSettingsRow = {
  api_key_ciphertext: string;
  base_url: string;
  model: string;
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
      baseUrl: null,
      model: null,
      updatedAt: null
    };
  }

  return {
    hasCustomModel: true,
    apiKeyConfigured: true,
    baseUrl: row.base_url,
    model: row.model,
    updatedAt: row.updated_at.toISOString()
  };
}

export async function getEffectiveModelSettings(ownerSub: string): Promise<EffectiveModelSettings> {
  const row = await getModelSettingsRow(ownerSub);
  if (!row) {
    return {
      apiKey: env.aiApiKey(),
      baseUrl: env.aiBaseUrl(),
      model: env.aiModel(),
      source: "default"
    };
  }

  return {
    apiKey: decryptSecret(row.api_key_ciphertext),
    baseUrl: await validatePublicHttpsBaseUrl(row.base_url),
    model: row.model,
    source: "custom"
  };
}

export async function upsertModelSettings(ownerSub: string, input: ModelSettingsInput) {
  const baseUrl = await validatePublicHttpsBaseUrl(input.baseUrl);
  const existing = await getModelSettingsRow(ownerSub);
  const apiKeyCiphertext = input.apiKey
    ? encryptSecret(input.apiKey)
    : existing?.api_key_ciphertext;

  if (!apiKeyCiphertext) {
    throw new Error("API key is required before custom model settings can be saved");
  }

  await getPool().query(
    `insert into user_model_settings (
       owner_sub, api_key_ciphertext, base_url, model, updated_at
     )
     values ($1, $2, $3, $4, now())
     on conflict (owner_sub)
     do update set
       api_key_ciphertext = excluded.api_key_ciphertext,
       base_url = excluded.base_url,
       model = excluded.model,
       updated_at = now()`,
    [ownerSub, apiKeyCiphertext, baseUrl, input.model]
  );
}

export async function deleteModelSettings(ownerSub: string) {
  await getPool().query(`delete from user_model_settings where owner_sub = $1`, [ownerSub]);
}

async function getModelSettingsRow(ownerSub: string): Promise<ModelSettingsRow | null> {
  const result = await getPool().query(
    `select api_key_ciphertext, base_url, model, updated_at
     from user_model_settings
     where owner_sub = $1`,
    [ownerSub]
  );
  return result.rows[0] ?? null;
}
