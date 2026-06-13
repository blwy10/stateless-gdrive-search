<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Stateless GDrive Search

A production-oriented Next.js app for Google-login users to connect one or more Google Drive accounts and query them with a constrained AI agent.

## Created with Codex

This project was created with Codex. The repository, application structure, and implementation were generated and edited through Codex-assisted development.

The agent has exactly two app tools:

- `search_drive`: search connected Google Drives with read-only Drive scopes.
- `open_file`: read a selected file's contents.

Durable application data is limited to encrypted Google Drive OAuth token material,
optional encrypted per-user model API keys, and their metadata.

## Stack

- Next.js App Router and TypeScript
- NextAuth Google login with stateless JWT sessions
- PostgreSQL for encrypted Drive OAuth tokens only
- Google Drive REST API with read-only scopes
- OpenAI-compatible Chat Completions tool calling

## Environment

Copy `.env.example` to `.env.local` and fill in:

```bash
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=replace-with-32+-random-bytes
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
DATABASE_URL=postgres://user:password@localhost:5432/stateless_gdrive_search
TOKEN_ENCRYPTION_KEY=base64-encoded-32-byte-key
AI_API_KEY=...
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1-mini
DEBUG_LOGS=0
DEBUG_LOG_CONTENT=0
```

Create the database table:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

Run locally:

```bash
npm install
npm run dev
```

## Google OAuth setup

Create one Google OAuth client. Add these redirect URIs:

- `http://localhost:3000/api/auth/callback/google`
- `http://localhost:3000/api/drive/oauth/callback`

For production, add the same paths on your deployed hostname.

The login flow requests `openid email profile`. The Drive connection flow requests `openid email profile https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.readonly`.

## Local debug logs

Set `DEBUG_LOGS=1` during local debugging to write structured JSONL agent traces to `.codex-debug/logs/agent-YYYY-MM-DD.jsonl`. These logs are ignored by git and are readable directly from the workspace.

By default, logs store metadata only: request IDs, event names, durations, counts, statuses, hashed identifiers, and content lengths. Set `DEBUG_LOG_CONTENT=1` only for local emergency debugging when short query, file-name, or error-response previews are needed. Do not enable either flag for production release builds.
