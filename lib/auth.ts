// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import GoogleProvider from "next-auth/providers/google";
import { env } from "@/lib/env";

// Built lazily and memoized (like lib/db.ts's getPool) so importing this module
// never requires the OAuth env vars to be present — e.g. during `next build`.
// Resolving the credentials through env.googleClientId()/googleClientSecret()
// means a missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET fails fast with a clear
// "Missing required environment variable" error the first time auth is used,
// instead of silently handing Google a placeholder and surfacing a confusing
// OAuth error.
let cachedAuthOptions: NextAuthOptions | undefined;

export function getAuthOptions(): NextAuthOptions {
  if (!cachedAuthOptions) {
    cachedAuthOptions = {
      session: {
        strategy: "jwt"
      },
      providers: [
        GoogleProvider({
          clientId: env.googleClientId(),
          clientSecret: env.googleClientSecret(),
          authorization: {
            params: {
              prompt: "select_account",
              scope: "openid email profile"
            }
          }
        })
      ],
      callbacks: {
        jwt({ token, profile }) {
          if (profile?.sub) {
            token.sub = profile.sub;
          }
          return token;
        },
        session({ session, token }) {
          // Don't throw when the subject is missing: that would turn
          // /api/auth/session into a 500 instead of an empty session. Leave the id
          // unset and let requireSession()/route guards reject the request cleanly.
          if (token.sub) {
            session.user.id = token.sub;
          }
          return session;
        }
      }
    };
  }
  return cachedAuthOptions;
}

// Thrown by requireSession() when there is no authenticated user. Route
// handlers wrapped with withAuth() translate this into a clean 401 instead of
// letting it bubble up as an unhandled 500.
export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export async function requireSession() {
  const session = await getServerSession(getAuthOptions());
  if (!session?.user?.id) {
    throw new UnauthorizedError();
  }
  return session;
}

// Wraps a route handler so an UnauthorizedError (from requireSession) becomes a
// 401 JSON response. Any other error is re-thrown so Next's default handling
// (and logging) still applies.
export function withAuth<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      throw error;
    }
  };
}
