<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# File display: results vs touched

> Part of the [project documentation](./README.md). Operating rules live in
> [`AGENTS.md`](../AGENTS.md).

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
  - **curated list** → `keptFiles` (examiner-kept; see
    [llm-and-agent-loop.md](./llm-and-agent-loop.md)), **re-ordered by relevance**
    (see "Curated reranking" below).
  - **uncurated list** → every touched file (all matches; here result == touched,
    so the UI auto-hides the redundant disclosure).

## Curated reranking

Curated list mode does one extra, terminal model call to *order* the kept set by
relevance — kept files were chosen by a per-file boolean examiner, which says
nothing about which matches are strongest. After the main loop finishes (success
path only), `rerankCuratedKept` (in `lib/agent/run.ts`) runs the **ranker** role
(`rankKeptFiles` in `lib/agent/ranker.ts`) when curating and more than one file
was kept; other modes and the error/partial path keep the order they gathered.

- **Input is verdict-only, never content.** The ranker sees, per kept file, its
  title + type + the examiner's one-line `reason` + `entities` + `aboutSubject` —
  the verdicts retained on `state.keptVerdicts` (the examiner already computed
  them; they were otherwise only logged and returned to the model). The `reason`
  is query-conditioned, so it's a better and far cheaper ranking signal than the
  file's text.
- **Order-only, never membership.** The model returns 1-based document numbers in
  best→worst order; `applyRanking` turns that into a guaranteed *permutation* of
  the kept set — it dedupes, drops out-of-range/non-integer positions, and appends
  any omitted files in their original order. So a garbage or empty order (the
  ranker-failed fallback) degrades to the existing keep-order and never drops a
  file. The "empty kept = nothing relevant" invariant is preserved.
- **`aboutSubject` demotion.** When a subject identity is known *and* the query is
  about that person, the ranker prefers files about the subject over files about
  another person as a tie-breaker (the long-standing entity-conflation follow-up,
  see [entity-conflation.md](./entity-conflation.md)) — soft, never a filter.
- **Streaming vs. final order.** Curated streams `kept` events live in keep-order;
  the terminal `final` event carries the reranked order, and the UI rebuilds from
  `final.files` (authoritative), so results visibly settle into ranked order on
  completion — the same "resolves only at `final`" shape synthesis sources use.
- The ranker is its own model role (independently configurable, no fallback). Its
  token usage is folded into the run total; it logs under `agent.rank.*`.

`buildResult` (in `runDriveAgent`) assembles both lists for the `final` event in
both the success and error/partial branches. Live streaming: `file` events feed
the touched list in all modes; the hook also mirrors them into the primary list
*only* in uncurated mode (where they are results), while curated keeps stream via
`kept` and synthesis sources resolve only at `final`. Opening a file in synthesis
is therefore no longer what makes it a result — the model's citation is.
