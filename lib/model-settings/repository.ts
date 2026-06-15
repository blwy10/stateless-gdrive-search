// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getPool } from "@/lib/db";
import { validatePublicHttpsBaseUrl } from "@/lib/ssrf";
import type { ModelRole } from "./constants";
import type {
  EffectiveModelSettingsBundle,
  ModelSettingsInput,
  ModelSettingsRow,
  ModelSettingsSummary,
  RoleColumns,
  RoleSettingsInput
} from "./types";
import { envSettings } from "./env";
import { emptyRoleSummary, resolveRoleSettings, roleSummary, withValidatedBaseUrl } from "./resolve";

function mainColumns(row: ModelSettingsRow | null): RoleColumns {
  return {
    apiKeyCiphertext: row?.api_key_ciphertext ?? null,
    baseUrl: row?.base_url ?? null,
    model: row?.model ?? null,
    provider: row?.provider ?? null,
    reasoningEffort: row?.reasoning_effort ?? null
  };
}

function graderColumns(row: ModelSettingsRow | null): RoleColumns {
  return {
    apiKeyCiphertext: row?.grader_api_key_ciphertext ?? null,
    baseUrl: row?.grader_base_url ?? null,
    model: row?.grader_model ?? null,
    provider: row?.grader_provider ?? null,
    reasoningEffort: row?.grader_reasoning_effort ?? null
  };
}

function summarizerColumns(row: ModelSettingsRow | null): RoleColumns {
  return {
    apiKeyCiphertext: row?.summarizer_api_key_ciphertext ?? null,
    baseUrl: row?.summarizer_base_url ?? null,
    model: row?.summarizer_model ?? null,
    provider: row?.summarizer_provider ?? null,
    reasoningEffort: row?.summarizer_reasoning_effort ?? null
  };
}

function rankerColumns(row: ModelSettingsRow | null): RoleColumns {
  return {
    apiKeyCiphertext: row?.ranker_api_key_ciphertext ?? null,
    baseUrl: row?.ranker_base_url ?? null,
    model: row?.ranker_model ?? null,
    provider: row?.ranker_provider ?? null,
    reasoningEffort: row?.ranker_reasoning_effort ?? null
  };
}

export async function getModelSettingsSummary(ownerSub: string): Promise<ModelSettingsSummary> {
  const row = await getModelSettingsRow(ownerSub);
  if (!row) {
    return {
      main: emptyRoleSummary(),
      grader: emptyRoleSummary(),
      summarizer: emptyRoleSummary(),
      ranker: emptyRoleSummary()
    };
  }
  const updatedAt = row.updated_at.toISOString();
  return {
    main: roleSummary(mainColumns(row), updatedAt),
    grader: roleSummary(graderColumns(row), updatedAt),
    summarizer: roleSummary(summarizerColumns(row), updatedAt),
    ranker: roleSummary(rankerColumns(row), updatedAt)
  };
}

