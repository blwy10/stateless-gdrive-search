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
  api_key_ciphertext text not null,
  base_url text,
  model text not null,
  provider text not null default 'openai-compatible',
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
