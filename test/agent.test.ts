// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleOpenFileTool,
  handleReviewFileTool,
  handleSearchTool,
  normalizeGradeVerdict,
  parseFinalAnswer,
  type AgentProgress,
  type AgentRunContext,
  type AgentRunState,
  type GradeVerdict
} from "@/lib/agent";
import { openDriveFile, searchDriveFiles } from "@/lib/drive";
import type { DriveFile } from "@/lib/drive";

vi.mock("@/lib/drive", () => ({
  openDriveFile: vi.fn(),
  searchDriveFiles: vi.fn()
}));

function file(connectionId: string, id: string, name = id): DriveFile {
  return {
    connectionId,
    id,
    name,
    driveEmail: `${connectionId}@example.com`,
    mimeType: "text/plain"
  };
}

function makeContext(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    ownerSub: "owner-1",
    input: { query: "q", mode: "synthesis", driveIds: ["c1"], curateList: false },
    budget: {
      maxToolSteps: 20,
      maxSearchCalls: 10,
      maxOpenFileCalls: 20,
      maxLowProgressSearches: 2,
      maxToolRetries: 1
    },
    selectedDriveIds: ["c1"],
    requestId: "req-test",
    emit: () => {},
    gradeFile: async () => ({ relevant: true, reason: "stub" }),
    ...overrides
  };
}

function makeState(overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    referencedFiles: [],
    openedFiles: [],
    reviewedFiles: [],
    keptFiles: [],
    searchedQueries: new Set<string>(),
    knownFileKeys: new Set<string>(),
    openedFileKeys: new Set<string>(),
    reviewedFileKeys: new Set<string>(),
    keptFileKeys: new Set<string>(),
    searchCallCount: 0,
    openFileCallCount: 0,
    reviewFileCallCount: 0,
    lowProgressSearchCount: 0,
    stopAfterToolUseReason: null,
    currentStep: 0,
    ...overrides
  };
}

function reviewCall(id: string, connectionId = "c1", fileId = "f1") {
  return {
    id,
    type: "function" as const,
    function: {
      name: "review_file" as const,
      arguments: JSON.stringify({ connectionId, fileId })
    }
  };
}

function curatedContext(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return makeContext({
    input: { query: "q", mode: "list", driveIds: ["c1"], curateList: true },
    ...overrides
  });
}

describe("parseFinalAnswer", () => {
  it("returns an empty plain answer in list mode regardless of content", () => {
    expect(parseFinalAnswer("# anything here", "list")).toEqual({
      answer: "",
      answerFormat: "plain"
    });
  });

  it("falls back to a placeholder when there is no content", () => {
    expect(parseFinalAnswer(null, "synthesis")).toEqual({
      answer: "No answer returned.",
      answerFormat: "plain"
    });
    expect(parseFinalAnswer("   ", "synthesis")).toEqual({
      answer: "No answer returned.",
      answerFormat: "plain"
    });
  });

  it("honours an explicit FORMAT directive and strips it", () => {
    expect(parseFinalAnswer("FORMAT: markdown\n# Title\nbody", "synthesis")).toEqual({
      answer: "# Title\nbody",
      answerFormat: "markdown"
    });
    // FORMAT: plain wins even if the body looks like markdown.
    expect(parseFinalAnswer("FORMAT: plain\n# Not a heading", "synthesis")).toEqual({
      answer: "# Not a heading",
      answerFormat: "plain"
    });
  });

  it("matches the FORMAT directive case-insensitively", () => {
    expect(parseFinalAnswer("format: MARKDOWN\nhi", "synthesis")).toEqual({
      answer: "hi",
      answerFormat: "markdown"
    });
  });

  it("auto-detects markdown structure when no directive is present", () => {
    const markdownSamples = [
      "# Heading",
      "- bullet one\n- bullet two",
      "1. first\n2. second",
      "```\ncode\n```",
      "[docs](https://example.com)"
    ];
    for (const sample of markdownSamples) {
      expect(parseFinalAnswer(sample, "synthesis"), sample).toEqual({
        answer: sample,
        answerFormat: "markdown"
      });
    }
  });

  it("treats prose without markdown markers as plain", () => {
    const text = "Just a normal sentence with a [bracket] but no link.";
    expect(parseFinalAnswer(text, "synthesis")).toEqual({
      answer: text,
      answerFormat: "plain"
    });
  });
});

