<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Oversize files: summarize instead of truncate

> Part of the [project documentation](./README.md). Operating rules live in
> [`AGENTS.md`](../AGENTS.md).

The single per-file content cap is `MAX_FILE_CHARS` (32k chars ≈ 8k tokens),
applied in `lib/drive/content.ts` by `resolveFileContent` — the one place the cap
lives, shared by both read paths. A file under the cap returns as-is; an empty
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
