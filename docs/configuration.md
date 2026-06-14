<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Environment variables: explicit, no silent defaults

> Part of the [project documentation](./README.md). The operator-facing list of
> variables with example values is in the [`README`](../README.md#environment);
> this is the authoritative required-vs-optional inventory and the rationale.
> The short "ask before adding a var" rule lives in [`AGENTS.md`](../AGENTS.md).

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
