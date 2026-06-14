<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Agent Instructions

Operating rules for agents and contributors working in this repo. The design
rationale and architecture deep-dives live in [`docs/`](docs/README.md) — see
[Design & architecture docs](#design--architecture-docs) below. Operator/setup
docs (environment, deployment, OAuth, debug logs) live in the [`README`](README.md).

## Working in this repo

- Do not run browser-based tests or browser automation for this project.
- Prefer non-browser verification: `npm run typecheck`, `npm run lint`, and
  `npm test` (Vitest; `npm run test:watch` to iterate). Run whichever are
  relevant to your change.
- Env config is **explicit — no silent defaults**. Before adding a new env var,
  ASK THE MAINTAINER, per variable, whether it should be required or optional,
  then record the decision in [`docs/configuration.md`](docs/configuration.md).
  Never use `process.env.X || "default"` for a behaviour-selecting var. (Full
  policy + the required/optional inventory: [`docs/configuration.md`](docs/configuration.md).)

## Tests

Unit tests live in `test/` and run with Vitest. They deliberately cover only
pure, security-sensitive helpers — **no network, DB, or browser** — so they are
fast and safe to run anytime. The suites are named by area; read the relevant one
rather than relying on a catalogue here:

- `test/agent.test.ts` — agent output parsing (`parseFinalAnswer`,
  `parseSources`/`resolveSources`), the tool handlers
  (`search`/`open`/`review`/`list-folder` — incl. run-resilience, scope guards,
  retries, folder redirects), the examiner verdict normaliser, budget/search
  notes, prompts (`systemPrompt`/`describeSubjectIdentity`), and oversize
  summarisation.
- `test/drive.test.ts` — Drive query building/escaping, the folder child-query,
  the content-cap resolver, and the Drive API error parser (`parseDriveApiError`).
- `test/model-settings.test.ts` — per-role model resolution (`resolveRoleSettings`)
  and reasoning-effort coercion (`coerceReasoningEffort`).
- `test/model-provider.test.ts` — per-provider wiring of model + reasoning effort
  (`resolveModel`).
- `test/crypto.test.ts`, `test/ssrf.test.ts`, `test/file-types.test.ts`,
  `test/debug-log.test.ts` — token encryption, the SSRF URL guard, MIME
  formatting, and debug-log gating (forced off in production).

The tool handlers are tested directly: the AI SDK tools in `buildAgentTools` are
thin adapters over the OpenAI-style `ToolCall` handlers, so exercising the
handlers exercises the real run-resilience behaviour. **When you touch one of
these helpers or handlers, update or add its test.**

## Code map

Public import paths are stable — `@/lib/agent`, `@/lib/drive`, and
`@/lib/model-settings` are directory barrels (`index.ts`). Quick map; the full
per-file breakdown is in [`docs/architecture.md`](docs/architecture.md):

- `lib/agent/` — the agent loop, tools + handlers, prompts, examiner, summarizer,
  budget, and run-state (`FileSet`/`AgentRunState`).
- `lib/drive/` — Drive client, search/query, text extraction, folder navigation,
  and the per-file content cap.
- `lib/model-settings/` — per-role model config + the DB repository.
- `lib/model-provider.ts` — `resolveModel` (provider wiring + reasoning effort).
- `lib/env.ts`, `lib/crypto.ts`, `lib/ssrf.ts`, `lib/rate-limit.ts`,
  `lib/debug-log.ts` — config, encryption, the SSRF guard, rate limiting, debug logs.
- `app/`, `components/`, `hooks/`, `db/`, `test/`, `utils/` — Next.js routes, UI,
  client hooks, DB schema, tests, and helper scripts.

## Design & architecture docs

Deep-dives live in [`docs/`](docs/README.md). Each records *why* the design is
what it is, not just what it does:

| Topic | Doc |
| --- | --- |
| Module layout, `FileSet`/`AgentRunState` | [`docs/architecture.md`](docs/architecture.md) |
| AI SDK loop, examiner & list modes, 3 model roles, reasoning effort | [`docs/llm-and-agent-loop.md`](docs/llm-and-agent-loop.md) |
| Search recall, berry-picking, diminishing-returns budget | [`docs/retrieval-and-budget.md`](docs/retrieval-and-budget.md) |
| Results vs "touched" lists, `SOURCES` citations | [`docs/results-and-citations.md`](docs/results-and-citations.md) |
| Folder navigation (`list_folder`, expand-only) | [`docs/folder-navigation.md`](docs/folder-navigation.md) |
| Subject anchoring / entity conflation, prompt-injection guard | [`docs/entity-conflation.md`](docs/entity-conflation.md) |
| Oversize-file summarisation | [`docs/oversize-files.md`](docs/oversize-files.md) |
| Surfacing Google Drive error reasons | [`docs/drive-errors.md`](docs/drive-errors.md) |
| Environment-variable policy & inventory | [`docs/configuration.md`](docs/configuration.md) |
| Railway MCP gotcha | [`docs/railway-mcp.md`](docs/railway-mcp.md) |