describe("normalizeGradeVerdict", () => {
  it("passes through a relevant/irrelevant verdict with its reason", () => {
    expect(normalizeGradeVerdict({ relevant: true, reason: "matches the query" })).toEqual({
      relevant: true,
      reason: "matches the query"
    });
    expect(normalizeGradeVerdict({ relevant: false, reason: "off topic" })).toEqual({
      relevant: false,
      reason: "off topic"
    });
  });

  it("supplies a default reason when the grader omits or blanks it", () => {
    expect(normalizeGradeVerdict({ relevant: true })).toEqual({
      relevant: true,
      reason: "Judged relevant."
    });
    expect(normalizeGradeVerdict({ relevant: false, reason: "   " })).toEqual({
      relevant: false,
      reason: "Judged not relevant."
    });
    expect(normalizeGradeVerdict({ relevant: true, reason: null })).toEqual({
      relevant: true,
      reason: "Judged relevant."
    });
  });

  it("trims and caps an overlong reason", () => {
    const long = "x".repeat(500);
    const verdict = normalizeGradeVerdict({ relevant: true, reason: `  ${long}  ` });
    expect(verdict.reason.length).toBe(300);
    expect(verdict.reason.startsWith("x")).toBe(true);
  });
});

describe("handleOpenFileTool", () => {
  function openCall(id: string) {
    return {
      id,
      type: "function" as const,
      function: {
        name: "open_file" as const,
        arguments: JSON.stringify({ connectionId: "c1", fileId: "f1" })
      }
    };
  }

  beforeEach(() => {
    vi.mocked(openDriveFile).mockReset();
  });

  it("returns an error observation instead of throwing when a file fails to open", async () => {
    vi.mocked(openDriveFile).mockRejectedValue(
      new Error("Google Drive request failed with status 403")
    );
    const runState = makeState();

    // The whole point: a single un-openable file must not reject (which would
    // bubble out of runDriveAgent and abort the entire run).
    const result = await handleOpenFileTool(makeContext(), runState, 0, openCall("call-1"));

    expect(result.role).toBe("tool");
    expect(result.tool_call_id).toBe("call-1");
    const payload = JSON.parse(result.content) as { error?: boolean; message?: string };
    expect(payload.error).toBe(true);
    expect(payload.message).toContain("403");
    // The failed file is still counted and marked opened so the run won't retry
    // it, but it must not be recorded as a usable source.
    expect(runState.openFileCallCount).toBe(1);
    expect(runState.openedFiles).toHaveLength(0);
    expect(runState.referencedFiles).toHaveLength(0);
  });

  it("rejects an out-of-scope connectionId as an observation instead of throwing", async () => {
    const runState = makeState();
    const outOfScope = {
      id: "call-scope",
      type: "function" as const,
      function: {
        name: "open_file" as const,
        // selectedDriveIds is ["c1"], so "c2" is outside the selected scope —
        // exactly what happens when the model hallucinates a connectionId.
        arguments: JSON.stringify({ connectionId: "c2", fileId: "f1" })
      }
    };

    // A hallucinated/out-of-scope connectionId must not abort the run (which a
    // throw would, bubbling out of runDriveAgent): it is surfaced as a
    // recoverable observation, and the file is never opened.
    const result = await handleOpenFileTool(makeContext(), runState, 0, outOfScope);

    expect(result.role).toBe("tool");
    expect(result.tool_call_id).toBe("call-scope");
    const payload = JSON.parse(result.content) as { error?: boolean; message?: string };
    expect(payload.error).toBe(true);
    expect(payload.message).toContain("not one of the selected");
    expect(openDriveFile).not.toHaveBeenCalled();
    // The out-of-scope call must not consume budget or be recorded as opened.
    expect(runState.openFileCallCount).toBe(0);
    expect(runState.openedFiles).toHaveLength(0);
    expect(runState.referencedFiles).toHaveLength(0);
  });

  it("returns an error observation for malformed JSON arguments instead of throwing", async () => {
    const runState = makeState();
    const malformed = {
      id: "call-bad-json",
      type: "function" as const,
      function: { name: "open_file" as const, arguments: "{ not valid json" }
    };

    // Malformed tool arguments must not abort the run: the parse failure becomes
    // a recoverable observation and the file is never opened.
    const result = await handleOpenFileTool(makeContext(), runState, 0, malformed);

    const payload = JSON.parse(result.content) as { error?: boolean; message?: string };
    expect(payload.error).toBe(true);
    expect(payload.message).toContain("Invalid arguments for open_file");
    expect(openDriveFile).not.toHaveBeenCalled();
    expect(runState.openFileCallCount).toBe(0);
  });

  it("returns an error observation for schema-invalid arguments (missing fileId)", async () => {
    const runState = makeState();
    const missingField = {
      id: "call-missing",
      type: "function" as const,
      function: { name: "open_file" as const, arguments: JSON.stringify({ connectionId: "c1" }) }
    };

    const result = await handleOpenFileTool(makeContext(), runState, 0, missingField);

    const payload = JSON.parse(result.content) as { error?: boolean; message?: string };
    expect(payload.error).toBe(true);
    expect(payload.message).toContain("Invalid arguments for open_file");
    expect(openDriveFile).not.toHaveBeenCalled();
    expect(runState.openFileCallCount).toBe(0);
  });

  it("returns the file content as an observation on a successful open", async () => {
    vi.mocked(openDriveFile).mockResolvedValue({
      file: file("c1", "f1", "Doc"),
      content: "hello world"
    });
    const runState = makeState();

    const result = await handleOpenFileTool(makeContext(), runState, 0, openCall("call-2"));

    const payload = JSON.parse(result.content) as { content?: string };
    expect(payload.content).toBe("hello world");
    expect(runState.openedFiles).toHaveLength(1);
    expect(runState.referencedFiles).toHaveLength(1);
  });

  it("always records an opened file as a result (open_file is non-curated only)", async () => {
    vi.mocked(openDriveFile).mockResolvedValue({
      file: file("c1", "f1", "Doc"),
      content: "hello world"
    });
    const runState = makeState();
    const events: AgentProgress[] = [];
    const context = makeContext({
      emit: (event) => {
        events.push(event);
      }
    });

    await handleOpenFileTool(context, runState, 0, openCall("call-3"));

    expect(runState.openedFiles).toHaveLength(1);
    expect(runState.referencedFiles).toHaveLength(1);
    expect(events.some((event) => event.type === "file")).toBe(true);
    expect(events.some((event) => event.type === "reviewing")).toBe(false);
  });
});

