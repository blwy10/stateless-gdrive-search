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
  search recall" below), `emptyExtractionNote`, `resolveFileContent` (the
  per-file content-cap resolver in `lib/drive.ts` — full/empty/truncated/summarized
  disposition, with a fake summarizer hook; see "Oversize files" below),
  `parseFinalAnswer` (the synthesis answer parser: extracts/strips the
  `FORMAT: markdown|plain` directive and falls back to markdown auto-detection;
  it matches the directive at the start of any line within a bounded leading
  window — `MAX_FORMAT_PREAMBLE_CHARS` — so a short model preamble before the
  FORMAT line is dropped instead of leaking the literal directive, while an
  incidental `FORMAT:` line deep in a genuine answer cannot truncate it),
  `parseSources`/`resolveSources` (the synthesis citation parser + resolver — see
  "File display: results vs touched" below), `resolveRoleSettings`
  (the per-role main/grader/summarizer model resolver in `lib/model-settings.ts`,
  covered by `test/model-settings.test.ts`) and `coerceReasoningEffort` (the
  reasoning-effort normaliser for STORED values — trims/lower-cases to one of
  `none|minimal|low|medium|high`, else defaults to `"none"` = the explicit
  provider default; never null; same file/test — see "Reasoning effort" below),
  the per-provider wiring of which is asserted in
  `test/model-provider.test.ts` (`resolveModel`: openai's `reasoningEffort`,
  openai-compatible's name-independent `openaiCompatible.reasoningEffort`, and
  Anthropic's effort→thinking-budget mapping with temperature dropped + max-tokens
  bumped),
  `normalizeGradeVerdict` (the examiner's verdict normaliser — trims and caps the
  `reason`, supplies a default sentence when the model omits one, normalises
  the `entities` list: trim, drop blanks, dedupe case-insensitively, cap to
  `MAX_GRADE_ENTITIES`, and coerces `aboutSubject` to one of `ABOUT_SUBJECT_VALUES`,
  defaulting to `"unknown"` for a missing/unrecognised value — see "Entity
  conflation: subject anchoring"),
  `describeSubjectIdentity` (the subject/identity anchor — formats `Name <email>`
  per *selected* connection, deduped case-insensitively, email-only when the
  drive name is missing, null when nothing is selected/resolvable) and
  `systemPrompt` (asserts the entity-conflation guard renders *without
  over-correcting*: the owner identity + the "authorship/mention ≠ aboutness"
  caution appear in every mode, the universal anti-conflation rule appears in
  synthesis while owner-profiling stays *gated* on a person-specific request — the
  prompt must NOT say "attribute facts only to the subject" — and the whole block
  is omitted when no owner is resolvable; plus that *multiple* connections (possibly
  different people) render the cautious "may belong to different people" wording
  rather than the single-owner "is X" phrasing (so "my"/"me"/"I" is not bound to
  every owner), that the prompt-injection guard ("untrusted data, not instructions")
  appears in every mode, that the weak-evidence instruction is synthesis-only (never
  list mode), and that synthesis carries a concrete FORMAT/SOURCES example — see
  "Entity conflation: subject anchoring" below), and
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
  NOT flagged — searches are cheap, see "Drive search recall" below), that a
  search records every new hit into the run's *touched* set and streams it in all
  modes (in curated that hit is a candidate, not progress, so it must NOT reset
  the diminishing-returns clock — `tokensAtLastProgress` stays put) and the
  search backstop (it sets `stopSearchingReason`, not `windDownReason`, so reading
  continues), and the
  `review_file` flow via `handleReviewFileTool` for both list modes (curated: keep
  on a relevant grade, discard on an irrelevant one, emit the lifecycle events;
  uncurated: examine for `entities` only, never keep/discard, emit no lifecycle
  events; plus dedupe of already-examined files, the out-of-scope guard, the
  open-failure path, that the file's content is never returned into the main loop,
  that `entities` ARE returned, and that a diminishing-returns `note` attaches once
  spend has stalled past the soft limit). It also covers the oversize-file path
  (see "Oversize files"): `summarizeOversizeContent` (success returns the trimmed
  summary + folds usage; an empty result or a thrown model call returns
  `{ summary: null }` so the caller truncates, never aborts), and that
  `handleOpenFileTool` passes the `summarizeOversize` hook to `openDriveFile`
  (so an oversize synthesis read is condensed) while `handleReviewFileTool` does
  NOT (list mode keeps truncation). The handlers still take the
  OpenAI-style `ToolCall` shape; the AI SDK tools in `buildAgentTools` are thin
  adapters over them, so testing the handlers directly still exercises the real
  run-resilience behaviour. Add new tests here when you touch these functions.

