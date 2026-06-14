<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Agent Instructions

- Do not run browser-based tests or browser automation for this project.
- Prefer non-browser verification such as `npm run typecheck`, `npm run lint`, or targeted unit-level checks when they are relevant.
- Unit tests live in `test/` and run with Vitest (`npm test`, or `npm run test:watch`).
  They cover mostly pure helpers (no network/DB/browser): `formatMimeType`,
  `encryptSecret`/`decryptSecret`, the SSRF guard
  (`validatePublicHttpsBaseUrl`/`isPrivateIpv4`/`isPrivateIpv6`/`isPrivateAddress`),
  `escapeDriveQuery`, `buildDriveSearchQuery` (the Drive `q` builder — see "Drive
  search recall" below), `emptyExtractionNote`, `parseFinalAnswer`, `resolveRoleSettings`
  (the per-role main/grader model resolver in `lib/model-settings.ts`, covered by
  `test/model-settings.test.ts`),
  `normalizeGradeVerdict` (the examiner's verdict normaliser — trims and caps the
  `reason`, supplies a default sentence when the model omits one, and normalises
  the `entities` list: trim, drop blanks, dedupe case-insensitively, cap to
  `MAX_GRADE_ENTITIES`), and
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
  via `parseToolArgs`, in the `open_file` and `search_drive` handlers), the
  `search_drive` notes (a productive search records progress and carries no `note`;
  a repeated query and a query that matches nothing each attach a corrective
  `note`, while a query that merely *overlaps* already-seen files is deliberately
  NOT flagged — searches are cheap, see "Drive search recall" below) and the
  search backstop (it sets `stopSearchingReason`, not `windDownReason`, so reading
  continues), and the
  `review_file` flow via `handleReviewFileTool` for both list modes (curated: keep
  on a relevant grade, discard on an irrelevant one, emit the lifecycle events;
  uncurated: examine for `entities` only, never keep/discard, emit no lifecycle
  events; plus dedupe of already-examined files, the out-of-scope guard, the
  open-failure path, that the file's content is never returned into the main loop,
  that `entities` ARE returned, and that a diminishing-returns `note` attaches once
  spend has stalled past the soft limit). The handlers still take the
  OpenAI-style `ToolCall` shape; the AI SDK tools in `buildAgentTools` are thin
  adapters over them, so testing the handlers directly still exercises the real
  run-resilience behaviour. Add new tests here when you touch these functions.

