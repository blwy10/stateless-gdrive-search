import { Pool } from "pg";
import { env } from "@/lib/env";

const globalForPg = globalThis as unknown as { pgPool?: Pool };

export function getPool() {
  if (!globalForPg.pgPool) {
    globalForPg.pgPool = new Pool({
    connectionString: env.databaseUrl(),
    max: 10
  });
  }

  return globalForPg.pgPool;
}
