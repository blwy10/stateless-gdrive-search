<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Code Review: Stateless GDrive Search

Overall this is a well-structured, security-conscious codebase. Encryption-at-rest
for tokens, a thoughtful agent budget system, XSS-safe markdown rendering, and a
real SSRF guard for custom endpoints are all above what I'd expect.

Verification status at time of review: `npm run typecheck`, `npm run lint`, and
`npm run build` (standalone) all pass.

Findings are ordered by severity, with picky/stylistic items at the end.

## Security

### 1. Real secrets are sitting in the working tree (untracked, but risky)
`client_secret_*.json` and `.env.local` exist on disk. They are correctly
gitignored and were never committed (verified against full git history). But a
real Google OAuth client secret in the repo folder is one `git add -f`, one
stray `cp`, or one zip-and-share away from leaking. The filename itself also
discloses the client ID.

**Fix:** delete the JSON file (the code reads these values from env vars; the
file is unused) and consider rotating that client secret since it has been on
disk in a dev folder.

### 2. SSRF guard can be bypassed via HTTP redirects
The custom-endpoint validation in `lib/model-settings.ts`
(`validatePublicHttpsBaseUrl`, lines 125-152) is genuinely good: it blocks
localhost/metadata hosts, resolves DNS and rejects private IPs, and forbids
credentials/query strings. But the actual request in `lib/agent.ts`
(`callModel`, lines 267-279) uses `fetch` with default redirect-following. A
user-controlled endpoint can pass validation and then `302` to
`http://169.254.169.254/...` (cloud metadata) or an internal address — `fetch`
won't re-validate the redirect target. There's also a smaller TOCTOU/DNS-
rebinding window between `dns.lookup` at validation time and the later `fetch`.

**Fix:** set `redirect: "manual"` (or `"error"`) on that fetch, or re-validate
the resolved IP on each hop.

### 3. No rate limiting / abuse protection on `/api/agent`
`app/api/agent/route.ts` is authenticated but unbounded per-user. Each call
fans out to a paid AI API and Google Drive. With the shared default
`AI_API_KEY`, a single authenticated user can run up cost/quota by spamming
requests. The per-run budgets in `agent.ts` bound a single run, not the request
rate.

**Fix:** add a per-user concurrency cap and/or token-bucket limiter (even an
in-memory one keyed by `ownerSub` is better than nothing).

### 4. Raw upstream error bodies are surfaced to the end user
`lib/drive.ts` line 107 throws `Google Drive request failed: ${status}
${responseBody}`, and the agent route forwards `error.message` to the client
over SSE (`app/api/agent/route.ts`, lines 32-36). The model error is sanitized
to `AI request failed with status X`, but Drive errors leak raw provider
responses to the browser.

**Fix:** sanitize Drive errors the same way the model error is sanitized.

## Correctness / bugs

### 5. Unauthenticated requests return 500 instead of 401
`requireSession()` throws a plain `Error("Unauthorized")` (`lib/auth.ts`, lines
41-47). Only the agent route catches it; `settings/model`, `drive/connections`,
and both `drive/oauth/*` routes call it bare, so an unauthenticated call yields
a 500 with a stack rather than a clean 401.

**Fix:** wrap each handler, or make `requireSession` throw a custom error that a
small wrapper translates to 401.

### 6. Invalid request bodies on `/api/agent` return 500 instead of 400
In `app/api/agent/route.ts` lines 20-21, `await request.json()` and
`parseAgentRequest(body)` run *outside* the try block. Malformed JSON or a Zod
failure throws unhandled → 500. The `settings/model` route handles this
correctly (lines 22-28).

**Fix:** mirror the `settings/model` pattern and return 400.

### 7. OAuth callback doesn't gracefully handle exchange failures
`app/api/drive/oauth/callback/route.ts` lines 28-39 handle the `error` query
param and missing `code` by redirecting with `?drive_error=`, but if
`exchangeDriveCode`/`getGoogleUserInfo`/`upsert` throws, the user gets a raw 500
instead of a friendly redirect.

**Fix:** wrap the exchange in the same error→redirect handling.

### 8. Throwing inside the NextAuth `session` callback
`lib/auth.ts` lines 31-37 throws if `token.sub` is missing. A throw in the
session callback can break `/api/auth/session` rather than degrade gracefully.

**Fix:** return the session without an id (and let route guards reject) instead
of throwing here.

## Robustness / production-readiness

