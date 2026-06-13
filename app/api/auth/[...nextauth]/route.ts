// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import NextAuth from "next-auth";
import type { NextRequest } from "next/server";
import { getAuthOptions } from "@/lib/auth";

// Build the NextAuth handler lazily (and memoize it) so importing this route
// never requires the Google OAuth env vars at module load — e.g. during
// `next build`. The first request fails fast via env.required() if
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing, mirroring the lazy env
// access used elsewhere (lib/db.ts, lib/crypto.ts, lib/google-oauth.ts).
type RouteContext = { params: Promise<{ nextauth: string[] }> };
type RouteHandler = (req: NextRequest, ctx: RouteContext) => Promise<Response>;

let cachedHandler: RouteHandler | undefined;

function getHandler(): RouteHandler {
  // NextAuth() is typed as `any`; cast to the App Router handler shape so the
  // exported GET/POST satisfy Next's generated route validator.
  cachedHandler ??= NextAuth(getAuthOptions()) as RouteHandler;
  return cachedHandler;
}

async function handler(req: NextRequest, ctx: RouteContext): Promise<Response> {
  return getHandler()(req, ctx);
}

export { handler as GET, handler as POST };
