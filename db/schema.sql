-- Copyright (c) 2026 Benjamin Lau
-- SPDX-License-Identifier: MIT

create table if not exists drive_connections (
  id text primary key,
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

create index if not exists drive_connections_owner_sub_idx
  on drive_connections(owner_sub);

create unique index if not exists drive_connections_owner_email_idx
  on drive_connections(owner_sub, drive_email);

create table if not exists user_model_settings (
  owner_sub text primary key,
  api_key_ciphertext text not null,
  base_url text not null,
  model text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