## Module layout

  Several formerly-monolithic files were split into focused modules behind a
  barrel; the public import paths are unchanged, so `@/lib/agent`, `@/lib/drive`,
  and `@/lib/model-settings` resolve to each directory's `index.ts`. Symbol names
  referenced elsewhere in this doc are unchanged — only their files moved.

  - `lib/agent/` (was `lib/agent.ts`): `types` (request/budget/progress/tool
    schemas), `prompts`, `tokens`, `logging`, `examiner` (grading), `summarizer`,
    `answer` (final-answer + SOURCES parsing + `buildAgentResult`), `budget`
    (limits + diminishing-returns notes), `state` (`FileSet`, `AgentRunContext`,
    `AgentRunState`, `createRunState`, `recordTouched`), `tool-runtime`
    (safeJson/retries/`parseToolArgs`), `tools` (`buildAgentTools`),
    `handlers/{search,open,review}` (the tested tool handlers), and `run`
    (`runDriveAgent`, decomposed into `resolveRunModels`/`selectDriveIds`/
    `buildRunContext`/`runMainModelLoop`/`forceSynthesis`/`finalizeRun`).
  - `lib/drive/` (was `lib/drive.ts`): `types`, `query`
    (`buildDriveSearchQuery`/`escapeDriveQuery`), `client` (token refresh +
    `googleFetch` + metadata/download/export), `extract` (pdf/pptx/xlsx/docx text),
    `content` (`resolveFileContent`/`emptyExtractionNote` + the `MAX_FILE_CHARS`
    cap), `search` (`searchDriveFiles`), `open` (`openDriveFile`).
  - `lib/model-settings/` (was `lib/model-settings.ts`): `constants`
    (enums + coercion), `types` (summaries/effective/inputs + parsers), `env`
    (`envSettings`), `resolve` (`resolveRoleSettings` + summary/SSRF helpers),
    `repository` (all DB reads/writes).
  - `hooks/use-query-sessions.ts` keeps the hook; persistence and the SSE stream
    moved to `hooks/query-sessions/{types,storage,stream}` (the per-event session
    update is now the pure `applyStreamEvent` reducer in `stream`).
  - `components/search-app.tsx` is now a thin orchestrator over
    `components/search/*` (top-bar, login-panel, connections-strip, query-list,
    query-form, run-status, results-view, result-views).
  - `components/settings-dialog.tsx` is the modal shell; the per-role form moved to
    `components/settings/{constants,use-role-settings,role-settings-form}`.

  `AgentRunState` (god-object cleanup): the four parallel `(array, Set)` pairs that
  tracked touched/opened/reviewed/kept files are now four `FileSet` instances
  (`state.touched`/`opened`/`reviewed`/`kept`). `FileSet` encapsulates the dedupe:
  `claim(idLike)` reserves a key synchronously before an async fetch (the
  race-safe open/review path), `collect(file)` stores the fetched object, `add(file)`
  does both when the object is already in hand (touched/kept), and `has`/`list()`/
  `size` read it. `knownFileKeys`/`searchedQueries` stay plain `Set`s.

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

