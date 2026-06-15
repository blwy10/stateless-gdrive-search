<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Entity conflation: subject anchoring

> Part of the [project documentation](./README.md). Operating rules live in
> [`AGENTS.md`](../AGENTS.md).

A self-referential query ("synthesize my career") never names *who* the subject
is, so the agent used to infer identity from filenames and could bleed a second
person's identity into the answer. The classic trap: a recommendation letter the
owner *wrote for a friend* — its filename carries the owner's name (the author),
its body is about the friend — which is genuinely career-relevant, so neither the
retriever nor the relevance examiner filters it out, and synthesis then merged
the friend's name in as an alias (the real "Yen" incident). Relevance ≠
aboutness, so a relevance filter alone cannot catch this.

Guard (prompt-level): `describeSubjectIdentity(connections, selectedDriveIds)`
(in `lib/agent/prompts.ts`) builds a `Name <email>` identity from the *selected*
connections' `driveName`/`driveEmail` and `runDriveAgent` threads it into every
prompt via `systemPrompt` → `basePrompt`/`synthesisSystemPrompt`. Crucially the
system prompt is query-INDEPENDENT (it depends only on `mode`/`curateList`; the
query is a separate user message), so the wording must stay neutral or it
over-corrects *topical* queries that aren't about a person at all. So `basePrompt`
states the owner identity as a *fact* and binds only first-person words
("my"/"me"/"I") to it (inert when none appear), plus the universally-true caution
that a file may be authored-by / addressed-to / merely-mention a person without
being *about* them (a title name is often the author/recipient, not the topic).
`synthesisSystemPrompt` adds a universal correctness rule (attribute each fact to
the correct person; never merge two people or alias one to another unless a source
says they're the same) and GATES the build-a-profile-of-the-owner behavior on
"when the request is specifically about a person" — so "summarize the finance
deck" is NOT forced to be about the owner. The first draft ("the subject of the
request is the owner" + "attribute facts only to the subject") was exactly that
over-correction and was removed; `test/agent.test.ts` locks this in (asserts the
prompt does NOT contain "Attribute facts only to the subject" and DOES gate on a
person-specific request). When no identity resolves the whole block is omitted.
The resolved identity is content/PII, so `agent.connections.selected` logs it only
through `debugText` (gated, production-off).

The examiner is now subject-aware too (the first step of the structural fix): when
a subject identity is present, `gradeSystemPrompt(subject)` (in `lib/agent/examiner.ts`)
threads the owner anchor + aboutness caution into the grader and asks it to classify
`aboutSubject` (`subject` | `other_person` | `not_person` | `unknown`, see
`ABOUT_SUBJECT_VALUES`); `runDriveAgent`'s `gradeFile` closure passes the run's
`subjectIdentity` to `gradeFileRelevance`. The verdict is auditable (logged on
`agent.grade.completed` and `agent.tool.review_file.completed`, coarse enum, not
PII) but does NOT gate keep/discard — relevance still decides curation,
preserving recall (a file about another person can still be relevant). For multiple
connections the prompts also no longer merge distinct owners or bind first-person
to all of them (see `systemPrompt` in `lib/agent/prompts.ts`).

The curated **reranker** is the first place `aboutSubject` is *acted* on (the
follow-up above): when a subject identity is known and the query is about that
person, `rankKeptFiles` (in `lib/agent/ranker.ts`) ranks files about the subject
above files about another person as a tie-breaker between comparably-relevant
files — see [results-and-citations.md](./results-and-citations.md). This is a soft
demotion in the result *order*, deliberately NOT a filter: a recommendation letter
the owner wrote for a colleague stays in the list (recall preserved) but sinks
below files genuinely about the owner. Remaining follow-up: acting on
`aboutSubject` in synthesis. Still prompt+heuristic level — it reduces but does not
*guarantee* prevention.

Prompt-injection note (related): every content-ingesting prompt — `basePrompt`
(main agent), `gradeSystemPrompt` (examiner), and `SUMMARIZE_SYSTEM_PROMPT`
(summarizer) — tells the model to treat file contents as untrusted data, not
instructions, and each path also fences the raw content with a per-call random
nonce (`wrapUntrustedContent`). This is defence-in-depth, not a guarantee — the
full threat model (including the browser-side exfiltration channels closed by the
CSP and the hardened markdown sanitizer) lives in [`security.md`](./security.md).