## Drive search recall, berry-picking & diminishing returns

  Recall (`buildDriveSearchQuery` in `lib/drive.ts`): Drive's `contains` operator
  matches the *whole* string, so a naive `name contains 'a b' or fullText contains
  'a b'` requires every term together and silently drops files that contain only
  some of them — e.g. the query "Airwallex feedback" misses a doc named "Airwallex
  Reflection" that never says "feedback". `buildDriveSearchQuery` therefore splits a
  multi-word query into terms (deduped case-insensitively, capped at
  `MAX_SEARCH_TERMS = 12`) and OR-s a `name`/`fullText` `contains` pair per term, so
  a partial match still surfaces. This only ever *widens* the candidate set (it is a
  strict superset of the old whole-string match); the agent and the examiner
  filter for true relevance afterwards. Single-word queries are unchanged. `orderBy`
  is intentionally left unset: Drive v3 has no `relevance` sort key, and omitting
  `orderBy` is the only way to get relevance ordering, which keeps the best matches
  near the top of the (20-capped) page. `escapeDriveQuery` is now only called from
  inside `buildDriveSearchQuery` (per-term), so `searchDriveFiles` passes the raw,
  trimmed query down rather than pre-escaping it.

  Berry-picking (`review_file` / the examiner): discovery follows leads that are
  only knowable after reading — internal codenames, jargon, expert↔lay term gaps,
  cross-referenced entities — that titles/metadata never reveal. The examiner
  (`gradeFileRelevance` → `generateObject` → `normalizeGradeVerdict`) therefore
  returns, alongside its relevance verdict, a short `entities` list of notable
  names/projects/terms found in the file. `handleReviewFileTool` surfaces those
  `entities` back into the main loop (the file's *content* never does), so the
  model can search for related files. This is the only capability `review_file`
  adds in *uncurated* list mode (which returns every match regardless) — and the
  reason both list modes share the examiner: discovery is identical, so curated
  results stay a strict subset of uncurated ones (curation is just the relevance
  filter on top).

  Search notes (`searchResultNote` in `lib/agent.ts`): a `search_drive` observation
  carries a corrective `note` only in two cheap-to-flag cases — an *exact repeat*
  (pure token waste, zero new information → "do not repeat it, vary the terms") and
  a query that matched *nothing* (`totalResultCount === 0` → "try different terms").
  A query that merely *overlaps* already-seen files is deliberately NOT flagged:
  searches are cheap (only a small result list enters context) and an overlapping
  query is often the model triangulating toward a new angle. Whether returns are
  diminishing is judged holistically over tokens (next section), not by any single
  search's novelty.

  Diminishing returns (the budget — see "LLM layer"): the normal stop is "we are
  no longer producing new useful results per token spent". `state.tokensSpent`
  accumulates every model call (main loop + examiner); `recordUsefulProgress`
  snapshots it whenever the result set grows (a kept file in curated; a
  newly-surfaced/read file otherwise); `tokensSinceProgress` is the gap.
  `diminishingReturnsNote` attaches a soft "returns are diminishing — wrap up
  unless you have a new angle" note once that gap passes `softProgressTokenLimit`
  (it explicitly preserves the berry-picking escape hatch), and
  `evaluateTokenBudget` (in `prepareStep`) hard-winds-down past
  `hardProgressTokenLimit`. The note fires on both `search_drive` and `review_file`
  results.

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
  `stopWhen: stepCountIs(budget.maxToolSteps)` (a loop-insurance *backstop*, not
  the normal stop — see "Budget" below), a `prepareStep`, and an `onStepFinish`.
  `prepareStep` records the current step, calls `evaluateTokenBudget`, then gates
  tools: a `windDownReason` (diminishing-returns hard limit, cost seatbelt, or
  context-window limit) drops *every* tool so the model must finish; a
  `stopSearchingReason` (the search-call backstop) drops only `search_drive` and
  keeps the read tool (`review_file` in list modes, `open_file` in synthesis) so
  the model can finish with what it found. `onStepFinish` folds the step's tokens
  into `state.tokensSpent`, tracks `state.lastInputTokens`, then logs. The SDK
  drives the whole loop — appending each assistant turn (with reasoning) and the
  tool results, re-prompting, and round-tripping reasoning across steps
  automatically — so there is no hand-rolled message bookkeeping or
  `reasoning_content` replay anymore. Synthesis runs that hit the step backstop
  mid-tool-use get one forced, tool-free turn (`forceSynthesis`) so they still
  synthesize instead of returning the raw file list.

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

  Examiner & list modes. Both list modes (curated and uncurated) read files via
  `review_file` so content never enters the main loop; only synthesis uses
  `open_file` (which reads content directly into context for synthesis). The tool
  split in `buildAgentTools` is therefore by `input.mode === "list"`, not by
  curation. `review_file` (`handleReviewFileTool`) opens a candidate and examines
  it in an isolated, single-shot structured call (`gradeFileRelevance` →
  `generateObject` → `normalizeGradeVerdict`) whose minimal prompt holds only the
  query and that one file. The file's content is NOT returned into the main loop —
  only a compact verdict `{examined, relevant, reason, entities}` (the `entities`
  are the berry-picking channel; see "Drive search recall"). Curated mode keeps
  the file iff relevant (emitting the provisional `reviewing` → `kept`/`discarded`
  sequence the UI shows); uncurated mode returns every match at search time, so it
  examines for `entities` only, never keeps/discards, and emits a neutral
  `Examining` progress line instead of the lifecycle events. The examiner is
  injected as `AgentRunContext.gradeFile` so tests can stub it without mocking the
  network; on any failure (request error or schema-invalid output) it defaults to
  relevant + empty entities, favouring recall. The `gradeFile` closure in
  `runDriveAgent` also folds the examiner call's token usage (returned by
  `gradeFileRelevance` as `{verdict, usageTokens}`) into `state.tokensSpent` — it
  is the dominant token cost in list modes, so the budget must count it.

  Debug logging keeps the examiner distinct from the main agent. The main loop's
  `onStepFinish` logs `agent.model.completed` (and, under `DEBUG_LOG_TRANSCRIPT=1`,
  `agent.model.transcript` with full untruncated `content` + `reasoningContent` +
  tool calls + raw response body). The examiner logs `agent.grade.completed` /
  `agent.grade.failed`, each tagged with the file's hash and an `entityCount`,
  never `agent.model.*` — the two share a requestId and step, so the namespace
  plus that hash are what make a grade attributable. Reasoning comes from the SDK's
  unified `reasoningText`. The verdict, `reason`, and `entityCount` are also
  recorded on `agent.tool.review_file.completed`.

  The set of kept files (`AgentRunState.keptFiles`) is the authoritative curated
  result — there is no end-of-run marker, and no opened-files fallback: with the
  examiner judging every file explicitly, an empty kept set is a valid "nothing
  relevant" result.

