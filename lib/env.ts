// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  googleClientId: () => required("GOOGLE_CLIENT_ID"),
  googleClientSecret: () => required("GOOGLE_CLIENT_SECRET"),
  databaseUrl: () => required("DATABASE_URL"),
  tokenEncryptionKey: () => required("TOKEN_ENCRYPTION_KEY"),
  aiApiKey: () => required("AI_API_KEY"),
  // Default model family. One of "openai" (Responses API), "anthropic", or
  // "openai-compatible" (Fireworks/vLLM/custom). Coerced/validated downstream by
  // lib/model-settings; falls back to "openai" when unset or unrecognized.
  aiProvider: () => process.env.AI_PROVIDER || "openai",
  // Optional. Native providers (openai, anthropic) use their official endpoint
  // when unset; openai-compatible requires it. Returns null when unset.
  aiBaseUrl: (): string | null => process.env.AI_BASE_URL || null,
  aiModel: () => process.env.AI_MODEL || "gpt-4.1-mini",
  nextAuthUrl: () => required("NEXTAUTH_URL")
};