## Entity conflation: subject anchoring

  A self-referential query ("synthesize my career") never names *who* the subject
  is, so the agent used to infer identity from filenames and could bleed a second
  person's identity into the answer. The classic trap: a recommendation letter the
  owner *wrote for a friend* — its filename carries the owner's name (the author),
  its body is about the friend — which is genuinely career-relevant, so neither the
  retriever nor the relevance examiner filters it out, and synthesis then merged
  the friend's name in as an alias (the real "Yen" incident). Relevance ≠
  aboutness, so a relevance filter alone cannot catch this.

  Guard (prompt-level): `describeSubjectIdentity(connections, selectedDriveIds)`
  (in `lib/agent.ts`) builds a `Name <email>` identity from the *selected*
  connections' `driveName`/`driveEmail` and `runDriveAgent` threads it into every
  prompt via `systemPrompt` → `basePrompt`/`synthesisSystemPrompt`. Crucially the
  system prompt is query-INDEPENDENT (it depends only on `mode`/`curateList`; the
  query is a separate user message), so the wording must stay neutral or it
  over-corrects *topical* queries that aren't about a person at all. So `basePrompt`
  states the owner identity as a *fact* and binds only first-person words
  ("my"/"me"/"I") to it (inert when none appear), plus the universally-true caution
  that a file may be authored-by / addressed-to / merely-mention a person without
  being *about* them (a title name is often the author/recipient, not the topic).
  `synthesisSystemPrompt` adds a universal correctness rule (attribute each fact to
  the correct person; never merge two people or alias one to another unless a source
  says they're the same) and GATES the build-a-profile-of-the-owner behavior on
  "when the request is specifically about a person" — so "summarize the finance
  deck" is NOT forced to be about the owner. The first draft ("the subject of the
  request is the owner" + "attribute facts only to the subject") was exactly that
  over-correction and was removed; `test/agent.test.ts` locks this in (asserts the
  prompt does NOT contain "Attribute facts only to the subject" and DOES gate on a
  person-specific request). When no identity resolves the whole block is omitted.
  The resolved identity is content/PII, so `agent.connections.selected` logs it only
  through `debugText` (gated, production-off).

  The examiner is now subject-aware too (the first step of the structural fix): when
  a subject identity is present, `gradeSystemPrompt(subject)` (in `lib/agent/examiner.ts`)
  threads the owner anchor + aboutness caution into the grader and asks it to classify
  `aboutSubject` (`subject` | `other_person` | `not_person` | `unknown`, see
  `ABOUT_SUBJECT_VALUES`); `runDriveAgent`'s `gradeFile` closure passes the run's
  `subjectIdentity` to `gradeFileRelevance`. The verdict is auditable (logged on
  `agent.grade.completed` and `agent.tool.review_file.completed`, coarse enum, not
  PII) but does NOT yet gate keep/discard — relevance still decides curation,
  preserving recall (a file about another person can still be relevant). For multiple
  connections the prompts also no longer merge distinct owners or bind first-person
  to all of them (see `systemPrompt` above). Remaining follow-up: actually *acting* on
  `aboutSubject` in curation/synthesis. Still prompt+heuristic level — it reduces but
  does not *guarantee* prevention.

  Prompt-injection note (related): every content-ingesting prompt — `basePrompt`
  (main agent), `gradeSystemPrompt` (examiner), and `SUMMARIZE_SYSTEM_PROMPT`
  (summarizer) — now tells the model to treat file contents as untrusted data, not
  instructions. This is defence-in-depth, not a guarantee.

## LLM layer (Vercel AI SDK)

  The agent runs on the Vercel AI SDK (`ai` v6). `lib/model-provider.ts`
  (`resolveModel`) maps `EffectiveModelSettings` to a concrete `LanguageModel`,
  per-provider `providerOptions`, a temperature, and a `maxOutputTokens` (see the
  Anthropic note). The role's `reasoningEffort` (when set; `null` omits it) is
  threaded into each provider's native shape — see "Reasoning effort" below:
  - `openai` → `createOpenAI().responses(model)`; stateless reasoning round-trip
    (`store: false` + `include: ["reasoning.encrypted_content"]` + `reasoningSummary`),
    so chain-of-thought is carried across steps without OpenAI retaining the convo.
    Effort → `reasoningEffort`.
  - `anthropic` → `createAnthropic().languageModel(model)`; no `reasoning_effort`
    param, so effort maps to an extended-thinking budget via
    `reasoningEffortToAnthropicBudget` (`minimal`→1024 … `high`→16384; `none` → 0 =
    thinking OFF, the safe default since thinking only works on thinking-capable
    models and forces temp 1). When on, the temperature is dropped and
    `maxOutputTokens` is set to `budget + 8192` (the API needs `max_tokens > budget`).
  - `openai-compatible` → `createOpenAICompatible().chatModel(model)` (Fireworks/
    vLLM/custom; `baseUrl` required). Effort → `reasoning_effort` via the
    name-independent `openaiCompatible` provider-options key.
  All providers share an SSRF-safe `fetch` wrapper that bounds each request with a
  per-role timeout (`resolveModel` takes it as a parameter — default 60s
  `MODEL_REQUEST_TIMEOUT_MS`; the **summarizer** passes `SUMMARIZER_REQUEST_TIMEOUT_MS`
  = 180s because its single ~8k-token output legitimately runs ~50s+ and the 60s
  ceiling otherwise aborts healthy summaries into a truncation fallback — see
  "Oversize files"), refuses redirects, and — for user-supplied ("custom") endpoints —
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
  `generateObject` → `normalizeGradeVerdict`) whose minimal prompt holds the
  query, the run's subject identity when resolved (`gradeSystemPrompt(subject)`),
  and that one file. The file's content is NOT returned into the main loop —
  only a compact verdict `{examined, relevant, reason, entities}` (the `entities`
  are the berry-picking channel; see "Drive search recall"). The verdict also
  carries `aboutSubject` (auditable/logged, not in the tool payload — see "Entity
  conflation: subject anchoring"). Curated mode keeps
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

  The set of kept files (`AgentRunState.kept`, a `FileSet`) is the authoritative curated
  *primary* result — there is no end-of-run marker, and no opened-files fallback:
  with the examiner judging every file explicitly, an empty kept set is a valid
  "nothing relevant" result. (Curated runs still accumulate a *touched* set for the
  audit disclosure — see the next section.)

## File display: results vs touched

  The agent surfaces two file lists on the terminal `final` event (and the UI
  renders them as two panels): a **primary result list** (`files`) and an **audit
  "touched" list** (`touchedFiles`), where `touchedFiles` ⊇ `files` always.

  - `touchedFiles` is every file the agent *encountered* this run — search
    candidates plus anything it opened/reviewed — tracked uniformly across all
    modes by `recordTouched` (which dedupes via the touched `FileSet` and emits
    one `file` event per file). It is the disclosure ("Files touched") the UI
    hides behind a toggle. `state.touched` (a `FileSet`) replaced the old, misnamed
    `referencedFiles` and is now populated in curated mode too.
  - `files` is the per-mode **result** — the thing the user actually wants:
    - **synthesis** → the files the answer *cites*. The model ends its answer with
      a trailing `SOURCES:` block of `connectionId/fileId` lines (see
      `synthesisSystemPrompt`); `parseSources` strips that block from the rendered
      answer (so the prose isn't duplicated) and `resolveSources` looks each
      citation up in `touchedFiles` — dropping ids the agent never saw (the
      hallucination guard) and falling back to `state.openedFiles` when nothing
      resolves, so a synthesis that read files never shows a sourceless result.
    - **curated list** → `keptFiles` (examiner-kept; see above).
    - **uncurated list** → every touched file (all matches; here result == touched,
      so the UI auto-hides the redundant disclosure).

  `buildResult` (in `runDriveAgent`) assembles both lists for the `final` event in
  both the success and error/partial branches. Live streaming: `file` events feed
  the touched list in all modes; the hook also mirrors them into the primary list
  *only* in uncurated mode (where they are results), while curated keeps stream via
  `kept` and synthesis sources resolve only at `final`. Opening a file in synthesis
  is therefore no longer what makes it a result — the model's citation is.

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
  is logged on `agent.model.completed` / `agent.grade.completed` /
  `agent.summarize.completed` for tuning.

  There is intentionally **no** `open_file`/`review_file` count budget anymore —
  reading is governed by diminishing returns + the context/cost backstops. Honesty
  checks that are baked in (see the design thread): a deterministic backstop always
  remains (token usage may be unreported); the DR signal lags, so thresholds are
  generous and reset on progress; synthesis has no per-file *relevance* signal until
  a future synthesis-side examiner (distinct from the content-condensing
  `summarizer` role, which has no verdict), so its "useful progress" is just reading
  a new file (DR there leans on `maxContextInputTokens` + the model's own
  judgement); and the knob moves from "a cap" to "a slope threshold", so tune it
  from real runs.

  Multi-provider settings: `lib/model-settings.ts` carries a `provider`
  (`openai` | `anthropic` | `openai-compatible`) alongside the now-optional
  `baseUrl`. The operator default comes from `AI_PROVIDER`/`AI_BASE_URL`/`AI_MODEL`;
  per-user overrides live in `user_model_settings` (the `provider` column and
  nullable `base_url` are added idempotently by `db/schema.sql`). `baseUrl` is only
  required — and only SSRF-validated — for `openai-compatible`.

  Three model roles (main vs grader vs summarizer): the agent resolves three
  independent models per run. The **main** model drives the loop + synthesis
  (`generateText` and `forceSynthesis`); the **grader** is a separate, cheaper model
  used only by the examiner (`gradeFileRelevance`'s `generateObject`); the
  **summarizer** condenses an oversize file into the synthesis budget
  (`summarizeOversizeContent`'s `generateText`) — see "Oversize files" below.
  `getEffectiveModelSettings` returns an `{ main, grader, summarizer }` bundle;
  `runDriveAgent` resolves each with `resolveModel` and injects the grader via the
  `gradeFile` closure and the summarizer via the `summarizeOversize` closure (each
  folds its own token usage into `state.tokensSpent`; `agent.grade.*` /
  `agent.summarize.*` log events carry that role's model/provider). Each role is
  configured independently: env defaults `AI_*` (main), `GRADER_AI_*` (grader), and
  `SUMMARIZER_AI_*` (summarizer) — each key + model required — are ALL required;
  there is no fallback between roles. Per-user overrides are independent per role
  (override any subset; each unset role falls back to its OWN env default, never
  another role's). The pure `resolveRoleSettings(columns, envDefault)` picks
  custom-vs-env for a single role (a role is overridden only when its `model` AND
  api key are both stored) and is unit-tested in `test/model-settings.test.ts`. In
  `user_model_settings` a role is "present" iff its `model` + `api_key_ciphertext`
  are non-null, so the main config columns are nullable and parallel `grader_*` /
  `summarizer_*` columns hold those overrides; the role-scoped DELETE clears one
  role and drops the row once no role is set.

## Oversize files: summarize instead of truncate

  The single per-file content cap is `MAX_FILE_CHARS` (32k chars ≈ 8k tokens),
  applied in `lib/drive.ts` by `resolveFileContent` — the one place the cap lives,
  shared by both read paths. A file under the cap returns as-is; an empty
  extraction returns `emptyExtractionNote`; over the cap the default is a hard
  truncation (the `[Truncated at …]` marker). `openDriveFile` takes an optional
  `summarizeOversize` hook (type `OversizeSummarizer`): when present AND the content
  is over the cap, the hook condenses the full text and `resolveFileContent` returns
  that (disposition `"summarized"`, re-capped defensively if the model overshoots)
  instead of truncating; if the hook returns null/blank — OR an implausibly short
  summary below `MIN_SUMMARY_CHARS` (`MAX_FILE_CHARS / 4`), the over-compression
  safety net — it falls back to truncation (which preserves more than a near-empty
  "summary").
  `lib/drive` itself imports no model — the hook is a plain injected function, so the
  utils scripts and tests still call `openDriveFile` (no hook → truncation) unchanged.

  ONLY the synthesis read path passes the hook (`handleOpenFileTool`); list-mode
  `review_file` deliberately does NOT (maintainer decision, 2026-06): synthesis
  content is the answer's evidence, so condensing the whole file beats dropping its
  tail; the grader path is the highest-volume/dominant-cost path and a query-focused
  summary feeding a relevance judge is mildly circular. Trade-off accepted: in
  curated list mode a relevant file whose relevance is in the truncated tail can
  still be wrongly discarded. Enabling the grader path later is a ~1-line change
  (pass the hook in `handleReviewFileTool`). The summary is a faithful WHOLE-document
  condensation, NOT a query filter (`summarizeOversizeContent` /
  `SUMMARIZE_SYSTEM_PROMPT`): cover every section end-to-end, use the query only to
  bias detail (keep-in-full vs compress) never to drop topics — a separate step
  judges relevance — preserve names/figures/codenames verbatim, add nothing, and use
  most of the ~`SUMMARY_TARGET_TOKENS` budget rather than a brief abstract. (This
  prompt is the primary length control; the `MIN_SUMMARY_CHARS` floor above is the
  safety net. The earlier "keep only query-relevant content" framing caused
  pathological over-compression — e.g. an 81k-char file summarised to ~400 chars — so
  it was replaced.) It also carries the prompt-injection guard (treat the document as
  data, not instructions). Input is capped at `MAX_SUMMARY_INPUT_CHARS` (~100k tokens
  — the extreme tail is head-truncated before summarizing; map-reduce is a deliberate
  follow-up) and the output budget is floored at `SUMMARY_MIN_OUTPUT_TOKENS` so it can
  fill the target. An over-short summary is flagged at `warn` level on
  `agent.summarize.completed` (`belowUsefulFloor` + `compressionRatio`). Like the
  grader, failures degrade safely (return null → truncation) and never throw.

## Reasoning effort

  Each role (main + grader + summarizer) carries a `reasoningEffort`
  (`none|minimal|low|medium|high`; `"none"` is the EXPLICIT provider default — the
  option is omitted — never an implicit "unset") on `EffectiveModelSettings`,
  always set (never null), applied per-provider by `resolveModel` (see "LLM
  layer"). The env vars `AI_REASONING_EFFORT` / `GRADER_AI_REASONING_EFFORT` /
  `SUMMARIZER_AI_REASONING_EFFORT` are REQUIRED and strictly validated —
  `requireReasoningEffortEnv` throws at startup on an unrecognized value (env
  config is explicit; see "Environment variables").
  Stored per-user overrides instead use the lenient `coerceReasoningEffort` (a
  legacy/stray DB value degrades to `"none"`, since it comes from our own
  enum-constrained UI). Per-user overrides live in the nullable `reasoning_effort`
  / `grader_reasoning_effort` / `summarizer_reasoning_effort` columns (plaintext —
  not a secret) and flow through the same settings API/UI as the other model fields.
  Design rule: effort is an *attribute* of a role's override, not an override on
  its own — a role only counts as "custom" when its `model` + api key are both
  stored (`resolveRoleSettings`), so effort rides along with a custom model;
  a role left on its env default takes effort from its env var. Lowering the
  grader's effort is the cheapest cost lever for the high-volume examiner. The
  resolved effort is in the `agent.started` log (a coarse enum, not PII, so logged
  plainly) for all three roles. It applies to every model call — the main loop,
  `forceSynthesis`, the examiner's `generateObject`, and the summarizer's
  `generateText` (the grader is the dominant token cost in list modes, so its
  effort matters most; the summarizer runs only on oversize synthesis reads).

  Per-provider mapping (`resolveModel` in `lib/model-provider.ts`). The OpenAI and
  OpenAI-compatible providers take the effort string verbatim; Anthropic has no
  `reasoning_effort` on the path we use, so the level maps to an extended-thinking
  *integer* token budget (and, when on, drops temperature — the API forces it to 1
  — and sets `maxOutputTokens = budget + 8192`, since the API requires
  `max_tokens > budget_tokens`):

  | Our setting | openai `reasoningEffort` | openai-compatible `reasoning_effort` | anthropic `thinking.budgetTokens` | anthropic `maxOutputTokens` |
  | --- | --- | --- | --- | --- |
  | `minimal` | `"minimal"` | `"minimal"` | `1024` | `9216` |
  | `low` | `"low"` | `"low"` | `2048` | `10240` |
  | `medium` | `"medium"` | `"medium"` | `8192` | `16384` |
  | `high` | `"high"` | `"high"` | `16384` | `24576` |
  | `none` | *omitted* | *omitted* | thinking off (`0`) | *omitted* |

  CRITICAL DESIGN DECISION — Anthropic: integer thinking-budget, NOT the native
  `effort` enum. The Anthropic Messages API exposes two *different* reasoning
  controls (both visible in `@ai-sdk/anthropic`'s `anthropicLanguageModelOptions`):
  (1) `thinking.budgetTokens` — an integer budget (floor 1024, counts against
  `max_tokens`), supported across thinking-capable models 3.7 → 4.x; and (2) a
  newer `effort` enum (`low|medium|high|xhigh|max`, default `high`) available only
  on the newest models (Opus 4.5+). We deliberately map onto the **integer budget**
  because: it works on the broad set of thinking-capable models (the enum would
  fail on older ones); our `minimal` level has no native-enum equivalent (the enum
  starts at `low`, and adds `xhigh`/`max` we don't expose); and the integer makes
  the `max_tokens > budget` interplay explicit. Trade-off: the budget numbers are a
  moderate, hand-tuned judgment call (see `reasoningEffortToAnthropicBudget`), not
  Anthropic's own calibration. Revisit (switch to native `effort`, or hybrid:
  `effort` on new models + budget fallback on old) IF the deployment standardises
  on Opus 4.5+ OR we want Anthropic-calibrated levels rather than our budgets.

## Environment variables: explicit, no silent defaults

  PROJECT RULE: env config must be explicit. A var that selects model/provider
  *behaviour* is `required(...)` in `lib/env.ts` (throws at startup when unset) —
  never `process.env.X || "<default>"`. Rationale: a silent default (e.g. a model
  name) lets you think you configured one thing while the app quietly runs another;
  failing loudly at startup removes that whole class of confusion. Reasoning effort
  follows the same spirit with an explicit `"none"` value (= provider default)
  instead of relying on "unset".

  Required (throw if unset): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `NEXTAUTH_URL`, `AI_API_KEY`,
  `AI_PROVIDER`, `AI_MODEL`, `AI_REASONING_EFFORT`, `GRADER_AI_API_KEY`,
  `GRADER_AI_PROVIDER`, `GRADER_AI_MODEL`, `GRADER_AI_REASONING_EFFORT`,
  `SUMMARIZER_AI_API_KEY`, `SUMMARIZER_AI_PROVIDER`, `SUMMARIZER_AI_MODEL`,
  `SUMMARIZER_AI_REASONING_EFFORT`. (`NEXTAUTH_SECRET` is also required, enforced
  by next-auth itself, not `env.ts`.) The four `SUMMARIZER_AI_*` behaviour vars
  were made required by maintainer decision (2026-06) — same "no fallback between
  roles" stance as the grader; a summarizer *call* failing falls back to plain
  truncation at run time, but the *config* is still required.

  Allowed exceptions — genuinely optional, where "unset" is a true no-op (a feature
  off / not applicable), NOT a behaviour-picking default: `AI_BASE_URL` /
  `GRADER_AI_BASE_URL` / `SUMMARIZER_AI_BASE_URL` (only meaningful for
  `openai-compatible`; native providers have no endpoint), `DATABASE_SSL` (no TLS
  when unset), the `DEBUG_*` flags (off, and force-off in production), and the
  `AGENT_*` rate-limit knobs (operational safety caps with sane values).
  `NODE_ENV` is set by the platform, not us.

  When adding a new env var — MANDATORY: do NOT decide compulsory-vs-optional on
  your own. ASK THE MAINTAINER, per variable, whether it should be compulsory
  (`required(...)`) or optional, before wiring it up. Ask one explicit question for
  each new var (don't batch a "they're all required, right?" assumption) and record
  the decision here in the Required / Allowed-exceptions lists above. This applies
  to every newly introduced env var, no exceptions. The earlier guidance still
  frames the choice — prefer `required(...)`; "optional" is only for a genuine
  no-op when unset; and if a behaviour needs a default, use an explicit sentinel
  the operator must choose (as reasoning effort does with `"none"`) rather than a
  silent `|| "default"` — but the maintainer makes the call.

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