## Budget: diminishing returns, not caps

  The normal stop is diminishing returns measured in tokens — keep going while the
  run still produces new useful results per token, stop once it doesn't. Defaults
  live in `defaultAgentBudgets` (uniform across modes — `UNIFORM_BUDGET`) and are
  deliberately generous *starting points*; instrument the logs and tune. Key
  fields on `AgentBudget`:
  - `softProgressTokenLimit` / `hardProgressTokenLimit` — tokens since the result
    set last grew (`tokensSinceProgress = state.tokensSpent -
    state.tokensAtLastProgress`). Past the soft limit, `diminishingReturnsNote`
    attaches a wrap-up nudge to tool results (preserving the berry-picking escape
    hatch); past the hard limit, `evaluateTokenBudget` sets `windDownReason`.
    `recordUsefulProgress` resets the clock when the result set grows.
  - `maxContextInputTokens` — per-call context-window health guard (mainly
    synthesis, which accumulates file content in context); set below the model's
    window. List modes keep content out of context so rarely hit it.
  - `maxTotalTokens` — cumulative-token cost seatbelt across all calls.
  - `maxToolSteps` / `maxSearchCalls` — loop-insurance backstops; the step cap
    matters most when a provider doesn't report token usage (then the token guards
    can't fire and the step cap carries the run). `maxSearchCalls` sets
    `stopSearchingReason` (stop searching, keep reading), not `windDownReason`.

  Token sourcing (`resolveUsageTokens`): we read the AI SDK's normalised `usage`
  (filled from each provider's response body — OpenAI Responses / Anthropic
  Messages / openai-compatible chat completions), preferring `totalTokens`, then
  `inputTokens + outputTokens`, then a char-based estimate of the visible text
  (assistant + reasoning) for providers that report no usage at all. Crucially
  `totalTokens` ALREADY includes reasoning/thinking tokens on every provider we use
  (billed as output), so `reasoningTokens` is logged for visibility but NEVER
  summed on top — that would double-count. The estimate path is the only place a
  fudge (`TOKEN_ESTIMATE_MULTIPLIER`, default 1) applies; real provider numbers are
  used as-is, and the context-window guard tracks raw `inputTokens` only. Raw usage
  is logged on `agent.model.completed` / `agent.grade.completed` for tuning.

  There is intentionally **no** `open_file`/`review_file` count budget anymore —
  reading is governed by diminishing returns + the context/cost backstops. Honesty
  checks that are baked in (see the design thread): a deterministic backstop always
  remains (token usage may be unreported); the DR signal lags, so thresholds are
  generous and reset on progress; synthesis has no per-file value signal until a
  future summariser, so its "useful progress" is just reading a new file (DR there
  leans on `maxContextInputTokens` + the model's own judgement); and the knob moves
  from "a cap" to "a slope threshold", so tune it from real runs.

  Multi-provider settings: `lib/model-settings.ts` carries a `provider`
  (`openai` | `anthropic` | `openai-compatible`) alongside the now-optional
  `baseUrl`. The operator default comes from `AI_PROVIDER`/`AI_BASE_URL`/`AI_MODEL`;
  per-user overrides live in `user_model_settings` (the `provider` column and
  nullable `base_url` are added idempotently by `db/schema.sql`). `baseUrl` is only
  required — and only SSRF-validated — for `openai-compatible`.

  Two model roles (main vs grader): the agent resolves two independent models per
  run. The **main** model drives the loop + synthesis (`generateText` and
  `forceSynthesis`); the **grader** is a separate, cheaper model used only by the
  examiner (`gradeFileRelevance`'s `generateObject`). `getEffectiveModelSettings`
  returns an `{ main, grader }` bundle; `runDriveAgent` resolves each with
  `resolveModel` and the `gradeFile` closure uses the grader one (its `agent.grade.*`
  log events now carry the grader's model/provider). Each role is configured
  independently: env defaults `AI_*` (main) and `GRADER_AI_*` (grader, key + model
  required) are BOTH required — there is no fallback between roles — and per-user
  overrides are independent per role (override one, the other, both, or neither;
  each unset role falls back to its OWN env default, never the other role). The
  pure `resolveRoleSettings(columns, envDefault)` picks custom-vs-env for a single
  role (a role is overridden only when its `model` AND api key are both stored) and
  is unit-tested in `test/model-settings.test.ts`. In `user_model_settings` a role
  is "present" iff its `model` + `api_key_ciphertext` are non-null, so the main
  config columns are now nullable and parallel `grader_*` columns hold the grader
  override; the role-scoped DELETE clears one role and drops the row once neither
  role is set.

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
