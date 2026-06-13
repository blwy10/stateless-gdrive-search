import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  assertDriveOAuthState,
  exchangeDriveCode,
  expiresAtFromNow,
  getGoogleUserInfo
} from "@/lib/google-oauth";
import { upsertDriveConnection } from "@/lib/drive-connections";
import { env } from "@/lib/env";

export async function GET(request: NextRequest) {
  const session = await requireSession();
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(`${env.nextAuthUrl()}?drive_error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return NextResponse.redirect(`${env.nextAuthUrl()}?drive_error=missing_code`);
  }

  await assertDriveOAuthState(session.user.id, state);
  const tokens = await exchangeDriveCode(code);
  const userInfo = await getGoogleUserInfo(tokens.access_token);
  await upsertDriveConnection({
    ownerSub: session.user.id,
    driveEmail: userInfo.email,
    driveName: userInfo.name ?? null,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: expiresAtFromNow(tokens.expires_in),
    scope: tokens.scope
  });

  return NextResponse.redirect(env.nextAuthUrl());
}
