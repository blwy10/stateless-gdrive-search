<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Retrieval & budget

> Part of the [project documentation](./README.md). Operating rules live in
> [`AGENTS.md`](../AGENTS.md).

## Drive search recall, berry-picking & diminishing returns

Recall (`buildDriveSearchQuery` in `lib/drive/query.ts`): Drive's `contains`
operator matches the *whole* string, so a naive `name contains 'a b' or fullText
contains 'a b'` requires every term together and silently drops files that
contain only some of them — e.g. the query "Airwallex feedback" misses a doc
named "Airwallex Reflection" that never says "feedback". `buildDriveSearchQuery`
therefore splits a multi-word query into terms (deduped case-insensitively,
capped at `MAX_SEARCH_TERMS = 12`) and OR-s a `name`/`fullText` `contains` pair
per term, so a partial match still surfaces. This only ever *widens* the
candidate set (it is a strict superset of the old whole-string match); the agent
and the examiner filter for true relevance afterwards. Single-word queries are
unchanged. `orderBy` is intentionally left unset: Drive v3 has no `relevance`
sort key, and omitting `orderBy` is the only way to get relevance ordering, which
keeps the best matches near the top of the (20-capped) page. `escapeDriveQuery`
is now only called from inside `buildDriveSearchQuery` (per-term), so
`searchDriveFiles` passes the raw, trimmed query down rather than pre-escaping it.

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

Search notes (`searchResultNote` in `lib/agent/budget.ts`): a `search_drive`
observation carries a corrective `note` only in two cheap-to-flag cases — an
*exact repeat* (pure token waste, zero new information → "do not repeat it, vary
the terms") and a query that matched *nothing* (`totalResultCount === 0` → "try
different terms"). A query that merely *overlaps* already-seen files is
deliberately NOT flagged: searches are cheap (only a small result list enters
context) and an overlapping query is often the model triangulating toward a new
angle. Whether returns are diminishing is judged holistically over tokens (next
section), not by any single search's novelty.

Diminishing returns (the budget — see the [Budget](#budget-diminishing-returns-not-caps)
section below): the normal stop is "we are
no longer producing new useful results per token spent". `state.tokensSpent`
accumulates every model call (main loop + examiner); `recordUsefulProgress`
snapshots it whenever the result set grows (a kept file in curated; a
newly-surfaced/read file otherwise); `tokensSinceProgress` is the gap.
`diminishingReturnsNote` attaches a soft "returns are diminishing — wrap up
unless you have a new angle" note once that gap passes `softProgressTokenLimit`
(it explicitly preserves the berry-picking escape hatch), and
`evaluateTokenBudget` (in `prepareStep`) hard-winds-down past
`hardProgressTokenLimit`. The note fires on `search_drive`, `review_file`, and
`list_folder` results — attached via `noteDiminishingReturns`, which also counts
it (`state.softNudgeCount`, summarised in `agent.completed`) and emits an
`agent.budget.soft_nudge` debug event. `evaluateTokenBudget` returns a
`BudgetTrip` the step a hard guard first fires so `prepareStep` logs a one-shot
`agent.budget.wind_down` (naming which of the three guards won); both make the
soft→hard progression visible for tuning.

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
