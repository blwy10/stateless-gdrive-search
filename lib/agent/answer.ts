// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import type { DriveFile } from "@/lib/drive";
import { isCuratingRequest, type AgentRequest } from "./types";
import type { AgentRunState } from "./state";
import { fileKey, uniqueFiles } from "./files";

export function partialAnswer(reason: string, mode: AgentRequest["mode"]) {
  if (mode === "list") {
    return { answer: "", answerFormat: "plain" as const };
  }

  return {
    answerFormat: "plain" as const,
    answer: `${reason} Returning the files found so far.`
  };
}

/**
 * Synthesis answers are instructed to begin with a `FORMAT: markdown|plain`
 * directive line, but the model sometimes prepends a short lead-in sentence
 * (and/or a `---` rule) before it. A start-anchored (`^FORMAT:`) match missed
 * that and leaked the literal directive into the rendered answer. We therefore
 * accept the directive at the start of any line, but only when it sits within
 * this many leading characters, so a brief preamble is tolerated while an
 * incidental `FORMAT:` line deep inside a genuine answer can't truncate it.
 */
const MAX_FORMAT_PREAMBLE_CHARS = 500;

export function parseFinalAnswer(content: string | null, mode: AgentRequest["mode"]) {
  if (mode === "list") {
    return { answer: "", answerFormat: "plain" as const };
  }

  const raw = content?.trim() || "No answer returned.";
  // Match a standalone FORMAT directive line wherever it appears near the top —
  // not only at the very start — and drop everything before it, mirroring how
  // parseSources tolerates leading content. Requiring a newline/end after the
  // format word keeps prose like "the FORMAT: markdown option" from matching.
  const match = raw.match(/(?:^|\n)[ \t]*FORMAT:[ \t]*(markdown|plain)[ \t]*(?:\n([\s\S]*))?$/i);
  if (match && raw.slice(0, match.index ?? 0).trim().length <= MAX_FORMAT_PREAMBLE_CHARS) {
    return {
      answerFormat: match[1].toLowerCase() === "markdown" ? ("markdown" as const) : ("plain" as const),
      answer: (match[2] ?? "").trim()
    };
  }

  const likelyMarkdown = /(^|\n)\s*(#{1,6}\s+|[-*]\s+|\d+\.\s+|```|\[[^\]]+\]\([^)]+\))/.test(raw);
  return {
    answerFormat: likelyMarkdown ? ("markdown" as const) : ("plain" as const),
    answer: raw
  };
}

/** A source citation the synthesis model emits in its trailing `SOURCES:` block. */
export type SourceCitation = { connectionId: string; fileId: string };

/**
 * Split a synthesis answer into its prose body and the structured source
 * citations the model lists in a trailing `SOURCES:` block (it is instructed to
 * end with one — see {@link synthesisSystemPrompt}). The block starts at a line
 * that is just `SOURCES:` (case-insensitive, an optional `-`/`*` bullet
 * tolerated, must be alone on its line so prose like "the sources: a, b" is not
 * mistaken for it) and runs to the end of the text; each following non-empty
 * line is a `connectionId/fileId` pair (leading bullet tolerated, split on the
 * first `/` — Drive ids contain no slash). The block is stripped from the
 * returned `body` so the UI renders structured source cards instead of a
 * duplicated prose list. Unparseable lines are skipped and citations are deduped;
 * with no block the body is returned unchanged and the citation list is empty.
 * Only meaningful for synthesis (list modes have no answer body).
 */
export function parseSources(answer: string): { body: string; citations: SourceCitation[] } {
  const match = answer.match(/(?:^|\n)[ \t]*(?:[-*]\s*)?SOURCES:[ \t]*\n?([\s\S]*)$/i);
  if (!match) return { body: answer.trim(), citations: [] };
  const body = answer.slice(0, match.index).trim();
  const citations: SourceCitation[] = [];
  const seen = new Set<string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const entry = line.trim().replace(/^[-*]\s*/, "");
    if (!entry) continue;
    const slash = entry.indexOf("/");
    if (slash <= 0 || slash >= entry.length - 1) continue;
    const connectionId = entry.slice(0, slash).trim();
    const fileId = entry.slice(slash + 1).trim();
    if (!connectionId || !fileId) continue;
    const dedupeKey = `${connectionId}:${fileId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    citations.push({ connectionId, fileId });
  }
  return { body, citations };
}

/**
 * Resolve a synthesis answer's source citations to full {@link DriveFile}s for
 * display, looking each `connectionId/fileId` up among the files the agent
 * actually encountered this run (`touched`). Citations the agent never saw are
 * dropped — the hallucination guard, so a fabricated id can't show up as a
 * "source". If nothing resolves (the model omitted the block, or only cited
 * unknown ids) we fall back to the files it opened: the best available proxy for
 * "relied on", so a synthesis that read files never shows a sourceless result.
 * Returns a deduped list.
 */
export function resolveSources(
  citations: SourceCitation[],
  touched: DriveFile[],
  opened: DriveFile[]
): DriveFile[] {
  const byKey = new Map(touched.map((file) => [fileKey(file), file] as const));
  const resolved: DriveFile[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    const key = fileKey({ connectionId: citation.connectionId, id: citation.fileId });
    const matched = byKey.get(key);
    if (!matched || seen.has(key)) continue;
    seen.add(key);
    resolved.push(matched);
  }
  return resolved.length > 0 ? resolved : uniqueFiles(opened);
}

/**
 * Assemble the terminal result payload from the parsed answer. Two file lists:
 *  - `files` (primary result): synthesis -> the files the answer cites
 *    (resolved from the SOURCES block via {@link resolveSources}, falling back to
 *    opened files); curated list -> examiner-kept files (an empty set is a valid
 *    "nothing relevant"); uncurated list -> every touched file (all matches).
 *  - `touchedFiles` (audit/disclosure): every file the agent encountered.
 * For synthesis the SOURCES block is also stripped from the answer body so the
 * UI shows structured source cards instead of a duplicated prose list.
 *
 * `rankedCurated` (curated list mode only) is the reranker's relevance-ordered
 * kept set; when provided it replaces the live keep-order for the primary `files`
 * list. It must be a permutation of the kept set (the reranker only reorders,
 * never adds/drops — see lib/agent/ranker.ts), so passing it never changes
 * membership, only order. Omitted (or non-curated) -> keep-order as before.
 */
export function buildAgentResult(
  input: AgentRequest,
  state: AgentRunState,
  parsed: { answer: string; answerFormat: "markdown" | "plain" },
  rankedCurated?: DriveFile[]
): { answer: string; answerFormat: "markdown" | "plain"; files: DriveFile[]; touchedFiles: DriveFile[] } {
  let answer = parsed.answer;
  let files: DriveFile[];
  if (input.mode === "synthesis") {
    const parsedSources = parseSources(answer);
    answer = parsedSources.body;
    files = resolveSources(parsedSources.citations, state.touched.list(), state.opened.list());
  } else if (isCuratingRequest(input)) {
    // The kept FileSet is already deduped, so list() is the result directly; the
    // reranked order (when present) just reorders that same set.
    files = rankedCurated ?? state.kept.list();
  } else {
    files = state.touched.list();
  }
  return {
    answer,
    answerFormat: parsed.answerFormat,
    files,
    touchedFiles: state.touched.list()
  };
}
