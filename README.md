<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Stateless GDrive Search

A production-oriented Next.js app for Google-login users to connect one or more Google Drive accounts and query them with a constrained AI agent.

> Created with Codex and Devin CLI.

The agent has a small, fixed set of app tools:

- `search_drive`: search connected Google Drives with read-only Drive scopes.
  Multi-word queries match any term (not the whole phrase) to favour recall, and a
  search that makes no progress (a repeat, or no new files) returns a corrective
  note nudging the agent to vary its terms.
- `open_file`: read a selected file's contents (synthesis and uncurated list mode).
- `review_file`: curated file-list mode only — read a candidate file and judge its
  relevance in an isolated grader call, keeping it only if relevant. Offered
  instead of `open_file` when curating, so file contents never accumulate in the
  agent's context.

Durable application data is limited to encrypted Google Drive OAuth token material,
optional encrypted per-user model API keys, and their metadata.

## Stack

- Next.js App Router and TypeScript
- NextAuth Google login with stateless JWT sessions
- PostgreSQL for encrypted Drive OAuth tokens only
- Google Drive REST API with read-only scopes
- [Vercel AI SDK](https://ai-sdk.dev) for multi-provider, tool-calling agents
  (OpenAI Responses API, Anthropic, and any OpenAI-compatible endpoint)

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
AI_PROVIDER=openai
# AI_BASE_URL is optional: native providers (openai, anthropic) use their
# official endpoint; openai-compatible requires it.
AI_MODEL=gpt-4.1-mini
# Grader model (required). A separate, cheaper model used only to judge per-file
# relevance; there is no fallback to the main model, so both must be set.
GRADER_AI_API_KEY=...
GRADER_AI_PROVIDER=openai
# GRADER_AI_BASE_URL is optional (required for openai-compatible).
GRADER_AI_MODEL=...
DEBUG_LOGS=0
DEBUG_LOG_CONTENT=0
```

### Model provider

The agent runs through the Vercel AI SDK and supports three provider families,
selected by `AI_PROVIDER` for the operator default and per-user in **Settings →
Custom provider**:

- `openai` — OpenAI's **Responses API**. Reasoning is requested statelessly
  (`store: false` with encrypted reasoning included) so chain-of-thought is
  round-tripped across tool steps without OpenAI retaining the conversation.
- `anthropic` — Anthropic's Messages API. Extended thinking is off by default
  (it only applies to thinking-capable Claude models and forces `temperature`
  to 1); enable it via `ANTHROPIC_THINKING_BUDGET_TOKENS` in `lib/model-provider.ts`.
- `openai-compatible` — any OpenAI-compatible endpoint (Fireworks, vLLM, …).
  `AI_BASE_URL` (or the per-user endpoint) is required here; reasoning is
  surfaced automatically when the endpoint returns it.

Regardless of provider, reasoning is logged from one unified field and prior
thinking is carried across turns by the SDK, so multi-turn tool calls keep their
chain-of-thought. User-supplied endpoints are SSRF-validated and pinned to public
IPs at connect time.

The app uses **two independent models**. The **main** model runs the agent loop
and writes the synthesis answer; the **grader** is a separate, cheaper model used
only to judge per-file relevance, which has much lower requirements. Each role has
its own provider, key, endpoint, and model: set the operator defaults via the
`AI_*` (main) and `GRADER_AI_*` (grader) env vars — both are required, with no
fallback between roles — and override them per-user and per-role in **Settings**.

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
URL guard, Drive query building/escaping, and agent output parsing) are covered by a
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

Set `DEBUG_LOGS=1` during local debugging to write structured JSONL agent traces to `.debug/logs/agent-YYYY-MM-DD.jsonl`. These logs are ignored by git and are readable directly from the workspace. Debug logging is for local use only: it is force-disabled whenever `NODE_ENV=production`, so `DEBUG_LOGS` — and therefore every `DEBUG_*` flag below — has no effect in production (e.g. Railway) builds even if set. Because the production build inlines `NODE_ENV`, the logging code is stripped from the deployed bundle entirely rather than merely skipped at runtime.

By default, logs store metadata only: request IDs, event names, durations, counts, statuses, hashed identifiers, and content lengths. Set `DEBUG_LOG_CONTENT=1` only for local emergency debugging when short query, file-name, or error-response previews are needed. It is a modifier on top of `DEBUG_LOGS`, not a standalone switch: with `DEBUG_LOGS=0` nothing is written at all, so content previews require `DEBUG_LOGS=1` as well (and, like all debug logging, are inert in production per the safeguard above).

To trace *why* the agent curates files the way it does (e.g. in file-list curation mode), set `DEBUG_LOG_TRANSCRIPT=1`. This emits an `agent.model.transcript` event for every model step containing the assistant's full, untruncated reasoning text (`reasoningContent`), its answer text (`content`), the tool calls it issued that step (names and arguments), and the raw provider response body, so you can see the rationale behind each `open_file` / `review_file` decision. Reasoning is read from the Vercel AI SDK's **unified** `reasoningText`, so it shows up the same way no matter which provider produced it (OpenAI Responses summaries, Anthropic extended thinking, or Fireworks/DeepSeek `reasoning_content`) — including on tool-call turns where the plain `content` is empty. The SDK also round-trips that reasoning between steps automatically, so multi-turn tool calls keep their chain-of-thought. In curated file-list mode, `review_file` grades each file's relevance in a separate isolated `generateObject` call, and those grader calls log **distinctly** under `agent.grade.completed` / `agent.grade.failed` (each tagged with the graded file's hash), never the main agent's `agent.model.*`, so the two are never confused even though they share a request ID and step — plus an `agent.tool.review_file.completed` entry recording the keep/discard verdict and the grader's reason. It is the most verbose and sensitive log we emit, so it is independent of `DEBUG_LOG_CONTENT`, still requires the `DEBUG_LOGS=1` master switch, and is likewise force-disabled whenever `NODE_ENV=production`.