### 9. `pg` Pool has no error handler and no SSL config
`lib/db.ts` lines 9-18 — a `pg` Pool with no `pool.on("error", ...)` will crash
the whole process on an idle-client error (e.g. DB restart/failover), which is
common on managed Postgres. There's also no `ssl` option; depending on how the
production target exposes Postgres you may need `ssl` (or `sslmode` in the URL).
(Minor: the indentation of the `new Pool({...})` block is off.)

**Fix:** add an error listener; confirm SSL requirements for the deploy target.

### 10. No timeouts on any outbound `fetch`
There are no `AbortController`/timeouts anywhere. The model call (`lib/agent.ts`
lines 267-279) and Drive calls (`lib/drive.ts` lines 90-92) can hang
indefinitely, holding the SSE stream and server resources open.

**Fix:** add a per-request timeout via `AbortSignal.timeout(...)`.

### 11. Drive search is serial across connections
`lib/drive.ts` lines 156-198 awaits each connection in sequence. With several
drives this multiplies latency on a path the agent hits repeatedly.

**Fix:** use `Promise.all` over connections (cap concurrency if many drives are
connected).

### 12. `upsertDriveConnection` uses two statements instead of one
`lib/drive-connections.ts` lines 81-116 does a `SELECT` (to fetch the existing
id + preserve the refresh token) then `INSERT ... ON CONFLICT`, not in a
transaction.

**Fix:** collapse to a single upsert using
`coalesce(excluded.refresh_token_ciphertext, drive_connections.refresh_token_ciphertext)`
and `gen_random_uuid()` as the default id, removing the race window.

## Architecture / maintainability (incl. "too long" items)

### 13. `components/search-app.tsx` is 1,290 lines — far too large
This single client component holds all state, localStorage persistence, the
settings dialog, the SSE streaming loop, the file list, *and* a hand-written
markdown renderer. Suggested split:
- Markdown renderer (lines 1053-1290, ~240 lines) → `components/markdown.tsx`.
- Settings dialog (lines 607-750) → `components/settings-dialog.tsx`.
- Streaming/session logic (`runAgent`, persistence effects) → a
  `useQuerySessions` hook.

### 14. Hand-rolled markdown parser is a maintenance/robustness liability
The parser (lines 1053-1290) is XSS-safe (React-escaped, and `safeMarkdownHref`
blocks `javascript:` — nicely done). But it silently won't handle nested lists,
blockquotes, inline code inside bold, mixed emphasis, etc., and will need
ongoing edge-case patching.

**Fix:** consider `react-markdown` + `rehype-sanitize` (more correct, less
code); weigh against added bundle size.

### 15. `lib/agent.ts` is 839 lines and `runDriveAgent` is ~410 lines
`runDriveAgent` (lines 429-839) is one giant function. The two tool-call
branches (`search_drive` ~100 lines, `open_file` ~110 lines) should be extracted
into `handleSearchTool(...)` / `handleOpenFileTool(...)` helpers that take the
run state and return tool messages, making the budget/stop logic readable and
unit-testable.

### 16. `app/globals.css` is 910 lines
Less critical for CSS, but it's a single global sheet.

**Fix:** split by area (layout, settings, query list, markdown) or move to CSS
Modules colocated with components.

### 17. No tests at all
Several pure, high-value, easy-to-test functions have zero coverage: the
markdown parser, `formatMimeType` (`lib/file-types.ts`),
`validatePublicHttpsBaseUrl`/`isPrivateIpv4/6` (SSRF — tests strongly
recommended), `encryptSecret`/`decryptSecret` round-trip, `escapeDriveQuery`,
and `parseFinalAnswer`/`curatedListFiles`.

**Fix:** add a small unit suite (e.g. vitest); `AGENTS.md` already steers toward
non-browser verification.

## Dependencies / config / tooling

### 18. `xlsx` is dead config in `next.config.ts`
Line 9 lists `"xlsx"` in `serverExternalPackages`, but `xlsx` is not a
dependency and isn't imported anywhere — xlsx parsing is done manually via JSZip
in `drive.ts`.

**Fix:** remove `"xlsx"` from that array.

### 19. `@types/pg` is in `dependencies`
`package.json` line 15 — type packages belong in `devDependencies` (compare
`@types/pdf-parse`, which is correctly placed).

### 20. No Node version pinned
No `engines` field in `package.json` and no `.nvmrc`.

