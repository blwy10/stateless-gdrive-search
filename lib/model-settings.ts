// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import dns from "node:dns/promises";
import net from "node:net";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getPool } from "@/lib/db";
import { env } from "@/lib/env";

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

async function validatePublicHttpsBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Endpoint must be a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Endpoint must use https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Endpoint must not include credentials");
  }
  if (parsed.hash || parsed.search) {
    throw new Error("Endpoint must not include query parameters or fragments");
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error("Endpoint host is not allowed");
  }

  const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((address) => isPrivateAddress(address.address))) {
    throw new Error("Endpoint host must resolve to public IP addresses");
  }

  return parsed.toString().replace(/\/$/, "");
}

function isBlockedHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "metadata.google.internal"
  );
}

function isPrivateAddress(address: string) {
  const mappedIpv4 = address.toLowerCase().startsWith("::ffff:")
    ? address.slice("::ffff:".length)
    : null;
  const ipVersion = net.isIP(mappedIpv4 ?? address);
  if (ipVersion === 4) return isPrivateIpv4(mappedIpv4 ?? address);
  if (ipVersion === 6) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string) {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}
