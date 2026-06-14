// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import type { DriveConnectionSummary } from "@/lib/drive-connections";
import type { AgentRequest } from "./types";

/**
 * Build a human-readable identity for the owner of the selected Drive
 * connection(s) — `Name <email>` per connection, deduped. This anchors the
 * agent's notion of *who* "my"/"I" in the query refers to, so it can tell a
 * document that is *about* the subject apart from one the subject merely
 * authored, was sent, or is mentioned in (e.g. a reference letter they wrote for
 * a colleague — whose name must not become the subject's alias). Returns null
 * when no name/email is resolvable, in which case the prompts omit the anchor.
 * The value is content (PII), so it is only ever logged through debugText.
 */
export function describeSubjectIdentity(
  connections: DriveConnectionSummary[],
  selectedDriveIds: string[]
): string | null {
  const selected = new Set(selectedDriveIds);
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const connection of connections) {
    if (!selected.has(connection.id)) continue;
    const name = connection.driveName?.trim();
    const email = connection.driveEmail.trim();
    if (!name && !email) continue;
    const label = name && email ? `${name} <${email}>` : name || email;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels.length > 0 ? labels.join(", ") : null;
}

function basePrompt(allowedDriveIds: string[], listMode = false, subject: string | null = null) {
  // List modes read files with the isolated examiner (review_file); synthesis
  // reads them directly (open_file).
  const examineTool = listMode ? "review_file" : "open_file";
  // Smaller models occasionally fabricate a connectionId — e.g. inventing a
  // second connection even when only one exists. Spell out that ids are opaque
  // values to be copied verbatim, and when there is a single connection pin it
  // to one literal so there is nothing to "guess".
  const idRule =
    allowedDriveIds.length === 1
      ? `There is exactly one connection: every connectionId you pass must be exactly "${allowedDriveIds[0]}" — never any other value.`
      : `Every connectionId you pass must be exactly one of those IDs.`;
  // Identify the owner as a *fact* (so first-person queries resolve), and warn
  // that matching/authorship/mention is not the same as aboutness. Deliberately
  // NOT phrased as "the request is about the owner": most queries are topical, not
  // about a person, so this must stay neutral to avoid over-correcting them. The
  // aboutness caution is universally true. Omitted when no identity is resolvable.
  const subjectRule = subject
    ? `\nThe owner of the connected Drive(s) is ${subject}; treat first-person words in the query ("my", "me", "I") as referring to them.\nA file can mention, be addressed to, or be authored by a person without being about that person — for example a reference or recommendation letter someone wrote for a colleague, or a file merely shared with them. A name in a title often identifies the author or recipient, not the topic, so don't assume a file is about a person just because it matched a search or carries their name.`
    : "";
  return `You are a Google Drive research agent.

You have exactly two tools: search_drive and ${examineTool}.
You may only work with these selected Drive connection IDs: ${allowedDriveIds.join(", ")}.
Every connectionId and fileId you pass to a tool is an opaque identifier you must copy verbatim from a search_drive result — never invent, guess, modify, or take an id from a different file.
${idRule}${subjectRule}
Search broadly with varied, targeted terms. When a file you read reveals a new name, project, product, person, or term, search for that too — it often surfaces relevant files a generic query misses.
Do not repeat an identical search.
There is no fixed limit on how many times you may search or ${examineTool}: keep going while you are still finding new useful files, and stop once you are not. If a tool result tells you returns are diminishing, wrap up unless you have a genuinely new angle.
Never claim you searched outside Google Drive.
Never ask for permissions or tokens.
If evidence is weak, say that directly.`;
}

function synthesisSystemPrompt(allowedDriveIds: string[], subject: string | null) {
  // Output-side half of the entity-conflation guard. The first sentence is a
  // universal correctness rule (safe for any query, personal or topical). The
  // owner-profile behavior is GATED on the request actually being about a person,
  // so a generic/topical query is NOT forced to be "about the owner" (avoids the
  // over-correction where every answer gets filtered down to the owner).
  const subjectRule = subject
    ? `\nAttribute every fact to the correct person and keep distinct people distinct: never merge one person's name, roles, or achievements into another, and never present one person's name as an alias of another unless a source explicitly states they are the same person. When the request is specifically about a person — e.g. the Drive owner (${subject}) referred to as "my"/"me"/"I" — base the answer on facts that are actually about that person, not merely on files they authored or are mentioned in; prefer identity details corroborated across multiple sources such as CVs or resumes.`
    : "";
  return `${basePrompt(allowedDriveIds, false, subject)}

Open files whose titles look relevant; what you read can suggest new searches.
Return a concise synthesis answering the user's query.${subjectRule}
Your final response must start with exactly one format line:
FORMAT: markdown
or
FORMAT: plain
Then put the answer body after that line.
Use markdown only when headings, lists, links, or other markdown structure materially improve readability.
Never return HTML or any format other than markdown or plain.
After the answer body, cite the files you actually relied on as a trailing block: a line containing exactly SOURCES: on its own, then one line per file in the form connectionId/fileId, copying both ids verbatim from a search_drive or open_file result.
List only files whose content you used; omit the SOURCES block entirely if you relied on none. Do not list or mention the source files anywhere else in the answer body.`;
}

function listSystemPrompt(
  allowedDriveIds: string[],
  curateList: boolean,
  subject: string | null
) {
  if (curateList) {
    return `${basePrompt(allowedDriveIds, true, subject)}

Find relevant files only. Do not synthesize an answer.
For every file that looks promising from its title, call review_file with its connectionId and fileId.
review_file reads the file in isolation and judges its relevance for you: relevant files are kept in the results automatically and irrelevant ones are dropped. You do not judge relevance yourself, and there is no separate step to open or keep a file.
review_file also reports notable names, projects, or terms found in the file — use those to search for related files you would not have found from the query alone.
Only files you review can be kept, so review every promising file.
When further searches and reviews stop turning up new relevant files, stop calling tools and reply with exactly:
FORMAT: plain
DONE`;
  }

  return `${basePrompt(allowedDriveIds, true, subject)}

Return the files that match the query. Do not synthesize an answer.
Every file a search surfaces is included in the results automatically — you do not keep, mark, or judge files.
Use review_file on promising files to read them and discover related names, projects, or terms, then search for those to widen coverage.
When further searches stop surfacing new files, return exactly:
FORMAT: plain
FILE_LIST_COMPLETE`;
}

export function systemPrompt(input: AgentRequest, allowedDriveIds: string[], subject: string | null) {
  return input.mode === "synthesis"
    ? synthesisSystemPrompt(allowedDriveIds, subject)
    : listSystemPrompt(allowedDriveIds, input.curateList, subject);
}