**Fix:** pin Node (e.g. `"engines": { "node": ">=20 <23" }` and/or an `.nvmrc`)
for reproducible builds.

### 21. `pdf-parse` is effectively unmaintained
It resolves to 1.1.4 (the old `module.parent` debug-file crash isn't present,
and the build passed), but the package hasn't been updated in years. Alternatives
like `unpdf` or `pdfjs-dist` are more actively maintained if issues arise.

**Resolved:** replaced `pdf-parse` (and `@types/pdf-parse`) with `unpdf`, an
actively maintained, serverless-friendly PDF.js wrapper. PDF extraction now goes
through the `extractPdfText` helper in `lib/drive.ts` (`getDocumentProxy` +
`extractText({ mergePages: true })`), and `serverExternalPackages` in
`next.config.ts` was updated accordingly.

### 22. `next lint` / `.eslintrc.json` are on the deprecated path
The lint run warns that `next lint` is removed in Next 16 and the legacy
`.eslintrc.json` should migrate to flat config + the ESLint CLI. Not urgent, but
it'll break on the next major upgrade.

**Resolved:** migrated to the ESLint flat config + CLI. `.eslintrc.json` was
replaced by `eslint.config.mjs`, which wraps `next/core-web-vitals` via
`FlatCompat` (the Next 15 `eslint-config-next` only ships the legacy
`extends`-style config) and adds a global `ignores` block for `.next`/build
output. The `lint` script now runs `eslint .` instead of `next lint`, and
`@eslint/eslintrc` is declared explicitly since the config imports it. Verified
that `npm run lint` is clean with no deprecation warning and that `.ts`/`.tsx`
files are still linted.

## Docs / housekeeping / nitpicks

- **README branch mismatch:** the README says Railway should track the `release`
  branch (lines 67-72), but the repo's only branch is `main`. Align the docs or
  create the branch.

  **Resolved:** the `release` branch now exists (locally and on `origin`) and
  points at the same commit as `main`, so the README's Railway instructions are
  accurate. No docs change required.
- **`lib/auth.ts` placeholder fallbacks:** `process.env.GOOGLE_CLIENT_ID ??
  "missing-google-client-id"` (lines 14-15) silently defers misconfiguration to a
  confusing Google error instead of failing fast like `lib/env.ts`'s `required()`.
  Consider reusing `env.googleClientId()` for consistency.

  **Resolved:** `authOptions` is now built lazily by `getAuthOptions()`
  (memoized, like `lib/db.ts`'s `getPool()`), resolving the credentials through
  `env.googleClientId()`/`env.googleClientSecret()`. A missing
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` now fails fast with a clear "Missing
  required environment variable" error on first use, while keeping the module
  import-safe for `next build` (matching the lazy env access used elsewhere). The
  consumers — `app/page.tsx` and `app/api/auth/[...nextauth]/route.ts` — were
  updated to call `getAuthOptions()` lazily.
- **`debugText` content preview:** ensure `DEBUG_LOG_CONTENT` stays off in prod
  (the README already warns this).

  **Resolved:** `isDebugContentLogEnabled()` now returns `false` whenever
  `NODE_ENV=production`, so content previews are never emitted in production
  regardless of the flag (metadata-only logging is unaffected). Enforced in code
  and covered by `test/debug-log.test.ts`; the README note was updated.
- **`getDriveConnection` uses `select *`** (lines 52-57) then maps explicit
  columns — prefer an explicit column list for stability.

  **Resolved:** replaced `select *` with an explicit column list matching the row
  mapping.
- **`next-env.d.ts` is committed** — harmless and Next regenerates it, but Next's
  own guidance is to gitignore it.

  **Resolved:** added `next-env.d.ts` to `.gitignore` and untracked it
  (`git rm --cached`); Next regenerates it on `next dev`/`next build`.
- **`.codex-debug` naming** in `lib/debug-log.ts` is a leftover from the
  generator; purely cosmetic.

  **Resolved:** renamed the debug-log output directory to the vendor-neutral
  `.debug/` across `lib/debug-log.ts`, `.gitignore`, and the README.

## Suggested priority order

1. #1 — delete the secret file (and rotate)
2. #2 — redirect SSRF hardening
3. #5 / #6 — correct HTTP status codes
4. #9 / #10 — pool error handler + fetch timeouts
5. #4 — sanitize Drive errors
6. #18 / #19 / #20 — quick config cleanups
7. #13–#16 — file-splitting refactors (separate pass)
8. #17 — add unit tests
