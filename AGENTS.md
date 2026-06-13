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
  `normalizeGradeVerdict` (the curated-mode grader's verdict normaliser — trims and
  caps the `reason` and supplies a default sentence when the model omits one), and
  the debug-log gating helpers (`debugText`/`isDebugLogEnabled`/
  `isDebugContentLogEnabled`/`isDebugTranscriptLogEnabled`, which force all debug
  logging — metadata, content previews, and the full transcript dump — off when
  `NODE_ENV=production`).
  `test/agent.test.ts` also covers the tool handlers directly:
  `handleOpenFileTool`'s failure path with a mocked `openDriveFile` (a tool
  execution error must become a tool-result observation, never abort the run), its
  out-of-scope-connectionId path (a connectionId not in `selectedDriveIds` — usually
  the model hallucinating an id — is rejected as an observation without opening the
  file, never thrown), invalid tool arguments (malformed JSON or a schema violation,
  via `parseToolArgs`, in the `open_file` and `search_drive` handlers), and the
  curated `review_file` flow via `handleReviewFileTool` (keep on a relevant grade,
  discard on an irrelevant one, dedupe of already-reviewed files, the review budget,
  the out-of-scope guard, and the open-failure path — and that the file's content is
  never returned into the main loop's context). The handlers still take the
  OpenAI-style `ToolCall` shape; the AI SDK tools in `buildAgentTools` are thin
  adapters over them, so testing the handlers directly still exercises the real
  run-resilience behaviour. Add new tests here when you touch these functions.

## LLM layer (Vercel AI SDK)

  The agent runs on the Vercel AI SDK (`ai` v6). `lib/model-provider.ts`
  (`resolveModel`) maps `EffectiveModelSettings` to a concrete `LanguageModel`,
  per-provider `providerOptions`, and a temperature:
  - `openai` → `createOpenAI().responses(model)`; stateless reasoning round-trip
    (`store: false` + `include: ["reasoning.encrypted_content"]` + `reasoningSummary`),
    so chain-of-thought is carried across steps without OpenAI retaining the convo.
  - `anthropic` → `createAnthropic().languageModel(model)`; extended thinking is
    opt-in via `ANTHROPIC_THINKING_BUDGET_TOKENS` (≥ 1024), which also drops the
    temperature (thinking forces temp 1) and only works on thinking-capable models.
  - `openai-compatible` → `createOpenAICompatible().chatModel(model)` (Fireworks/
    vLLM/custom; `baseUrl` required).
  All providers share an SSRF-safe `fetch` wrapper that bounds each request with a
  60s timeout, refuses redirects, and — for user-supplied ("custom") endpoints —
  pins the connection to public IPs via `ssrfSafeDispatcher`. The operator default
  endpoint is trusted and skips the dispatcher.

  `runDriveAgent` calls `generateText` with the tool set from `buildAgentTools`,
  `stopWhen: stepCountIs(budget.maxToolSteps)`, a `prepareStep` that records the
  current step and gates tools after a budget-forced stop (drop `search_drive`;
  keep `review_file` while curating, otherwise offer no tools so the model winds
  down), and an `onStepFinish` that logs each step. The SDK drives the whole loop —
  appending each assistant turn (with reasoning) and the tool results, re-prompting,
  and round-tripping reasoning across steps automatically — so there is no
  hand-rolled message bookkeeping or `reasoning_content` replay anymore. Synthesis
  runs that hit the step cap mid-tool-use get one forced, tool-free turn
  (`forceSynthesis`) so they still synthesize instead of returning the raw file list.

  Run-resilience invariant: tool handlers must return a tool-result observation,
  never throw — a thrown handler fails the SDK run. Handlers validate their own
  arguments (`parseToolArgs`), and the SDK tools use a pass-through `inputSchema`
  (`looseToolSchema`) so malformed/extra fields never raise the SDK's
  `InvalidToolInputError`; the handler returns an observation and the model retries,
  preserving "bad args → retry, never abort" across every provider (including
  non-strict ones). As a final backstop, the whole `generateText` call is wrapped in
  try/catch: because `AgentRunState` is mutated in place, a throw (model error after
  retries, a hallucinated/unrepairable tool call, a timeout) still finalizes with
  whatever was gathered instead of discarding the run. `generateText` is given
  `maxRetries: MODEL_REQUEST_MAX_RETRIES`, so the SDK retries transient model
  failures (network, timeout, 5xx, 429) and never retries 4xx.

  Tool calls within one step may run in parallel (SDK default). The handlers stay
  race-safe because each one's check-and-reserve (dedupe + budget) is synchronous,
  before any `await`, so two parallel calls for the same file can't both pass the
  dedupe/budget gate. `prepareStep` sets `state.currentStep` before each step so the
  handlers can attribute their debug logs.

  Reasoning is unified: it is logged from the SDK's `reasoningText` (a single field,
  whatever the provider) and carried across turns by the SDK's `response.messages`
  round-trip — exactly the multi-turn / interleaved-thinking case the old
  hand-rolled `assistantTurnMessage` solved by hand. Different providers expose full
  vs summarized reasoning; that is fine, the structure is the same.

  Curated file-list mode uses per-file relevance grading instead of loading file
  contents into the agent's context. When curating, the model is offered
  `search_drive` and `review_file` (not `open_file`). `review_file`
  (`handleReviewFileTool`) opens a candidate, emits a provisional `reviewing`
  event, then grades it in an isolated, single-shot structured call
  (`gradeFileRelevance` → `generateObject` → `normalizeGradeVerdict`) whose own
  minimal prompt holds only the query and that one file. Crucially, the file's
  content is NOT returned into the main loop — only a compact verdict
  (`{reviewed, kept, reason}`) — so the curating conversation stays small no matter
  how many files it reviews. A relevant grade keeps the file (emits `kept`); an
  irrelevant one discards it (emits `discarded`, which the UI uses to drop it from
  "reviewing"). The grader is injected as `AgentRunContext.gradeFile` so tests can
  stub it without mocking the network; on any grader failure (request error or
  schema-invalid output) it defaults to keeping the file, favouring recall.

  Debug logging keeps the grader distinct from the main agent. The main loop's
  `onStepFinish` logs `agent.model.completed` (and, under `DEBUG_LOG_TRANSCRIPT=1`,
  `agent.model.transcript` with full untruncated `content` + `reasoningContent` +
  tool calls + raw response body). The grader logs `agent.grade.completed` /
  `agent.grade.failed`, each tagged with the graded file's hash, never
  `agent.model.*` — the two share a requestId and step, so the namespace plus that
  hash are what make a grade attributable. Reasoning comes from the SDK's unified
  `reasoningText`, captured the same way for every provider even on tool-call turns
  where `content` is empty. The keep/discard verdict and the grader's `reason` are
  also recorded on `agent.tool.review_file.completed`.

  The set of kept files (`AgentRunState.keptFiles`) is the authoritative curated
  result — there is no end-of-run marker, and no opened-files fallback: with the
  grader judging every file explicitly, an empty kept set is a valid "nothing
  relevant" result. Curated runs reuse `budget.maxOpenFileCalls` as the cap on
  `review_file` calls (tracked via `state.reviewFileCallCount`).

  Multi-provider settings: `lib/model-settings.ts` carries a `provider`
  (`openai` | `anthropic` | `openai-compatible`) alongside the now-optional
  `baseUrl`. The operator default comes from `AI_PROVIDER`/`AI_BASE_URL`/`AI_MODEL`;
  per-user overrides live in `user_model_settings` (the `provider` column and
  nullable `base_url` are added idempotently by `db/schema.sql`). `baseUrl` is only
  required — and only SSRF-validated — for `openai-compatible`.

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
