// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

// Applies db/schema.sql to the database named by DATABASE_URL. The schema is
// written to be idempotent (every statement is `... if not exists` / `drop not
// null` / `set default`), so this is safe to run on every boot of `npm run dev`
// (via the `predev` hook) and on every deploy (Railway's pre-deploy command runs
// `npm run db:migrate`). It is intentionally a plain .mjs script with no build
// step and no new dependencies — just the `pg` client the app already uses.
//
// DATABASE_URL (and optional DATABASE_SSL) are read from the process
// environment. The `db:migrate` npm script loads `.env.local` for local dev via
// Node's `--env-file-if-exists`; Railway (pre-deploy) and CI inject the vars
// directly, where real env values take precedence over any file.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

// Mirror lib/db.ts resolveSsl so the script connects exactly like the app:
// - unset:   defer to any `sslmode` in DATABASE_URL (Railway private network = no TLS).
// - disable: force SSL off.
// - verify:  encrypt and verify the server cert against the system CA store.
// - other:   encrypt but accept managed self-signed certs (most hosted Postgres).
function resolveSsl() {
  const mode = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (!mode) return undefined;
  if (["0", "false", "off", "disable", "disabled"].includes(mode)) return false;
  if (["verify", "verify-ca", "verify-full", "strict"].includes(mode)) return true;
  return { rejectUnauthorized: false };
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  // Match the env policy: explicit, no silent defaults — fail loudly.
  console.error("Missing required environment variable: DATABASE_URL");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "db", "schema.sql");
const sql = readFileSync(schemaPath, "utf8");

const ssl = resolveSsl();
const client = new Client({ connectionString, ...(ssl !== undefined ? { ssl } : {}) });

// The whole file runs in one transaction so a failure leaves the schema
// untouched rather than half-applied. NOTE: this is incompatible with
// `CREATE INDEX CONCURRENTLY` (it cannot run inside a transaction); the current
// schema uses plain `create index if not exists`, so that is not a concern. If a
// concurrent index is ever needed, move it out of this transactional apply.
try {
  await client.connect();
  await client.query("begin");
  await client.query(sql);
  await client.query("commit");
  console.log(`Applied ${schemaPath}`);
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error("Schema migration failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
