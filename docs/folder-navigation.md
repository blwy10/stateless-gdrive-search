<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Folder navigation — design & trade-offs

Status: **shipped (v1 = expand-only)**. This document records *why* the current
design is what it is, the alternatives we weighed, and the sharp edges/deferred
work — so the next iteration starts from the reasoning, not from scratch. The
operational summary is §2 ("What shipped") below; this document is the full
rationale. Part of the [project documentation](./README.md); operating rules
live in [`AGENTS.md`](../AGENTS.md).

The two topics most likely to change on revisit are flagged inline with
**[REVISIT]** and collected at the end.

---

## 1. Problem

- Google Drive folders show up in `search_drive` results, because a folder's
  *name* matches `name contains '<term>'` (see `buildDriveSearchQuery`). They
  arrive with `mimeType: "application/vnd.google-apps.folder"`.
- A folder has no extractable text, so the model's natural reflex —
  `open_file`/`review_file` on the folder — used to hit a dead end:
  `openDriveFile` returned `unsupportedGoogleAppsContent(...)` ("can't extract
  text from this type"). The model wasted a turn (and, in list mode, a grader
  call) on a non-answer.
- Goal: let the model *navigate into* a folder ("here are the files inside, open
  the ones you want") instead of treating a folder as an unreadable file.

The retrieval value of a folder is **navigation**, not content. Every design
choice below follows from that.

---

## 2. What shipped (v1)

- New `list_folder(connectionId, fileId, limit?)` tool in **all modes**; returns
  the folder's **direct children** in the same `{ files }` shape as
  `search_drive`.
- `open_file`/`review_file` detect a folder and return a "use `list_folder`"
  **redirect** instead of content/a verdict. The `review_file` redirect lands
  **before the grader runs**.
- Folders are **expand-only**: a folder is never kept/cited as a result; its
  relevant *children* become results via the normal per-file examiner grade.

Code: `lib/drive/folder.ts` (`listDriveFolder`, `buildFolderChildrenQuery`),
`lib/agent/handlers/list-folder.ts`, the redirect branches in
`lib/agent/handlers/{open,review}.ts`, tool registration in
`lib/agent/tools.ts`, prompt wording in `lib/agent/prompts.ts`, gating + logging
in `lib/agent/run.ts`.

---

## 3. Decisions & trade-offs

Each decision lists what we chose, what we rejected, the trade-off, and the
condition that should make us reconsider.

### 3.1 Dedicated `list_folder` tool vs. overloading `open_file`/`review_file`

- **Chosen:** a dedicated `list_folder` tool.
- **Rejected:** making `open_file`/`review_file` return a folder's children
  inline ("just works" with what the model already does).
- **Trade-off:**
  - *For the dedicated tool:* clean, single-purpose contracts (search finds,
    list navigates, open/review read a file); the `{ files }` return plugs into
    the existing touched-set / dedupe / diminishing-returns machinery for free;
    `review_file`'s verdict/entities contract stays coherent (a folder has no
    verdict); trivially unit-testable in isolation.
  - *Against:* a third tool to teach the model; the model may still reflexively
    `open_file` a folder (mitigated by the redirect, §3.4).
- **Why:** the codebase strongly favors one clear contract per tool and pushes
  all run-resilience into per-handler chokepoints. A polymorphic
  `open_file` return (content *or* a file list) would muddy both the schema and
  every caller.

### 3.2 Available in all modes (synthesis + curated + uncurated list)

- **Chosen:** offer `list_folder` everywhere.
- **Rejected:** synthesis-only, or list-only.
- **Trade-off:** uniform model behavior and no mode-specific tool gaps, vs. a
  slightly larger toolset in every mode. The marginal cost is low because
  listing is cheap discovery.
- **Why:** folders are a Drive-wide organizational reality; restricting
  navigation by mode would create confusing dead-ends in the excluded modes.

### 3.3 Direct children only (no recursion)

- **Chosen:** one level — `list_folder` returns immediate children; the model
  drills deeper by calling `list_folder` on a child subfolder.
- **Rejected:** recursive subtree listing (depth/count-capped).
- **Trade-off:**
  - *For one-level:* bounded, predictable cost and context size; the model only
    pays to expand the branches it judges promising (berry-picking).
  - *Against:* deep trees require several round-trips; a relevant file buried 4
    levels down needs 4 list calls (and the model may give up first under
    diminishing returns).
