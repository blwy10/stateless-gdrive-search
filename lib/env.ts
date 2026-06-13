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
  aiBaseUrl: () => process.env.AI_BASE_URL || "https://api.openai.com/v1",
  aiModel: () => process.env.AI_MODEL || "gpt-4.1-mini",
  nextAuthUrl: () => required("NEXTAUTH_URL")
};
