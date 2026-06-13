<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Agent Instructions

- Do not run browser-based tests or browser automation for this project.
- Prefer non-browser verification such as `npm run typecheck`, `npm run lint`, or targeted unit-level checks when they are relevant.
- Unit tests live in `test/` and run with Vitest (`npm test`, or `npm run test:watch`).
  They cover mostly pure helpers (no network/DB/browser): `formatMimeType`,
  `encryptSecret`/`decryptSecret`, the SSRF guard
  (`validatePublicHttpsBaseUrl`/`isPrivateIpv4`/`isPrivateIpv6`/`isPrivateAddress`),
  `escapeDriveQuery`, `emptyExtractionNote`, `parseFinalAnswer`,
  and the debug-log gating helpers (`debugText`/`isDebugLogEnabled`/
  `isDebugContentLogEnabled`/`isDebugTranscriptLogEnabled`, which force all debug
  logging — metadata, content previews, and the full transcript dump — off when
  `NODE_ENV=production`). `test/agent.test.ts` also
  covers `handleOpenFileTool`'s failure path with a mocked `openDriveFile` (a tool
  execution error must become a tool-result observation, never abort the run), its
  out-of-scope-connectionId path (a connectionId not in `selectedDriveIds` — usually
  the model hallucinating an id — is likewise rejected as an observation without
  opening the file, never thrown), invalid tool arguments (malformed JSON or a
  schema violation, via `parseToolArgs`, in all three handlers), `dispatchToolCall`
  (unknown/hallucinated tool names are answered with an observation so every
  `tool_call` gets a reply), `isRetryableModelStatus` (the model-retry policy), and
  the curated `keep_file` flow via `handleKeepFileTool`. Add new tests here when you
  touch these functions.

  Run-resilience invariant: anything that processes a model tool call must return a
  tool-result observation, never throw — a throw bubbles out of `runDriveAgent` and
  aborts the whole run (discarding everything gathered). This covers bad arguments,
  out-of-scope/unknown ids, unknown tool names, and per-tool execution errors.
  `dispatchToolCall` centralises routing and guarantees every `tool_call` is
  answered (an unanswered one makes the next request a malformed conversation the
  provider rejects). `callModel` retries transient failures — network errors,
  timeouts, HTTP 5xx, and 429 — up to `MODEL_REQUEST_MAX_RETRIES` (4xx is never
  retried; see `isRetryableModelStatus`), and an empty model response finalizes
  gracefully with partial results instead of throwing.

  Curated file-list mode does live curation: opening a file emits a provisional
  `reviewing` event, and the model promotes relevant files with the `keep_file`
  tool (`handleKeepFileTool`), which emits a `kept` event. The set of kept files
  (`AgentRunState.keptFiles`) is the authoritative curated result — there is no
  end-of-run `CURATED_FILE_LIST` marker anymore. `keep_file` is only offered to the
  model when curating, and a file must be opened before it can be kept.
  `curatedResultFiles(keptFiles, openedFiles)` resolves the final list and applies
  a safety net: if the model opened files but kept none, it falls back to the
  reviewed (opened) files rather than returning nothing (and reports `fallback`).

## Railway MCP: pin the project/environment first

The configured `railway` MCP server is backed by the local Railway CLI, so its
environment-scoped tools resolve the **currently linked** project/environment/
service from local CLI state. When nothing is linked, those tools fail with
`Failed to connect to MCP server 'railway'`. This reads like a transport/network
error but is actually a missing-context error — retrying does not help.

- Works without linking (no environment context needed): `whoami`,
  `list_projects`, and `list_services` (pass an explicit `project_id`).
- Needs a linked context: `environment_status`, `get_service_config`,
  `list_deployments`, `list_variables`, `get_logs`, `set_variables`,
  `generate_domain`, `update_service`, `add_reference_variable`, etc.

Fix: link the project once up front, then **also pass explicit IDs on every MCP
call** (the MCP does not reliably share the working-directory link, so explicit
IDs are the robust path):

```bash
railway link --project <project-id> --environment production --service <service-name>
railway status --json   # prints the linked project/environment/service IDs
```

Discover the project/environment/service IDs at runtime rather than hardcoding
them — they change if infrastructure is recreated and should be treated as
sensitive (do not commit them):

- `railway status --json` once a project is linked, or
- the MCP `list_projects` / `list_services` tools, then resolve the environment
  by name (commonly `production`).