describe("handleReviewFileTool", () => {
  beforeEach(() => {
    vi.mocked(openDriveFile).mockReset();
  });

  function setup(verdict: GradeVerdict) {
    vi.mocked(openDriveFile).mockResolvedValue({
      file: file("c1", "f1", "Doc"),
      content: "hello world"
    });
    const runState = makeState();
    const events: AgentProgress[] = [];
    const gradeFile = vi.fn(async () => verdict);
    const context = curatedContext({
      emit: (event) => {
        events.push(event);
      },
      gradeFile
    });
    return { runState, events, gradeFile, context };
  }

  it("keeps a file the grader judges relevant and never returns its content", async () => {
    const { runState, events, gradeFile, context } = setup({ relevant: true, reason: "on topic" });

    const result = await handleReviewFileTool(context, runState, 0, reviewCall("r1"));

    const payload = JSON.parse(result.content) as { reviewed?: boolean; kept?: boolean; content?: string };
    expect(payload.reviewed).toBe(true);
    expect(payload.kept).toBe(true);
    // The file's content must NOT leak back into the main loop's context.
    expect(payload.content).toBeUndefined();
    expect(gradeFile).toHaveBeenCalledTimes(1);
    expect(runState.keptFiles).toEqual([file("c1", "f1", "Doc")]);
    expect(runState.reviewedFiles).toHaveLength(1);
    expect(events.some((event) => event.type === "reviewing")).toBe(true);
    expect(events.some((event) => event.type === "kept")).toBe(true);
    expect(events.some((event) => event.type === "discarded")).toBe(false);
  });

  it("discards a file the grader judges irrelevant", async () => {
    const { runState, events, context } = setup({ relevant: false, reason: "off topic" });

    const result = await handleReviewFileTool(context, runState, 0, reviewCall("r2"));

    const payload = JSON.parse(result.content) as { reviewed?: boolean; kept?: boolean };
    expect(payload.reviewed).toBe(true);
    expect(payload.kept).toBe(false);
    expect(runState.keptFiles).toHaveLength(0);
    expect(runState.reviewedFiles).toHaveLength(1);
    expect(events.some((event) => event.type === "reviewing")).toBe(true);
    expect(events.some((event) => event.type === "discarded")).toBe(true);
    expect(events.some((event) => event.type === "kept")).toBe(false);
  });

  it("rejects an out-of-scope connectionId as an observation without opening or grading", async () => {
    const runState = makeState();
    const gradeFile = vi.fn(async () => ({ relevant: true, reason: "x" }));
    const context = curatedContext({ gradeFile });

    // selectedDriveIds is ["c1"], so "c2" is outside scope (a hallucinated id).
    const result = await handleReviewFileTool(context, runState, 0, reviewCall("r3", "c2", "f1"));

    const payload = JSON.parse(result.content) as { error?: boolean; message?: string };
    expect(payload.error).toBe(true);
    expect(payload.message).toContain("not one of the selected");
    expect(openDriveFile).not.toHaveBeenCalled();
    expect(gradeFile).not.toHaveBeenCalled();
    expect(runState.reviewFileCallCount).toBe(0);
    expect(runState.keptFiles).toHaveLength(0);
  });

  it("returns an error observation (not a throw) when the file fails to open", async () => {
    vi.mocked(openDriveFile).mockRejectedValue(
      new Error("Google Drive request failed with status 403")
    );
    const runState = makeState();
    const gradeFile = vi.fn(async () => ({ relevant: true, reason: "x" }));
    const context = curatedContext({ gradeFile });

    const result = await handleReviewFileTool(context, runState, 0, reviewCall("r4"));

    const payload = JSON.parse(result.content) as { error?: boolean; message?: string };
    expect(payload.error).toBe(true);
    expect(payload.message).toContain("403");
    // The file is counted (so it won't be retried) but never graded or kept.
    expect(runState.reviewFileCallCount).toBe(1);
    expect(gradeFile).not.toHaveBeenCalled();
    expect(runState.keptFiles).toHaveLength(0);
  });

  it("skips a file already reviewed earlier in the run", async () => {
    const { runState, gradeFile, context } = setup({ relevant: true, reason: "on topic" });

    await handleReviewFileTool(context, runState, 0, reviewCall("r5"));
    const second = await handleReviewFileTool(context, runState, 0, reviewCall("r6"));

    const payload = JSON.parse(second.content) as { reviewed?: boolean; alreadyReviewed?: boolean; kept?: boolean };
    expect(payload.alreadyReviewed).toBe(true);
    expect(payload.kept).toBe(true);
    expect(openDriveFile).toHaveBeenCalledTimes(1);
    expect(gradeFile).toHaveBeenCalledTimes(1);
    expect(runState.keptFiles).toHaveLength(1);
  });

  it("skips reviewing once the review budget is reached", async () => {
    const runState = makeState();
    const gradeFile = vi.fn(async () => ({ relevant: true, reason: "x" }));
    const context = curatedContext({
      budget: { ...makeContext().budget, maxOpenFileCalls: 0 },
      gradeFile
    });

    const result = await handleReviewFileTool(context, runState, 0, reviewCall("r7"));

    const payload = JSON.parse(result.content) as { skipped?: boolean; reason?: string };
    expect(payload.skipped).toBe(true);
    expect(payload.reason).toContain("Review budget reached");
    expect(openDriveFile).not.toHaveBeenCalled();
    expect(gradeFile).not.toHaveBeenCalled();
  });
});

describe("handleSearchTool", () => {
  it("returns an error observation for schema-invalid arguments without searching", async () => {
    vi.mocked(searchDriveFiles).mockReset();
    const runState = makeState();
    const missingQuery = {
      id: "s-bad",
      type: "function" as const,
      // searchArgs requires `query`; omitting it is a ZodError, which must not
      // abort the run.
      function: { name: "search_drive" as const, arguments: JSON.stringify({ limit: 5 }) }
    };

    const result = await handleSearchTool(makeContext(), runState, 0, missingQuery);

    const payload = JSON.parse(result.content) as { error?: boolean; message?: string };
    expect(payload.error).toBe(true);
    expect(payload.message).toContain("Invalid arguments for search_drive");
    expect(searchDriveFiles).not.toHaveBeenCalled();
    expect(runState.searchCallCount).toBe(0);
  });
});