export async function getEffectiveModelSettings(
  ownerSub: string
): Promise<EffectiveModelSettingsBundle> {
  const envMain = envSettings("main");
  const envGrader = envSettings("grader");
  const envSummarizer = envSettings("summarizer");
  const envRanker = envSettings("ranker");
  const row = await getModelSettingsRow(ownerSub);
  if (!row) {
    return { main: envMain, grader: envGrader, summarizer: envSummarizer, ranker: envRanker };
  }

  const decrypt = (columns: RoleColumns) => ({
    apiKey: columns.apiKeyCiphertext ? decryptSecret(columns.apiKeyCiphertext) : null,
    baseUrl: columns.baseUrl,
    model: columns.model,
    provider: columns.provider,
    reasoningEffort: columns.reasoningEffort
  });

  const main = resolveRoleSettings(decrypt(mainColumns(row)), envMain);
  const grader = resolveRoleSettings(decrypt(graderColumns(row)), envGrader);
  const summarizer = resolveRoleSettings(decrypt(summarizerColumns(row)), envSummarizer);
  const ranker = resolveRoleSettings(decrypt(rankerColumns(row)), envRanker);
  return {
    main: await withValidatedBaseUrl(main),
    grader: await withValidatedBaseUrl(grader),
    summarizer: await withValidatedBaseUrl(summarizer),
    ranker: await withValidatedBaseUrl(ranker)
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
  return {
    apiKeyCiphertext,
    baseUrl,
    model: input.model,
    provider: input.provider,
    // Store an explicit value; "none" is the provider-default sentinel.
    reasoningEffort: input.reasoningEffort ?? "none"
  };
}

export async function upsertModelSettings(ownerSub: string, input: ModelSettingsInput) {
  const existing = await getModelSettingsRow(ownerSub);
  const main = await resolveRoleUpsert(input.main, mainColumns(existing));
  const grader = await resolveRoleUpsert(input.grader, graderColumns(existing));
  const summarizer = await resolveRoleUpsert(input.summarizer, summarizerColumns(existing));
  const ranker = await resolveRoleUpsert(input.ranker, rankerColumns(existing));

  await getPool().query(
    `insert into user_model_settings (
       owner_sub,
       api_key_ciphertext, base_url, model, provider, reasoning_effort,
       grader_api_key_ciphertext, grader_base_url, grader_model, grader_provider, grader_reasoning_effort,
       summarizer_api_key_ciphertext, summarizer_base_url, summarizer_model, summarizer_provider, summarizer_reasoning_effort,
       ranker_api_key_ciphertext, ranker_base_url, ranker_model, ranker_provider, ranker_reasoning_effort,
       updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, now())
     on conflict (owner_sub)
     do update set
       api_key_ciphertext = excluded.api_key_ciphertext,
       base_url = excluded.base_url,
       model = excluded.model,
       provider = excluded.provider,
       reasoning_effort = excluded.reasoning_effort,
       grader_api_key_ciphertext = excluded.grader_api_key_ciphertext,
       grader_base_url = excluded.grader_base_url,
       grader_model = excluded.grader_model,
       grader_provider = excluded.grader_provider,
       grader_reasoning_effort = excluded.grader_reasoning_effort,
       summarizer_api_key_ciphertext = excluded.summarizer_api_key_ciphertext,
       summarizer_base_url = excluded.summarizer_base_url,
       summarizer_model = excluded.summarizer_model,
       summarizer_provider = excluded.summarizer_provider,
       summarizer_reasoning_effort = excluded.summarizer_reasoning_effort,
       ranker_api_key_ciphertext = excluded.ranker_api_key_ciphertext,
       ranker_base_url = excluded.ranker_base_url,
       ranker_model = excluded.ranker_model,
       ranker_provider = excluded.ranker_provider,
       ranker_reasoning_effort = excluded.ranker_reasoning_effort,
       updated_at = now()`,
    [
      ownerSub,
      main.apiKeyCiphertext,
      main.baseUrl,
      main.model,
      main.provider,
      main.reasoningEffort,
      grader.apiKeyCiphertext,
      grader.baseUrl,
      grader.model,
      grader.provider,
      grader.reasoningEffort,
      summarizer.apiKeyCiphertext,
      summarizer.baseUrl,
      summarizer.model,
      summarizer.provider,
      summarizer.reasoningEffort,
      ranker.apiKeyCiphertext,
      ranker.baseUrl,
      ranker.model,
      ranker.provider,
      ranker.reasoningEffort
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
             grader_reasoning_effort = null,
             updated_at = now()
       where owner_sub = $1`,
      [ownerSub]
    );
  } else if (role === "summarizer") {
    await getPool().query(
      `update user_model_settings
         set summarizer_api_key_ciphertext = null,
             summarizer_base_url = null,
             summarizer_model = null,
             summarizer_provider = null,
             summarizer_reasoning_effort = null,
             updated_at = now()
       where owner_sub = $1`,
      [ownerSub]
    );
  } else if (role === "ranker") {
    await getPool().query(
      `update user_model_settings
         set ranker_api_key_ciphertext = null,
             ranker_base_url = null,
             ranker_model = null,
             ranker_provider = null,
             ranker_reasoning_effort = null,
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
             reasoning_effort = null,
             updated_at = now()
       where owner_sub = $1`,
      [ownerSub]
    );
  }
  // Drop the row entirely once no role overrides anything, so an absent row keeps
  // meaning "every role uses its env default".
  await getPool().query(
    `delete from user_model_settings
      where owner_sub = $1
        and model is null and grader_model is null and summarizer_model is null
        and ranker_model is null`,
    [ownerSub]
  );
}

async function getModelSettingsRow(ownerSub: string): Promise<ModelSettingsRow | null> {
  const result = await getPool().query(
    `select api_key_ciphertext, base_url, model, provider, reasoning_effort,
            grader_api_key_ciphertext, grader_base_url, grader_model, grader_provider, grader_reasoning_effort,
            summarizer_api_key_ciphertext, summarizer_base_url, summarizer_model, summarizer_provider, summarizer_reasoning_effort,
            ranker_api_key_ciphertext, ranker_base_url, ranker_model, ranker_provider, ranker_reasoning_effort,
            updated_at
     from user_model_settings
     where owner_sub = $1`,
    [ownerSub]
  );
  return result.rows[0] ?? null;
}
