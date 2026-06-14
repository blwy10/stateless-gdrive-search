-- Copyright (c) 2026 Benjamin Lau
-- SPDX-License-Identifier: MIT

create table if not exists drive_connections (
  id text primary key default gen_random_uuid()::text,
  owner_sub text not null,
  drive_email text not null,
  drive_name text,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text,
  expires_at timestamptz,
  scope text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ensure existing deployments pick up the id default so upserts can omit the id.
alter table drive_connections
  alter column id set default gen_random_uuid()::text;

create index if not exists drive_connections_owner_sub_idx
  on drive_connections(owner_sub);

create unique index if not exists drive_connections_owner_email_idx
  on drive_connections(owner_sub, drive_email);

create table if not exists user_model_settings (
  owner_sub text primary key,
  -- Per-role model overrides (main = agent + synthesis, grader = the cheaper
  -- relevance examiner). A role is "present" iff its model and api_key_ciphertext
  -- are both non-null; otherwise it falls back to that role's env default. The
  -- two roles are independent — a user may override one, the other, both, or
  -- neither.
  api_key_ciphertext text,
  base_url text,
  model text,
  provider text,
  reasoning_effort text,
  grader_api_key_ciphertext text,
  grader_base_url text,
  grader_model text,
  grader_provider text,
  grader_reasoning_effort text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Multi-provider support. Existing rows predate the provider column and were all
-- user-supplied OpenAI-compatible endpoints, so default them to that. Native
-- providers (openai, anthropic) may omit base_url (they use their official
-- endpoint), so base_url is no longer required.
alter table user_model_settings
  add column if not exists provider text not null default 'openai-compatible';

alter table user_model_settings
  alter column base_url drop not null;

-- Independent per-role overrides: a user may override just the grader and leave
-- the main config on its env default, so the main columns are no longer required.
alter table user_model_settings
  alter column api_key_ciphertext drop not null;

alter table user_model_settings
  alter column model drop not null;

alter table user_model_settings
  alter column provider drop not null;

-- Separate grader-role columns (a cheaper model that only grades file relevance).
-- Nullable: the grader uses its env default when unset.
alter table user_model_settings
  add column if not exists grader_api_key_ciphertext text;

alter table user_model_settings
  add column if not exists grader_base_url text;

alter table user_model_settings
  add column if not exists grader_model text;

alter table user_model_settings
  add column if not exists grader_provider text;

-- Per-role reasoning effort ("minimal" | "low" | "medium" | "high"). Nullable:
-- when unset the role uses the provider default (the option is omitted). Not a
-- secret, so stored in plaintext alongside model/provider/base_url.
alter table user_model_settings
  add column if not exists reasoning_effort text;

alter table user_model_settings
  add column if not exists grader_reasoning_effort text;
