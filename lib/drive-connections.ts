// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { getPool } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

export type DriveConnection = {
  id: string;
  ownerSub: string;
  driveEmail: string;
  driveName: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string;
};

export type DriveConnectionSummary = {
  id: string;
  driveEmail: string;
  driveName: string | null;
  expiresAt: string | null;
  scope: string;
  createdAt: string;
  updatedAt: string;
};

export async function listDriveConnections(ownerSub: string): Promise<DriveConnectionSummary[]> {
  const result = await getPool().query(
    `select id, drive_email, drive_name, expires_at, scope, created_at, updated_at
     from drive_connections
     where owner_sub = $1
     order by drive_email asc`,
    [ownerSub]
  );
  return result.rows.map((row) => ({
    id: row.id,
    driveEmail: row.drive_email,
    driveName: row.drive_name,
    expiresAt: row.expires_at?.toISOString() ?? null,
    scope: row.scope,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }));
}

export async function getDriveConnection(
  ownerSub: string,
  id: string
): Promise<DriveConnection | null> {
  const result = await getPool().query(
    `select id, owner_sub, drive_email, drive_name, access_token_ciphertext,
            refresh_token_ciphertext, expires_at, scope
     from drive_connections
     where owner_sub = $1 and id = $2`,
    [ownerSub, id]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    ownerSub: row.owner_sub,
    driveEmail: row.drive_email,
    driveName: row.drive_name,
    accessToken: decryptSecret(row.access_token_ciphertext),
    refreshToken: row.refresh_token_ciphertext ? decryptSecret(row.refresh_token_ciphertext) : null,
    expiresAt: row.expires_at,
    scope: row.scope
  };
}

export async function upsertDriveConnection(input: {
  ownerSub: string;
  driveEmail: string;
  driveName: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string;
}) {
  await getPool().query(
    `insert into drive_connections (
       owner_sub, drive_email, drive_name, access_token_ciphertext,
       refresh_token_ciphertext, expires_at, scope, updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (owner_sub, drive_email)
     do update set
       drive_name = excluded.drive_name,
       access_token_ciphertext = excluded.access_token_ciphertext,
       refresh_token_ciphertext = coalesce(
         excluded.refresh_token_ciphertext,
         drive_connections.refresh_token_ciphertext
       ),
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       updated_at = now()`,
    [
      input.ownerSub,
      input.driveEmail,
      input.driveName,
      encryptSecret(input.accessToken),
      input.refreshToken ? encryptSecret(input.refreshToken) : null,
      input.expiresAt,
      input.scope
    ]
  );
}

export async function updateDriveAccessToken(input: {
  id: string;
  ownerSub: string;
  accessToken: string;
  expiresAt: Date | null;
  scope?: string;
}) {
  await getPool().query(
    `update drive_connections
     set access_token_ciphertext = $1,
         expires_at = $2,
         scope = coalesce($3, scope),
         updated_at = now()
     where id = $4 and owner_sub = $5`,
    [encryptSecret(input.accessToken), input.expiresAt, input.scope ?? null, input.id, input.ownerSub]
  );
}

export async function deleteDriveConnection(ownerSub: string, id: string) {
  await getPool().query(`delete from drive_connections where owner_sub = $1 and id = $2`, [ownerSub, id]);
}
