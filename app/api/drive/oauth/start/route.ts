// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { requireSession, withAuth } from "@/lib/auth";
import { createDriveOAuthUrl } from "@/lib/google-oauth";

export const GET = withAuth(async () => {
  const session = await requireSession();
  const url = await createDriveOAuthUrl(session.user.id);
  return NextResponse.redirect(url);
});
