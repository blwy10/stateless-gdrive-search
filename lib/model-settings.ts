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
 * The three independent model roles. `main` runs the agent loop and writes the
 * synthesis answer; `grader` is a separate, cheaper model that only judges
 * per-file relevance (see gradeFileRelevance in lib/agent.ts); `summarizer` is a
 * separate model that condenses an oversize file into the synthesis budget rather
 * than hard-truncating it (see summarizeOversizeContent in lib/agent.ts). Each
 * role is configured independently at the env level (all required — there is no
 * fallback between roles) and may be overridden per-user independently.
 */
export const MODEL_ROLES = ["main", "grader", "summarizer"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * Reasoning-effort levels accepted for either role. `"none"` is the EXPLICIT
 * "use the provider default" value — the option is omitted entirely (and for
 * Anthropic, extended thinking stays off). There is intentionally no implicit
 * "unset means default": the env vars are required (see "Environment variables"
 * in AGENTS.md), so an operator must choose `none` on purpose rather than relying
 * on a silent fallback. `minimal|low|medium|high` is the widely-supported active
 * set (covers OpenAI and Fireworks gpt-oss); provider-specific extras like
 * "xhigh" are deliberately not offered. Maps to OpenAI's `reasoningEffort` /
 * OpenAI-compatible `reasoning_effort` directly, and to an Anthropic thinking
 * budget by lib/model-provider.
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

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

/**
 * Coerce a stored reasoning-effort string to a known {@link ReasoningEffort},
 * defaulting to `"none"` (provider default) for anything unset, blank, or
 * unrecognized. Trims and lower-cases first so a legacy DB value still resolves.
 * This is the LENIENT path for STORED data (DB columns written by our own,
 * enum-constrained UI, plus legacy null rows) — a stray value degrades to the
 * provider default rather than breaking a run. The env vars take the strict path
 * instead ({@link requireReasoningEffortEnv}), failing loudly on a typo.
 */
export function coerceReasoningEffort(value: string | null | undefined): ReasoningEffort {
  const normalized = value?.trim().toLowerCase() ?? "";
  return (REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? (normalized as ReasoningEffort)
    : "none";
}

/**
 * Strictly parse a REQUIRED reasoning-effort env var: the value must already be
 * present (callers read it via `env`'s `required(...)`) and must be one of
 * {@link REASONING_EFFORTS}. An unrecognized value throws rather than silently
 * coercing — env config is explicit by design, so a typo should fail at startup,
 * not quietly run at the provider default. (`none` is a valid, explicit choice.)
 */
function requireReasoningEffortEnv(rawValue: string, varName: string): ReasoningEffort {
  const normalized = rawValue.trim().toLowerCase();
  if (!(REASONING_EFFORTS as readonly string[]).includes(normalized)) {
    throw new Error(
      `Invalid ${varName}="${rawValue}". Must be one of: ${REASONING_EFFORTS.join(", ")}`
    );
  }
  return normalized as ReasoningEffort;
}

export type RoleSettingsSummary = {
  hasCustomModel: boolean;
  apiKeyConfigured: boolean;
  provider: ModelProvider | null;
  baseUrl: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  updatedAt: string | null;
};

export type ModelSettingsSummary = {
  main: RoleSettingsSummary;
  grader: RoleSettingsSummary;
  summarizer: RoleSettingsSummary;
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
  /**
   * Reasoning effort for this role. Always set (never null) — `"none"` is the
   * explicit "provider default" value. Applied per-provider by
   * lib/model-provider's resolveModel.
   */
  reasoningEffort: ReasoningEffort;
  source: "default" | "custom";
};

/** Effective settings for all roles, resolved once per agent run. */
export type EffectiveModelSettingsBundle = {
  main: EffectiveModelSettings;
  grader: EffectiveModelSettings;
  summarizer: EffectiveModelSettings;
};

const RoleSettingsInput = z
  .object({
    provider: z.enum(MODEL_PROVIDERS).optional().default("openai-compatible"),
    apiKey: z.string().trim().min(1).max(4096).optional(),
    baseUrl: z.string().trim().min(1).max(2048).optional(),
    model: z.string().trim().min(1).max(200),
    // The UI always sends one of REASONING_EFFORTS ("none" = provider default);
    // optional only so a partial API save can omit it (then stored as "none").
    reasoningEffort: z.enum(REASONING_EFFORTS).optional()
  })
  // Native providers use their official endpoint, but an OpenAI-compatible
  // endpoint has no default, so its URL is mandatory.
  .refine((value) => value.provider !== "openai-compatible" || Boolean(value.baseUrl), {
    message: "An endpoint URL is required for OpenAI-compatible providers",
    path: ["baseUrl"]
  });

export type RoleSettingsInput = z.infer<typeof RoleSettingsInput>;

// A save may target any role independently (or several); at least one must be
// present so an empty request is rejected rather than silently doing nothing.
const ModelSettingsInput = z
  .object({
    main: RoleSettingsInput.optional(),
    grader: RoleSettingsInput.optional(),
    summarizer: RoleSettingsInput.optional()
  })
  .refine((value) => Boolean(value.main || value.grader || value.summarizer), {
    message: "Provide settings for at least one role (main, grader, or summarizer)"
  });

export type ModelSettingsInput = z.infer<typeof ModelSettingsInput>;

type ModelSettingsRow = {
  api_key_ciphertext: string | null;
  base_url: string | null;
  model: string | null;
  provider: string | null;
  reasoning_effort: string | null;
  grader_api_key_ciphertext: string | null;
  grader_base_url: string | null;
  grader_model: string | null;
  grader_provider: string | null;
  grader_reasoning_effort: string | null;
  summarizer_api_key_ciphertext: string | null;
  summarizer_base_url: string | null;
  summarizer_model: string | null;
  summarizer_provider: string | null;
  summarizer_reasoning_effort: string | null;
  updated_at: Date;
};

/** Raw per-role columns pulled off a {@link ModelSettingsRow}. */
type RoleColumns = {
  apiKeyCiphertext: string | null;
  baseUrl: string | null;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
};

export function parseModelSettingsInput(value: unknown) {
  return ModelSettingsInput.parse(value);
}

/** Map the `role` query param used by the per-role DELETE to a known target. */
export function parseModelRole(value: string | null | undefined): ModelRole | "all" {
  return value === "main" || value === "grader" || value === "summarizer" ? value : "all";
}

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

function envSettings(role: ModelRole): EffectiveModelSettings {
  if (role === "grader") {
    return {
      provider: coerceModelProvider(env.graderAiProvider()),
      apiKey: env.graderAiApiKey(),
      baseUrl: env.graderAiBaseUrl(),
      model: env.graderAiModel(),
      reasoningEffort: requireReasoningEffortEnv(
        env.graderAiReasoningEffort(),
        "GRADER_AI_REASONING_EFFORT"
      ),
      source: "default"
    };
  }
  if (role === "summarizer") {
    return {
      provider: coerceModelProvider(env.summarizerAiProvider()),
      apiKey: env.summarizerAiApiKey(),
      baseUrl: env.summarizerAiBaseUrl(),
      model: env.summarizerAiModel(),
      reasoningEffort: requireReasoningEffortEnv(
        env.summarizerAiReasoningEffort(),
        "SUMMARIZER_AI_REASONING_EFFORT"
      ),
      source: "default"
    };
  }
  return {
    provider: coerceModelProvider(env.aiProvider()),
    apiKey: env.aiApiKey(),
    baseUrl: env.aiBaseUrl(),
    model: env.aiModel(),
    reasoningEffort: requireReasoningEffortEnv(env.aiReasoningEffort(), "AI_REASONING_EFFORT"),
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
    reasoningEffort: null,
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
    reasoningEffort: coerceReasoningEffort(columns.reasoningEffort),
    updatedAt
  };
}

export async function getModelSettingsSummary(ownerSub: string): Promise<ModelSettingsSummary> {
  const row = await getModelSettingsRow(ownerSub);
  if (!row) {
    return {
      main: emptyRoleSummary(),
      grader: emptyRoleSummary(),
      summarizer: emptyRoleSummary()
    };
  }
  const updatedAt = row.updated_at.toISOString();
  return {
    main: roleSummary(mainColumns(row), updatedAt),
    grader: roleSummary(graderColumns(row), updatedAt),
    summarizer: roleSummary(summarizerColumns(row), updatedAt)
  };
}

export async function getEffectiveModelSettings(
  ownerSub: string
): Promise<EffectiveModelSettingsBundle> {
  const envMain = envSettings("main");
  const envGrader = envSettings("grader");
  const envSummarizer = envSettings("summarizer");
  const row = await getModelSettingsRow(ownerSub);
  if (!row) {
    return { main: envMain, grader: envGrader, summarizer: envSummarizer };
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
  return {
    main: await withValidatedBaseUrl(main),
    grader: await withValidatedBaseUrl(grader),
    summarizer: await withValidatedBaseUrl(summarizer)
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

  await getPool().query(
    `insert into user_model_settings (
       owner_sub,
       api_key_ciphertext, base_url, model, provider, reasoning_effort,
       grader_api_key_ciphertext, grader_base_url, grader_model, grader_provider, grader_reasoning_effort,
       summarizer_api_key_ciphertext, summarizer_base_url, summarizer_model, summarizer_provider, summarizer_reasoning_effort,
       updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
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
      summarizer.reasoningEffort
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
        and model is null and grader_model is null and summarizer_model is null`,
    [ownerSub]
  );
}

async function getModelSettingsRow(ownerSub: string): Promise<ModelSettingsRow | null> {
  const result = await getPool().query(
    `select api_key_ciphertext, base_url, model, provider, reasoning_effort,
            grader_api_key_ciphertext, grader_base_url, grader_model, grader_provider, grader_reasoning_effort,
            summarizer_api_key_ciphertext, summarizer_base_url, summarizer_model, summarizer_provider, summarizer_reasoning_effort,
            updated_at
     from user_model_settings
     where owner_sub = $1`,
    [ownerSub]
  );
  return result.rows[0] ?? null;
}
