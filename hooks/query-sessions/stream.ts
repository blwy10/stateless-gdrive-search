// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { fileKey, type DriveFile, type QuerySession } from "./types";

export type StreamEvent =
  | { type: "progress"; message: string }
  | { type: "reasoning"; delta: string }
  | { type: "file"; file: DriveFile }
  | { type: "reviewing"; file: DriveFile }
  | { type: "kept"; file: DriveFile }
  | { type: "discarded"; file: DriveFile }
  | {
      type: "final";
      answer: string;
      answerFormat: "markdown" | "plain";
      files: DriveFile[];
      touchedFiles: DriveFile[];
    }
  | { type: "error"; message: string };

export type AgentQueryRequest = {
  query: string;
  mode: "synthesis" | "list";
  curateList: boolean;
  selectedDrive: string;
};

/**
 * Apply one streamed agent event to a session, returning the updated session.
 * Pure (no React state) so the live-update logic is in one place and testable:
 *  - progress  -> append a progress line;
 *  - reasoning -> append a chunk to the live "thinking" stream;
 *  - file      -> add to the touched set, and (uncurated list only) the results;
 *  - reviewing -> add a provisional curated candidate;
 *  - kept      -> promote a candidate into the results;
 *  - discarded -> drop a candidate;
 *  - final     -> the authoritative terminal result;
 *  - error     -> the terminal failure.
 */
export function applyStreamEvent(session: QuerySession, event: StreamEvent): QuerySession {
  const updatedAt = new Date().toISOString();
  switch (event.type) {
    case "progress":
      return { ...session, events: [...session.events, event.message], updatedAt };
    case "reasoning":
      // Accumulate the live "thinking" stream. Display-only; kept in memory for the
      // active run and stripped before persistence (see saveStoredSessions).
      return { ...session, reasoning: session.reasoning + event.delta, updatedAt };
    case "file": {
      // A file the agent encountered. It always joins the "touched" audit list; in
      // uncurated list mode it is also a result, so mirror it into `files` for live
      // streaming. Synthesis sources and curated keeps arrive authoritatively via
      // `final`/`kept`, so they are not mirrored here.
      const isUncuratedList = session.mode === "list" && !session.curateList;
      return {
        ...session,
        touchedFiles: [...session.touchedFiles, event.file],
        ...(isUncuratedList ? { files: [...session.files, event.file] } : {}),
        updatedAt
      };
    }
    case "reviewing":
      return { ...session, reviewingFiles: [...session.reviewingFiles, event.file], updatedAt };
    case "kept": {
      // Promote the file from "reviewing" into the results.
      const keptKey = fileKey(event.file);
      return {
        ...session,
        files: [...session.files, event.file],
        reviewingFiles: session.reviewingFiles.filter((file) => fileKey(file) !== keptKey),
        updatedAt
      };
    }
    case "discarded": {
      // The grader judged this file irrelevant, so drop it from "reviewing".
      const discardedKey = fileKey(event.file);
      return {
        ...session,
        reviewingFiles: session.reviewingFiles.filter((file) => fileKey(file) !== discardedKey),
        updatedAt
      };
    }
    case "final":
      return {
        ...session,
        status: "finished",
        answer: event.answer,
        answerFormat: event.answerFormat,
        files: event.files,
        touchedFiles: event.touchedFiles,
        reviewingFiles: [],
        error: "",
        updatedAt
      };
    case "error":
      return { ...session, status: "error", reviewingFiles: [], error: event.message, updatedAt };
    default:
      return session;
  }
}

/**
 * POST a query to the agent endpoint and parse the Server-Sent Events stream,
 * invoking `onEvent` for each decoded event. Throws if the request fails so the
 * caller can mark the session errored. The session bookkeeping (which session to
 * update, terminal-event tracking) stays with the caller.
 */
export async function streamAgentQuery(
  request: AgentQueryRequest,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  const response = await fetch("/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: request.query,
      mode: request.mode,
      curateList: request.curateList,
      driveIds: [request.selectedDrive]
    })
  });

  if (!response.ok || !response.body) {
    throw new Error(await response.text());
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((candidate) => candidate.startsWith("data: "));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(6)) as StreamEvent);
    }
  }
}
