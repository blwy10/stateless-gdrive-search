// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { applyStreamEvent, type StreamEvent } from "@/hooks/query-sessions/stream";
import type { QuerySession } from "@/hooks/query-sessions/types";

function baseSession(overrides: Partial<QuerySession> = {}): QuerySession {
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  return {
    id: "s1",
    query: "q",
    mode: "synthesis",
    curateList: false,
    selectedDrive: "all",
    createdAt: now,
    updatedAt: now,
    status: "running",
    events: [],
    files: [],
    touchedFiles: [],
    reviewingFiles: [],
    reasoning: "",
    answer: "",
    answerFormat: "plain",
    error: "",
    ...overrides
  };
}

describe("applyStreamEvent — reasoning", () => {
  it("accumulates reasoning deltas in order", () => {
    let session = baseSession();
    session = applyStreamEvent(session, { type: "reasoning", delta: "Hello" });
    session = applyStreamEvent(session, { type: "reasoning", delta: " world" });
    expect(session.reasoning).toBe("Hello world");
  });

  it("preserves boundary whitespace embedded in deltas (step separators)", () => {
    let session = baseSession({ reasoning: "step one" });
    session = applyStreamEvent(session, { type: "reasoning", delta: "\n\nstep two" });
    expect(session.reasoning).toBe("step one\n\nstep two");
  });

  it("does not touch results, events, or status, and bumps updatedAt", () => {
    const start = baseSession({ updatedAt: "2020-01-01T00:00:00.000Z" });
    const next = applyStreamEvent(start, { type: "reasoning", delta: "thinking" });
    expect(next.files).toEqual([]);
    expect(next.events).toEqual([]);
    expect(next.status).toBe("running");
    expect(next.updatedAt).not.toBe(start.updatedAt);
  });

  it("interleaves independently with progress lines", () => {
    let session = baseSession();
    const events: StreamEvent[] = [
      { type: "reasoning", delta: "a" },
      { type: "progress", message: "Searched" },
      { type: "reasoning", delta: "b" }
    ];
    for (const event of events) session = applyStreamEvent(session, event);
    expect(session.reasoning).toBe("ab");
    expect(session.events).toEqual(["Searched"]);
  });

  it("retains accumulated reasoning after the terminal final event", () => {
    let session = baseSession({ reasoning: "my thoughts" });
    session = applyStreamEvent(session, {
      type: "final",
      answer: "done",
      answerFormat: "plain",
      files: [],
      touchedFiles: []
    });
    expect(session.status).toBe("finished");
    expect(session.reasoning).toBe("my thoughts");
  });
});
