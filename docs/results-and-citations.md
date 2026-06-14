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
    [llm-and-agent-loop.md](./llm-and-agent-loop.md)).
  - **uncurated list** → every touched file (all matches; here result == touched,
    so the UI auto-hides the redundant disclosure).

`buildResult` (in `runDriveAgent`) assembles both lists for the `final` event in
both the success and error/partial branches. Live streaming: `file` events feed
the touched list in all modes; the hook also mirrors them into the primary list
*only* in uncurated mode (where they are results), while curated keeps stream via
`kept` and synthesis sources resolve only at `final`. Opening a file in synthesis
is therefore no longer what makes it a result — the model's citation is.
