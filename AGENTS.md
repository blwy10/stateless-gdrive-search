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
  `parseGradeResponse` (the curated-mode relevance-grader reply parser, which
  defaults to keeping a file when the grader's reply can't be parsed),
  the debug-log gating helpers (`debugText`/`isDebugLogEnabled`/
  `isDebugContentLogEnabled`/`isDebugTranscriptLogEnabled`, which force all debug
  logging — metadata, content previews, and the full transcript dump — off when
  `NODE_ENV=production`), and the model-call logging helpers `modelEventPrefix`
  (grader calls log under `agent.grade.*` and the main agent under `agent.model.*`,
  so the two stay distinguishable in a shared-requestId transcript) and
  `extractReasoningContent` (reads a turn's chain-of-thought from whichever field
  the provider used — `reasoning_content` or `reasoning` — so reasoning is captured
  even on tool-call turns where `content` is null). `test/agent.test.ts` also
  covers `handleOpenFileTool`'s failure path with a mocked `openDriveFile` (a tool
  execution error must become a tool-result observation, never abort the run), its
  out-of-scope-connectionId path (a connectionId not in `selectedDriveIds` — usually
  the model hallucinating an id — is likewise rejected as an observation without
  opening the file, never thrown), invalid tool arguments (malformed JSON or a
  schema violation, via `parseToolArgs`, in the `open_file` and `search_drive`
  handlers), `dispatchToolCall`
  (unknown/hallucinated tool names are answered with an observation so every
  `tool_call` gets a reply; it also routes `review_file`), `isRetryableModelStatus`
  (the model-retry policy), and the curated `review_file` flow via
  `handleReviewFileTool` (keep on a relevant grade, discard on an irrelevant one,
  dedupe of already-reviewed files, the review budget, the out-of-scope guard, and
  the open-failure path — and that the file's content is never returned into the
  main loop's context). Add new tests here when you touch these functions.

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

  Curated file-list mode uses per-file relevance grading instead of loading file
  contents into the agent's context. When curating, the model is offered
  `search_drive` and `review_file` (not `open_file`). `review_file`
  (`handleReviewFileTool`) opens a candidate, emits a provisional `reviewing`
  event, then grades it in an isolated, single-shot model call
  (`gradeFileRelevance` → `parseGradeResponse`) whose own minimal conversation
  holds only the query and that one file. Crucially, the file's content is NOT
  returned into the main loop — only a compact verdict (`{reviewed, kept, reason}`)
  — so the curating conversation stays small no matter how many files it reviews.
  A relevant grade keeps the file (emits `kept`); an irrelevant one discards it
  (emits `discarded`, which the UI uses to drop it from "reviewing"). The grader
  is injected as `AgentRunContext.gradeFile` so tests can stub it without mocking
  the network; on any grader failure (request error or unparseable reply) it
  defaults to keeping the file, favouring recall.

  Debug logging keeps the grader distinct from the main agent. `callModel` takes a
  `caller` ("agent" vs "grader", via `modelEventPrefix`) so grader model calls log
  under `agent.grade.*` (`.request`/`.completed`/`.transcript`/`.failed`/`.error`),
  never `agent.model.*`, and each is tagged with the graded file's hash — the two
  share a requestId and step, and one step may grade several files, so the event
  namespace plus that hash are what make a grade attributable. With
  `DEBUG_LOG_TRANSCRIPT=1` every model call (agent and grader) logs full,
  untruncated `content` plus `reasoningContent` (reasoning models put their
  chain-of-thought in `reasoning_content`/`reasoning`, not `content`, which is null
  on tool-call turns — see `extractReasoningContent`). The keep/discard verdict and
  the grader's `reason` are also recorded on `agent.tool.review_file.completed`.

  The set of kept files (`AgentRunState.keptFiles`) is the authoritative curated
  result — there is no end-of-run marker, and no opened-files fallback: with the
  grader judging every file explicitly, an empty kept set is a valid "nothing
  relevant" result. Curated runs reuse `budget.maxOpenFileCalls` as the cap on
  `review_file` calls (tracked via `state.reviewFileCallCount`).

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
