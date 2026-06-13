// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { Pool, type PoolConfig } from "pg";
import { env } from "@/lib/env";

const globalForPg = globalThis as unknown as { pgPool?: Pool };

// SSL is opt-in via DATABASE_SSL so the same build works across providers:
// - unset:   defer to any `sslmode` in DATABASE_URL. Railway's managed Postgres
//            is reached over the private network without TLS, so "no SSL" is the
//            correct default there.
// - disable: force SSL off.
// - require: encrypt but accept managed self-signed certs (most hosted Postgres).
// - verify:  encrypt and verify the server cert against the system CA store.
function resolveSsl(): PoolConfig["ssl"] | undefined {
  const mode = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (!mode) return undefined;
  if (["0", "false", "off", "disable", "disabled"].includes(mode)) return false;
  if (["verify", "verify-ca", "verify-full", "strict"].includes(mode)) return true;
  return { rejectUnauthorized: false };
}

export function getPool() {
  if (!globalForPg.pgPool) {
    const ssl = resolveSsl();
    const pool = new Pool({
      connectionString: env.databaseUrl(),
      max: 10,
      ...(ssl !== undefined ? { ssl } : {})
    });

    // Idle clients can emit errors out-of-band (e.g. the DB restarting or a
    // managed-Postgres failover). `pg` re-emits these on the pool, and an
    // unhandled 'error' event would crash the whole process, so we must listen.
    pool.on("error", (error) => {
      console.error("Unexpected error on idle Postgres client", error);
    });

    globalForPg.pgPool = pool;
  }

  return globalForPg.pgPool;
}
