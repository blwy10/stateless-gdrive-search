<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Module layout

> Part of the [project documentation](./README.md). Operating rules and the
> short code map live in [`AGENTS.md`](../AGENTS.md); this is the full breakdown.

Several formerly-monolithic files were split into focused modules behind a
barrel; the public import paths are unchanged, so `@/lib/agent`, `@/lib/drive`,
and `@/lib/model-settings` resolve to each directory's `index.ts`. The directory
layout below is authoritative — when this doc names a symbol, it also names the
file it now lives in.

- `lib/agent/` (was `lib/agent.ts`): `types` (request/budget/progress/tool
  schemas), `prompts` (`systemPrompt`/`describeSubjectIdentity`/`basePrompt`/
  `synthesisSystemPrompt`), `tokens`, `logging`, `files`
  (`uniqueFiles`/`fileKey`/`formatFileProgressLabel`), `examiner` (grading,
  `gradeFileRelevance`/`normalizeGradeVerdict`/`gradeSystemPrompt`), `summarizer`
  (`summarizeOversizeContent`/`SUMMARIZE_SYSTEM_PROMPT`), `answer` (final-answer +
  SOURCES parsing — `parseFinalAnswer`/`parseSources`/`resolveSources` —
  + `buildAgentResult`), `budget` (limits + diminishing-returns notes —
  `searchResultNote`/`diminishingReturnsNote`/`evaluateTokenBudget`), `state`
  (`FileSet`, `AgentRunContext`, `AgentRunState`, `createRunState`,
  `recordTouched`), `tool-runtime` (safeJson/retries/`parseToolArgs`/
  `isRetryableToolError`), `tools` (`buildAgentTools`),
  `handlers/{search,open,review,list-folder}` (the tested tool handlers), and `run`
  (`runDriveAgent`, decomposed into `resolveRunModels`/`selectDriveIds`/
  `buildRunContext`/`runMainModelLoop`/`forceSynthesis`/`finalizeRun`).
- `lib/drive/` (was `lib/drive.ts`): `types`, `query`
  (`buildDriveSearchQuery`/`escapeDriveQuery`), `client` (token refresh +
  `googleFetch` + metadata/download/export + `parseDriveApiError`, which enriches
  a failed request's thrown error/log with Google's `reason`/`message` — see
  [drive-errors.md](./drive-errors.md)), `extract` (pdf/pptx/xlsx/docx text),
  `content` (`resolveFileContent`/`emptyExtractionNote`/`folderRedirectContent` +
  the `MAX_FILE_CHARS` cap), `search` (`searchDriveFiles`), `folder`
  (`buildFolderChildrenQuery`/`listDriveFolder` — direct-children listing for
  folder navigation, see [folder-navigation.md](./folder-navigation.md)), `open`
  (`openDriveFile`).
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
