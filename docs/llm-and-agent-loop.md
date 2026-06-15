<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# The model layer & agent loop

> Part of the [project documentation](./README.md). Operating rules live in
> [`AGENTS.md`](../AGENTS.md).

## The agent loop (Vercel AI SDK)

The agent runs on the Vercel AI SDK (`ai` v6). `lib/model-provider.ts`
(`resolveModel`) maps `EffectiveModelSettings` to a concrete `LanguageModel`,
per-provider `providerOptions`, a temperature, and a `maxOutputTokens` (see the
Anthropic note). The role's `reasoningEffort` (when set; `null` omits it) is
threaded into each provider's native shape — see [Reasoning effort](#reasoning-effort) below:
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
[oversize-files.md](./oversize-files.md)), refuses redirects, and — for
user-supplied ("custom") endpoints — pins the connection to public IPs via
`ssrfSafeDispatcher`. The operator default endpoint is trusted and skips the
dispatcher.

`runDriveAgent` (via `runMainModelLoop`) calls `streamText` with the tool set from
`buildAgentTools`, `stopWhen: stepCountIs(budget.maxToolSteps)` (a loop-insurance
*backstop*, not the normal stop — see [retrieval-and-budget.md](./retrieval-and-budget.md)),
a `prepareStep`, an `onChunk`, an `onError`, and an `onStepFinish`. `streamText`
(rather than `generateText`) is what lets the main model's reasoning stream to the
client live — see [Streaming reasoning](#streaming-reasoning-thinking) below; awaiting
the result promises (`text`/`finishReason`/`steps`/`response`) consumes the stream
end-to-end, driving tool execution and the callbacks.
`prepareStep` records the current step, calls `evaluateTokenBudget`, then gates
tools: a `windDownReason` (diminishing-returns hard limit, cost seatbelt, or
context-window limit) drops *every* tool so the model must finish; a
`stopSearchingReason` (the search-call backstop) drops only `search_drive` and
keeps the read tool (`review_file` in list modes, `open_file` in synthesis) so
the model can finish with what it found. `onStepFinish` folds the step's tokens
into `state.tokensSpent`, tracks `state.lastInputTokens`, emits the step's reasoning
as a fallback when the provider didn't stream it (see
[Streaming reasoning](#streaming-reasoning-thinking)), then logs. The SDK
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
non-strict ones). As a final backstop, the whole `streamText` consumption is wrapped
in try/catch: because `AgentRunState` is mutated in place, a throw (model error after
retries, a hallucinated/unrepairable tool call, a timeout) still finalizes with
whatever was gathered instead of discarding the run. A stream-stopping error is
captured via `streamText`'s `onError` and rethrown once the stream is consumed, so it
routes through that same catch. The call is given
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

### Streaming reasoning ("thinking")

The main loop uses `streamText` so the model's reasoning can be surfaced to the user
live, the way agentic UIs show their "thinking". It rides the same SSE stream as the
other progress events (a new `{ type: "reasoning", delta }` `AgentProgress` variant)
and renders in a collapsible **Thinking** panel, separate from the answer and the
progress/files lists.

Two complementary paths cover the range of providers, because not all stream
reasoning incrementally:
- **(A) deltas** — `onChunk` forwards each `reasoning-delta` chunk the instant the
  model produces it.
- **(B) per-step fallback** — if a step produced reasoning but *no* deltas arrived
  for it (some `openai-compatible` endpoints report `reasoning_content` only at the
  end of a step), `onStepFinish` emits that step's full `reasoningText` once. A
  per-step flag (`streamedReasoningThisStep`) ensures (A) and (B) never double-emit;
  a `boundaryPending` flag inserts a blank line between consecutive steps' blocks.

What actually appears depends on the model + reasoning effort, and the feature
degrades gracefully (no panel) when there is nothing: OpenAI streams reasoning
*summaries*, and only for reasoning models; Anthropic streams real thinking but only
when a reasoning effort is set (thinking is OFF at `none` — see
[Reasoning effort](#reasoning-effort)); Fireworks streams raw `reasoning_content` for
reasoning models.

Scope and safety: only the **main** loop streams (the grader/summarizer/ranker are
isolated `generateObject`/`generateText` calls, deliberately silent). Streaming is
**display-only** — reasoning never re-enters the model context and has no result
semantics; token accounting is unchanged (the same `reasoningText` was always counted
in `onStepFinish`). Because reasoning is untrusted model output derived from file
content, the UI renders it as **plain text**, never markdown/HTML, so it cannot
reintroduce the image-exfiltration channel the answer sanitizer closes (see
[security.md](./security.md)). It is transient: accumulated on the client session in
memory but stripped before localStorage persistence, and that write is debounced so
high-frequency deltas don't hammer storage.

### Examiner & list modes

Both list modes (curated and uncurated) read files via
`review_file` so content never enters the main loop; only synthesis uses
`open_file` (which reads content directly into context for synthesis). The tool
split in `buildAgentTools` is therefore by `input.mode === "list"`, not by
curation. `review_file` (`handleReviewFileTool`) opens a candidate and examines
it in an isolated, single-shot structured call (`gradeFileRelevance` →
`generateObject` → `normalizeGradeVerdict`) whose minimal prompt holds the
query, the run's subject identity when resolved (`gradeSystemPrompt(subject)`),
and that one file. The file's content is NOT returned into the main loop —
only a compact verdict `{examined, relevant, reason, entities}` (the `entities`
are the berry-picking channel; see [retrieval-and-budget.md](./retrieval-and-budget.md)).
The verdict also carries `aboutSubject` (auditable/logged, not in the tool payload
— see [entity-conflation.md](./entity-conflation.md)). Curated mode keeps
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
audit disclosure — see [results-and-citations.md](./results-and-citations.md).)

## Multi-provider settings

`lib/model-settings/` carries a `provider`
(`openai` | `anthropic` | `openai-compatible`) alongside the now-optional
`baseUrl`. The operator default comes from `AI_PROVIDER`/`AI_BASE_URL`/`AI_MODEL`;
per-user overrides live in `user_model_settings` (the `provider` column and
nullable `base_url` are added idempotently by `db/schema.sql`). `baseUrl` is only
required — and only SSRF-validated — for `openai-compatible`.

## Four model roles (main vs grader vs summarizer vs ranker)

The agent resolves four
independent models per run. The **main** model drives the loop + synthesis
(`streamText` for the loop and `generateText` for `forceSynthesis`); the **grader**
is a separate, cheaper model
used only by the examiner (`gradeFileRelevance`'s `generateObject`); the
**summarizer** condenses an oversize file into the synthesis budget
(`summarizeOversizeContent`'s `generateText`) — see
[oversize-files.md](./oversize-files.md); the **ranker** re-orders a curated
list's kept files by relevance in one terminal call (`rankKeptFiles`'s
`generateObject`) — see [results-and-citations.md](./results-and-citations.md).
`getEffectiveModelSettings` returns an `{ main, grader, summarizer, ranker }`
bundle; `runDriveAgent` resolves each with `resolveModel`, injects the grader via
the `gradeFile` closure and the summarizer via the `summarizeOversize` closure,
and calls the ranker directly at finalization (`rerankCuratedKept`, success path
only). Each non-main call folds its own token usage into `state.tokensSpent`;
`agent.grade.*` / `agent.summarize.*` / `agent.rank.*` log events carry that
role's model/provider. Each role is configured independently: env defaults `AI_*`
(main), `GRADER_AI_*` (grader), `SUMMARIZER_AI_*` (summarizer), and `RANKER_AI_*`
(ranker) — each key + model required — are ALL required; there is no fallback
between roles. Per-user overrides are independent per role (override any subset;
each unset role falls back to its OWN env default, never another role's). The pure
`resolveRoleSettings(columns, envDefault)` picks custom-vs-env for a single role
(a role is overridden only when its `model` AND api key are both stored) and is
unit-tested in `test/model-settings.test.ts`. In `user_model_settings` a role is
"present" iff its `model` + `api_key_ciphertext` are non-null, so the main config
columns are nullable and parallel `grader_*` / `summarizer_*` / `ranker_*` columns
hold those overrides; the role-scoped DELETE clears one role and drops the row
once no role is set.

## Reasoning effort

Each role (main + grader + summarizer + ranker) carries a `reasoningEffort`
(`none|minimal|low|medium|high`; `"none"` is the EXPLICIT provider default — the
option is omitted — never an implicit "unset") on `EffectiveModelSettings`,
always set (never null), applied per-provider by `resolveModel` (see
[the agent loop](#the-agent-loop-vercel-ai-sdk) above). The env vars
`AI_REASONING_EFFORT` / `GRADER_AI_REASONING_EFFORT` /
`SUMMARIZER_AI_REASONING_EFFORT` / `RANKER_AI_REASONING_EFFORT` are REQUIRED and
strictly validated — `requireReasoningEffortEnv` throws at startup on an
unrecognized value (env config is explicit; see [configuration.md](./configuration.md)).
Stored per-user overrides instead use the lenient `coerceReasoningEffort` (a
legacy/stray DB value degrades to `"none"`, since it comes from our own
enum-constrained UI). Per-user overrides live in the nullable `reasoning_effort`
/ `grader_reasoning_effort` / `summarizer_reasoning_effort` / `ranker_reasoning_effort`
columns (plaintext — not a secret) and flow through the same settings API/UI as
the other model fields.
Design rule: effort is an *attribute* of a role's override, not an override on
its own — a role only counts as "custom" when its `model` + api key are both
stored (`resolveRoleSettings`), so effort rides along with a custom model;
a role left on its env default takes effort from its env var. Lowering the
grader's effort is the cheapest cost lever for the high-volume examiner. The
resolved effort is in the `agent.started` log (a coarse enum, not PII, so logged
plainly) for all four roles. It applies to every model call — the main loop,
`forceSynthesis`, the examiner's `generateObject`, the summarizer's
`generateText`, and the ranker's `generateObject` (the grader is the dominant
token cost in list modes, so its effort matters most; the summarizer runs only on
oversize synthesis reads, and the ranker once per curated run).

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
