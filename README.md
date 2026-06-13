<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Stateless GDrive Search

A production-oriented Next.js app for Google-login users to connect one or more Google Drive accounts and query them with a constrained AI agent.

> Created with Codex. The repository, application structure, and implementation were generated and edited through Codex-assisted development.

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

Optional per-user abuse protection on `/api/agent` (in-memory, keyed by the
authenticated user). These have sensible defaults and only need to be set to
override them:

```bash
AGENT_MAX_CONCURRENT_RUNS=2     # max simultaneous runs per user
AGENT_RATE_LIMIT_BURST=10       # token-bucket capacity (immediate burst)
AGENT_RATE_LIMIT_PER_MINUTE=20  # sustained runs per user per minute
```

The limiter is process-local. It fully protects a single-instance deployment; if
you scale to multiple replicas, move this state to a shared store (e.g. Redis)
so the limits are enforced globally.

Create the database table:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

Run locally:

```bash
npm install
npm run dev
```

## Tests

Pure, security-sensitive helpers (MIME formatting, token encryption, the SSRF
URL guard, Drive query escaping, and agent output parsing) are covered by a
small [Vitest](https://vitest.dev) suite under `test/`. These tests touch no
network, database, or browser:

```bash
npm test          # run once
npm run test:watch
```

## Deployment

This app is platform-neutral and can run anywhere that supports a Node.js Next.js
server plus PostgreSQL. The standard production command remains:

```bash
npm run build
npm run start
```

The official project hosting target is Railway. Railway should track the remote
`release` branch and use this service start command:

```bash
npm run start:standalone
```

Railway also needs a PostgreSQL service connected through `DATABASE_URL`, plus
the environment variables listed above. Railway's managed Postgres is reached
over the private network without TLS, so leave `DATABASE_SSL` unset there. On
other hosts that require TLS, set `DATABASE_SSL=require` (or `verify` to validate
the server certificate). After generating the Railway public domain, set
`NEXTAUTH_URL` to that origin and add these Google OAuth redirect paths on the
production hostname:

- `/api/auth/callback/google`
- `/api/drive/oauth/callback`

## Google OAuth setup

Create one Google OAuth client. Add these redirect URIs:

- `http://localhost:3000/api/auth/callback/google`
- `http://localhost:3000/api/drive/oauth/callback`

For production, add the same paths on your deployed hostname.

The login flow requests `openid email profile`. The Drive connection flow requests `openid email profile https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.readonly`.

## Local debug logs

Set `DEBUG_LOGS=1` during local debugging to write structured JSONL agent traces to `.debug/logs/agent-YYYY-MM-DD.jsonl`. These logs are ignored by git and are readable directly from the workspace.

By default, logs store metadata only: request IDs, event names, durations, counts, statuses, hashed identifiers, and content lengths. Set `DEBUG_LOG_CONTENT=1` only for local emergency debugging when short query, file-name, or error-response previews are needed. Do not enable either flag for production release builds. As a safeguard, content previews are forced off whenever `NODE_ENV=production`, so `DEBUG_LOG_CONTENT=1` has no effect in production builds even if it is set.