- **Why:** recursion can explode cost/context on a large tree, and the agent's
  existing title-based triage is a good filter for *which* branch to descend.
- **[REVISIT]** if traces show the model repeatedly failing to reach
  deeply-nested files, a shallow capped recursion (e.g. 2 levels, N-file cap)
  may be worth it.

### 3.4 Redirect `open_file`/`review_file` on a folder — and *where* the redirect lands

- **Chosen:** detect the folder mimeType **after** `openDriveFile` returns
  (authoritative — the handler only receives ids, not the mimeType), then return
  a structured `{ isFolder, message }` redirect. For `review_file` this is
  **before `gradeFile`**.
- **Rejected:** (a) leaving the old "unsupported" message; (b) detecting via the
  search result's mimeType in the touched set (not authoritative — the model can
  pass any id); (c) silently auto-listing the folder from inside `open_file`.
- **Trade-off:**
  - The "after open" check costs **one metadata GET** even though we end up
    redirecting (the folder case in `openDriveFile` returns early *before* any
    download/export, so it's only the metadata call). A touched-set fast-path
    could skip even that, at the cost of more branching. Judged not worth it.
  - Auto-listing from `open_file` would be the most "magic" UX but re-muddies the
    contract we deliberately kept clean in §3.1.
- **Why the grader ordering matters:** the examiner is the single place a folder
  could leak into a model call. Putting the redirect before `gradeFile`
  guarantees the grader **never** grades a folder (it would otherwise burn a call
  grading the redirect string, almost always → "irrelevant"). The summarizer is
  unreachable for folders independently (folder content is a tiny string, never
  exceeds `MAX_FILE_CHARS`, and only `open_file` wires the summarizer). This is a
  defense-at-the-chokepoint choice: no folder logic is scattered into the
  examiner/summarizer themselves.

### 3.5 Expand-only — a folder is never a curated result

- **Chosen:** a folder is recorded in the *touched* audit set but never collected
  into `opened`/`reviewed`/`kept` and never cited. Relevant *children* become
  results via the normal per-file grade.
- **Rejected:** grading the folder as its own leaf result; surfacing a folder as
  a result group.
- **Trade-off:**
  - *For expand-only:* the examiner stays the single relevance authority; recall
    is preserved (the model drills in and the real hits surface as files); zero
    new grading/aggregation code; no double-counting (folder + its files).
  - *Against:* a folder that is relevant *as a unit* ("my Taxes 2023 folder") is
    not surfaced as such; the model must actively expand it; the result list can
    be many individual files instead of one folder.
- **Why:** see §5 — this is the crux of the whole discussion. Grading a folder
  well is hard and the cheap version (sample + average) is actively wrong for the
  common query shape. Expand-only gets ~most of the value with none of that risk.
- **[REVISIT]** this is the primary thing to reconsider; see §5 and §6.

### 3.6 Result handling otherwise unchanged (folders can leak into *uncurated* results)

- **Chosen:** do not touch how files flow into results.
- **Consequence:** in **uncurated list mode** the result set *is* `touched`, and
  both (a) a folder surfaced directly by `search_drive` and (b) every child a
  `list_folder` call surfaces are added to `touched` — so folders and whole
  folder contents can appear in uncurated results. (Curated is unaffected: only
  examiner-kept files are results, and a folder is never kept. Synthesis is
  unaffected: only cited files are results.)
- **Trade-off:** keeping the change small and behavior-compatible, vs. a known
  cosmetic/precision wart in uncurated mode. This is consistent with uncurated's
  existing "every search hit is a result" philosophy, but `list_folder` makes it
  easy to dump a whole folder into the result list.
- **[REVISIT]** decide whether uncurated should (a) exclude folder-typed entries
  from results, and/or (b) treat `list_folder` children differently from
  `search_drive` hits.

### 3.7 `list_folder` stays active during the search backstop

- **Chosen:** when the search-call backstop trips (`stopSearchingReason`),
  `prepareStep` keeps `list_folder` available alongside the read tool; a full
  wind-down (`windDownReason`) drops everything.
- **Rejected:** dropping `list_folder` together with `search_drive`.
- **Trade-off:** lets the model finish exploring folders it already found (cheap
  discovery), vs. the search backstop's intent of "stop surfacing new
  candidates" — `list_folder` *can* surface new candidates, so this slightly
  softens that backstop. Judged acceptable because the backstop is loop-insurance
  (high `maxSearchCalls`), and token-based diminishing returns is the real stop.
- **[REVISIT]** if folder listing is observed to defeat the search backstop, gate
  it with search.

### 3.8 Child-list cap

- **Chosen:** single `files.list` page, `pageSize` default 100, max 200
  (`DEFAULT_FOLDER_PAGE_SIZE` / `MAX_FOLDER_PAGE_SIZE`), higher than search's 20
  because folders legitimately hold more than a page.
- **Trade-off:** a folder with more children than the cap is **silently
  truncated** — no pagination, no "there are more" note (we deferred the
  truncation note). Bigger caps help recall but bloat the main context (the child
  list enters the conversation like a search result).
- **[REVISIT]** add a truncation note and/or pagination for very large folders
  (ties into §5's huge-folder handling).

---

## 4. Cross-cutting trade-offs

- **Recall vs. precision.** `list_folder` only ever *widens* the candidate set;
  the examiner (curated) / citation step (synthesis) filter afterward. Uncurated
  has no such filter, hence §3.6.
- **Cost.** Listing is cheap (one Drive call, a small JSON list into context, no
  model call by itself). The expensive part is the model then reviewing children
  — governed by the existing diminishing-returns budget, not a new cap.
- **Contract cleanliness vs. "just works".** We paid one extra tool + one extra
  metadata GET on redirect to keep tool contracts single-purpose. See §3.1/§3.4.
- **Consistency with existing philosophy.** `handleListFolderTool` mirrors
  `handleSearchTool` exactly (touched-set recording, new-children-as-progress
  only in non-curated modes, diminishing-returns note). It deliberately does
  **not** import any "keep on failure favor recall" behavior — that's an
  examiner concept; a failed *navigation* simply surfaces nothing.

---

## 5. The crux (deferred): curated-mode folder relevance

This is the part we explicitly deferred and will revisit. Recorded in full
because the reasoning is the valuable artifact.

### 5.1 Two separate questions

These were being conflated; keep them apart:

1. **Should a folder ever be a *result*?** (a UI/data-model question)
2. **If so, how do we decide a folder is "relevant"?** (the grading question)

The grading mechanism must not silently drive the product decision.

### 5.2 Why "sample N children, grade, average" is the wrong default

The intuitive proposal — sample some children (e.g. across a size distribution),
grade each, average the scores, keep the folder above a threshold — fails on the
common case:

- **Averaging is the wrong aggregation.** Consider a "Personal" folder with 100
  files, 3 of which are exactly what the user wants (a passport scan, say).
  Average relevance ≈ 0.03 → folder discarded → **the one wanted file goes with
  it.** Mean-thresholding produces false negatives on the needle-in-haystack
  case (the most common one) and false positives on "many vaguely-related files,
  no real hit." Relevance over a set is closer to **any/max** ("is there ≥1
  relevant file?") or **count/density** ("how many?"), never mean.
- **Size is the wrong sampling axis.** File size barely tracks relevance;
  stratifying by it optimizes for byte-spread representativeness, which is
  irrelevant. If you must sample, sample by signals that track relevance: child
  **names** (free, from one list call), **recency**, or **uniform random** for an
  unbiased density estimate.
- **It fights the codebase's recall posture.** The examiner deliberately *keeps*
  a file when grading fails ("degrade to extra recall, not a missing result"). A
  sampled average does the opposite: it can drop a whole folder (and everything
  in it) on a noisy estimate.

### 5.3 The intent dependence (the real crux)

The right aggregation depends on what the query seeks:

- **"Find files about X"** (the dominant curated case) → you want *any* relevant
  file → the right move is **expand and keep the actual hits**. The folder as a
  unit is irrelevant; its files are the answer. Averaging actively hurts here.
- **"Find my X collection / folder"** → you want thematically-coherent folders →
  **density** (fraction of relevant children) is sensible, and a folder result is
  genuinely what they want.

The "average" idea is secretly assuming a *collection* query; for the dominant
*file* query it is harmful.

### 5.4 Strategy menu (cheapest → most expensive)

| Strategy | How a folder is judged | Cost | Best for |
|---|---|---|---|
| **A. Expand-only** *(shipped)* | Folder never a result; model lists it, examiner grades the **children**, hits are kept | normal per-file cost, existing budget | "find files" |
| **B. Metadata grade** | Examiner grades the folder from its **name + child names** (1 list call, 0 content reads) | 1 grader call / folder | quick folder triage |
| **C. Expand + grouping** | Keep relevant **children**; *also* surface the folder as a header when it's a **dense** cluster, collapsing children under it | A + a grouping pass + UI/data-model change | "collection" + clean UI |
| **D. Content sampling** | Sample children by **name/recency**, aggregate with **max or density** (never mean); reserve for *huge* folders metadata can't settle | K opens + K grades / folder | giant folders |

### 5.5 What we chose and the deferred direction

- **Shipped: A (expand-only).** Real per-file grades drive everything; folder
  relevance, if ever surfaced, should be **emergent** from child keeps (density),
  not a separately-estimated number.
- **Deferred for huge folders:** when a folder is too big to fully expand, judge
  it by **names only** (folder name + child names — one list call, no content
  reads) and think in **density/count**, **never the mean**; even then a folder
  stays navigation and is not kept as a unit unless we also adopt C (grouping).
  Not built: `list_folder` is direct-children-only and the model's existing
  title-based triage already picks which children to review.

---

## 6. Known limitations / sharp edges (the revisit checklist)

1. **Uncurated leak (§3.6):** folders and whole folder contents can appear in
   uncurated results.
2. **Silent truncation (§3.8):** folders larger than the page cap are cut with no
   "there's more" signal; no pagination.
3. **Folder-as-unit not surfaced (§3.5):** a relevant folder is only reflected
   via its individual files; no grouping in the result model (results are a flat
   `DriveFile[]` with no parent/child notion).
4. **Model must actively expand:** if the model doesn't choose to `list_folder` a
   relevant folder, its contents are never considered. Mitigated by prompt
   wording, but it's a behavioral dependency, not a guarantee.
5. **Touched inflation:** every listed child is recorded as touched (the audit
   set), even children the model never reviews — more noise in the "files
   touched" disclosure, and (in uncurated) in results.
6. **Empty vs. not-a-folder is conflated:** `list_folder` does one call; an empty
   result could be an empty folder *or* a non-folder id. The note covers both but
   can't distinguish them.
7. **Wasted metadata GET on redirect (§3.4):** opening a folder costs a metadata
   call before we redirect. Minor.
8. **Shortcuts not handled:** `application/vnd.google-apps.shortcut` targets
   (incl. shortcuts *to* folders) are treated as ordinary files; a shortcut to a
   folder won't navigate.
9. **Deep trees are manual (§3.3):** no recursion; deeply-nested relevant files
   may be missed under diminishing returns.

---

## 7. Open questions for the revisit

- Should folders be **excluded from `search_drive`** results entirely (navigate
  only via explicit `list_folder` from a known id), to cut name-match noise? Or
  kept for discoverability (current)?
- Should uncurated mode **exclude folder-typed entries** from results, and/or
  treat `list_folder` children differently from `search_drive` hits (§3.6)?
- Do we want **Strategy C** (folder-as-result via emergent density + UI grouping)?
  That requires a parent/child result model and UI work — scope it before
  committing.
- Huge folders: **names-only grade + density** (Strategy D-lite), **pagination**,
  or just a **truncation note** (§3.8)? Cheapest useful first step is probably
  the truncation note + name-based ordering of children.
- Should `list_folder` children that are **never reviewed** count toward
  `touched`/noise (§6.5)?

---

## 8. Interactions to keep in mind

- **Diminishing-returns budget:** `list_folder` resets the progress clock only in
  non-curated modes (children-as-results), exactly like search. Don't change one
  without the other.
- **Entity-conflation / subject anchoring:** folder navigation surfaces *more*
  files, but per-file grading and the subject-anchoring guards apply unchanged —
  the grader never sees a folder (§3.4), so the guard surface is unaffected.
- **Citations / SOURCES:** folders are never cited; `resolveSources` resolves
  cited ids against `touched`, and a folder in `touched` simply never appears in a
  SOURCES block (the model is told to cite files it relied on).
- **Run resilience:** like the other handlers, `handleListFolderTool` never
  throws — scope violations, listing failures, and bad args all become recoverable
  observations so a single bad folder can't abort the run.
