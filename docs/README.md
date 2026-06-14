<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Documentation

Start here to find the deep-dive docs for this project. Each file covers one
topic — *why* the design is what it is, not just what it does.

- **Operating rules** (for agents/contributors working in this repo) live in
  [`AGENTS.md`](../AGENTS.md).
- **Setup, environment, deployment, OAuth** (operator-facing) live in the
  [`README`](../README.md).
- **Design & architecture deep-dives** are the files below.

## Architecture & the agent loop

- [architecture.md](./architecture.md) — module layout (the `lib/agent`,
  `lib/drive`, `lib/model-settings` split) and the `FileSet` / `AgentRunState`
  model.
- [llm-and-agent-loop.md](./llm-and-agent-loop.md) — the Vercel AI SDK loop,
  run-resilience invariants, the examiner & list modes, the three model roles
  (main / grader / summarizer), and reasoning effort.

## Retrieval & results

- [retrieval-and-budget.md](./retrieval-and-budget.md) — Drive search recall,
  berry-picking via the examiner, and the diminishing-returns token budget.
- [results-and-citations.md](./results-and-citations.md) — the primary result
  list vs the "files touched" audit list, and synthesis `SOURCES:` citations.
- [folder-navigation.md](./folder-navigation.md) — the `list_folder` tool,
  expand-only folders, and the deferred curated-folder-relevance design.

## Safety & correctness

- [entity-conflation.md](./entity-conflation.md) — subject anchoring: stopping a
  second person's identity from bleeding into a self-referential answer, plus the
  prompt-injection guard.
- [oversize-files.md](./oversize-files.md) — condensing a too-large file with the
  summarizer model instead of hard-truncating it.
- [drive-errors.md](./drive-errors.md) — surfacing Google's machine error
  `reason` (e.g. `cannotExportFile`) so the model stops retrying inaccessible
  files.

## Operations & configuration

- [configuration.md](./configuration.md) — the "explicit, no silent defaults"
  environment-variable policy and the authoritative required-vs-optional list.
- [railway-mcp.md](./railway-mcp.md) — the Railway MCP "pin the project first"
  gotcha.
