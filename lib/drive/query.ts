// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

export function escapeDriveQuery(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Upper bound on how many distinct terms a multi-word query contributes to the
 * Drive `q`. Each term adds two clauses (name + fullText), so this keeps the
 * generated query bounded even for a pathological 500-char search string.
 */
const MAX_SEARCH_TERMS = 12;

/**
 * Build the Drive `q` filter for a search string.
 *
 * A naive `name contains 'a b' or fullText contains 'a b'` makes Google match
 * the whole string "a b" (all terms together), which silently drops files that
 * contain only some of the terms — e.g. the query "Airwallex feedback" misses a
 * doc named "Airwallex Reflection" that never says "feedback". That kills recall
 * on perfectly reasonable multi-word queries.
 *
 * So for a multi-word query we match ANY term instead: each distinct term (deduped
 * case-insensitively and capped at {@link MAX_SEARCH_TERMS}) contributes a
 * `name contains` / `fullText contains` pair and the clauses are OR-ed together.
 * This is a strict superset of the old whole-string match (every phrase hit still
 * matches), so it only ever widens the candidate set; the agent and the curated
 * grader filter for true relevance afterwards. Single-word queries are unchanged.
 *
 * `orderBy` is deliberately left unset by the caller: Drive v3 has no `relevance`
 * sort key, and omitting `orderBy` is the only way to get relevance ordering,
 * which is what keeps the best matches near the top of the (capped) result page.
 */
export function buildDriveSearchQuery(rawQuery: string): string {
  const trimmed = rawQuery.trim();
  const terms = trimmed.split(/\s+/).filter(Boolean);
  let matchTargets: string[];
  if (terms.length > 1) {
    const seen = new Set<string>();
    const distinct: string[] = [];
    for (const term of terms) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push(term);
      if (distinct.length >= MAX_SEARCH_TERMS) break;
    }
    matchTargets = distinct;
  } else {
    matchTargets = [trimmed];
  }
  const clauses = matchTargets.flatMap((term) => {
    const escaped = escapeDriveQuery(term);
    return [`name contains '${escaped}'`, `fullText contains '${escaped}'`];
  });
  return `trashed = false and (${clauses.join(" or ")})`;
}
