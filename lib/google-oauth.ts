// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { cookies } from "next/headers";
import crypto from "node:crypto";
import { env } from "@/lib/env";

const DRIVE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/drive.readonly"
];

export const driveScopes = DRIVE_SCOPES.join(" ");

export async function createDriveOAuthUrl(ownerSub: string) {
  const state = crypto.randomBytes(32).toString("base64url");
  const cookieStore = await cookies();
  cookieStore.set("drive_oauth_state", `${ownerSub}:${state}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60
  });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.googleClientId());
  url.searchParams.set("redirect_uri", `${env.nextAuthUrl()}/api/drive/oauth/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", driveScopes);
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("include_granted_scopes", "true");
  return url;
}

export async function assertDriveOAuthState(ownerSub: string, state: string | null) {
  const cookieStore = await cookies();
  const stored = cookieStore.get("drive_oauth_state")?.value;
  cookieStore.delete("drive_oauth_state");
  if (!state || stored !== `${ownerSub}:${state}`) {
    throw new Error("Invalid Drive OAuth state");
  }
}

export async function exchangeDriveCode(code: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId(),
      client_secret: env.googleClientSecret(),
      redirect_uri: `${env.nextAuthUrl()}/api/drive/oauth/callback`,
      grant_type: "authorization_code"
    })
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope: string;
    token_type: string;
  };
}

export async function refreshDriveToken(refreshToken: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.googleClientId(),
      client_secret: env.googleClientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as {
    access_token: string;
    expires_in?: number;
    scope?: string;
    token_type: string;
  };
}

export async function getGoogleUserInfo(accessToken: string) {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Google userinfo failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as {
    email: string;
    name?: string;
  };
}

export function expiresAtFromNow(expiresIn?: number) {
  if (!expiresIn) return null;
  return new Date(Date.now() + Math.max(0, expiresIn - 60) * 1000);
}
