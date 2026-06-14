// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleOpenFileTool,
  handleReviewFileTool,
  handleSearchTool,
  normalizeGradeVerdict,
  parseFinalAnswer,
  parseSources,
  resolveSources,
  resolveUsageTokens,
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
      maxToolSteps: 100,
      maxSearchCalls: 50,
      maxTotalTokens: 1_000_000,
      maxContextInputTokens: 96_000,
      softProgressTokenLimit: 32_000,
      hardProgressTokenLimit: 80_000,
      maxToolRetries: 1
    },
    selectedDriveIds: ["c1"],
    requestId: "req-test",
    emit: () => {},
    gradeFile: async () => ({ relevant: true, reason: "stub", entities: [] }),
    ...overrides
  };
}

function makeState(overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    touchedFiles: [],
    openedFiles: [],
    reviewedFiles: [],
    keptFiles: [],
    searchedQueries: new Set<string>(),
    knownFileKeys: new Set<string>(),
    touchedFileKeys: new Set<string>(),
    openedFileKeys: new Set<string>(),
    reviewedFileKeys: new Set<string>(),
    keptFileKeys: new Set<string>(),
    searchCallCount: 0,
    openFileCallCount: 0,
    reviewFileCallCount: 0,
    tokensSpent: 0,
    tokensAtLastProgress: 0,
    lastInputTokens: 0,
    stopSearchingReason: null,
    windDownReason: null,
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

function searchCall(id: string, query: string, limit?: number) {
  return {
    id,
    type: "function" as const,
    function: {
      name: "search_drive" as const,
      arguments: JSON.stringify(limit === undefined ? { query } : { query, limit })
    }
  };
}

function curatedContext(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return makeContext({
    input: { query: "q", mode: "list", driveIds: ["c1"], curateList: true },
    ...overrides
  });
}

function uncuratedContext(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return makeContext({
    input: { query: "q", mode: "list", driveIds: ["c1"], curateList: false },
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

describe("parseSources", () => {
  it("returns the body unchanged with no citations when there is no SOURCES block", () => {
    expect(parseSources("# Answer\nsome prose")).toEqual({
      body: "# Answer\nsome prose",
      citations: []
    });
  });

  it("strips a trailing SOURCES block and parses connectionId/fileId pairs", () => {
    const { body, citations } = parseSources(
      "The answer body.\n\nSOURCES:\nc1/f1\nc2/f2"
    );
    expect(body).toBe("The answer body.");
    expect(citations).toEqual([
      { connectionId: "c1", fileId: "f1" },
      { connectionId: "c2", fileId: "f2" }
    ]);
  });

  it("tolerates bullets and case, and dedupes repeated citations", () => {
    const { body, citations } = parseSources(
      "Body.\nsources:\n- c1/f1\n* c1/f1\n  c2/f2  "
    );
    expect(body).toBe("Body.");
    expect(citations).toEqual([
      { connectionId: "c1", fileId: "f1" },
      { connectionId: "c2", fileId: "f2" }
    ]);
  });

  it("ignores malformed citation lines (no slash, empty halves)", () => {
    const { citations } = parseSources("Body.\nSOURCES:\nnot-a-pair\n/f1\nc1/\nc1/f1");
    expect(citations).toEqual([{ connectionId: "c1", fileId: "f1" }]);
  });

  it("does not treat inline 'sources:' prose as a block", () => {
    // "sources:" is followed by text on the same line, so it is not a block.
    const answer = "We pulled from many sources: docs and sheets.";
    expect(parseSources(answer)).toEqual({ body: answer, citations: [] });
  });
});

describe("resolveSources", () => {
  const touched = [file("c1", "f1", "Doc 1"), file("c1", "f2", "Doc 2"), file("c2", "f3", "Doc 3")];

  it("resolves cited ids to full files, dropping ids the agent never saw", () => {
    const resolved = resolveSources(
      [
        { connectionId: "c1", fileId: "f2" },
        { connectionId: "c9", fileId: "ghost" } // never touched -> hallucination guard
      ],
      touched,
      []
    );
    expect(resolved).toEqual([file("c1", "f2", "Doc 2")]);
  });

  it("dedupes resolved files", () => {
    const resolved = resolveSources(
      [
        { connectionId: "c1", fileId: "f1" },
        { connectionId: "c1", fileId: "f1" }
      ],
      touched,
      []
    );
    expect(resolved).toEqual([file("c1", "f1", "Doc 1")]);
  });

  it("falls back to opened files when no citation resolves", () => {
    const opened = [file("c1", "f1", "Doc 1")];
    // Empty citations, or only-unknown citations, both fall back to opened.
    expect(resolveSources([], touched, opened)).toEqual(opened);
    expect(
      resolveSources([{ connectionId: "zzz", fileId: "nope" }], touched, opened)
    ).toEqual(opened);
  });

  it("returns an empty list when nothing resolves and nothing was opened", () => {
    expect(resolveSources([], touched, [])).toEqual([]);
  });
});

describe("normalizeGradeVerdict", () => {
  it("passes through a relevant/irrelevant verdict with its reason", () => {
    expect(normalizeGradeVerdict({ relevant: true, reason: "matches the query" })).toEqual({
      relevant: true,
      reason: "matches the query",
      entities: []
    });
    expect(normalizeGradeVerdict({ relevant: false, reason: "off topic" })).toEqual({
      relevant: false,
      reason: "off topic",
      entities: []
    });
  });

  it("supplies a default reason when the grader omits or blanks it", () => {
    expect(normalizeGradeVerdict({ relevant: true })).toEqual({
      relevant: true,
      reason: "Judged relevant.",
      entities: []
    });
    expect(normalizeGradeVerdict({ relevant: false, reason: "   " })).toEqual({
      relevant: false,
      reason: "Judged not relevant.",
      entities: []
    });
    expect(normalizeGradeVerdict({ relevant: true, reason: null })).toEqual({
      relevant: true,
      reason: "Judged relevant.",
      entities: []
    });
  });

  it("trims and caps an overlong reason", () => {
    const long = "x".repeat(500);
    const verdict = normalizeGradeVerdict({ relevant: true, reason: `  ${long}  ` });
    expect(verdict.reason.length).toBe(300);
    expect(verdict.reason.startsWith("x")).toBe(true);
  });

  it("normalizes entities: trims, drops blanks, dedupes case-insensitively, caps count", () => {
    const verdict = normalizeGradeVerdict({
      relevant: true,
      reason: "ok",
      entities: ["  Project Atlas  ", "project atlas", "", "   ", "Airwallex"]
    });
    // "project atlas" is a case-insensitive dup of "Project Atlas"; blanks dropped.
    expect(verdict.entities).toEqual(["Project Atlas", "Airwallex"]);
  });

  it("caps the number of entities", () => {
    const many = Array.from({ length: 20 }, (_, i) => `term-${i}`);
    const verdict = normalizeGradeVerdict({ relevant: true, reason: "ok", entities: many });
    expect(verdict.entities.length).toBe(8);
    expect(verdict.entities[0]).toBe("term-0");
  });
});

describe("resolveUsageTokens", () => {
  it("prefers the provider's totalTokens (which already includes reasoning)", () => {
    // reasoningTokens is a subset of output/total — must NOT be added on top.
    expect(
      resolveUsageTokens({ inputTokens: 100, outputTokens: 50, totalTokens: 150, reasoningTokens: 30 })
    ).toBe(150);
  });

  it("falls back to input + output when totalTokens is missing", () => {
    expect(resolveUsageTokens({ inputTokens: 100, outputTokens: 50 })).toBe(150);
    expect(resolveUsageTokens({ inputTokens: 100 })).toBe(100);
  });

  it("falls back to a char-based estimate (incl. reasoning text) when no usage is reported", () => {
    // 40 chars / 4 = 10 tokens; this is the no-usage-provider path.
    expect(resolveUsageTokens(undefined, "x".repeat(40))).toBe(10);
    expect(resolveUsageTokens({}, "x".repeat(40))).toBe(10);
  });

  it("returns 0 when there is neither usage nor text (step backstop is the floor)", () => {
    expect(resolveUsageTokens(undefined, "")).toBe(0);
    expect(resolveUsageTokens(undefined)).toBe(0);
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
    // it, but it must not be recorded as opened or touched.
    expect(runState.openFileCallCount).toBe(1);
    expect(runState.openedFiles).toHaveLength(0);
    expect(runState.touchedFiles).toHaveLength(0);
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
    expect(runState.touchedFiles).toHaveLength(0);
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
    expect(runState.touchedFiles).toHaveLength(1);
  });

  it("records an opened file in the touched set and emits a file event", async () => {
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
    expect(runState.touchedFiles).toHaveLength(1);
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

  it("keeps a file the grader judges relevant, returns entities, never returns its content", async () => {
    const { runState, events, gradeFile, context } = setup({
      relevant: true,
      reason: "on topic",
      entities: ["Project Atlas"]
    });

    const result = await handleReviewFileTool(context, runState, 0, reviewCall("r1"));

    const payload = JSON.parse(result.content) as {
      examined?: boolean;
      relevant?: boolean;
      entities?: string[];
      content?: string;
    };
    expect(payload.examined).toBe(true);
    expect(payload.relevant).toBe(true);
    // The berry-picking channel: extracted entities come back to the model.
    expect(payload.entities).toEqual(["Project Atlas"]);
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
    const { runState, events, context } = setup({ relevant: false, reason: "off topic", entities: [] });

    const result = await handleReviewFileTool(context, runState, 0, reviewCall("r2"));

    const payload = JSON.parse(result.content) as { examined?: boolean; relevant?: boolean };
    expect(payload.examined).toBe(true);
    expect(payload.relevant).toBe(false);
    expect(runState.keptFiles).toHaveLength(0);
    expect(runState.reviewedFiles).toHaveLength(1);
    expect(events.some((event) => event.type === "reviewing")).toBe(true);
    expect(events.some((event) => event.type === "discarded")).toBe(true);
    expect(events.some((event) => event.type === "kept")).toBe(false);
  });

  it("in uncurated list mode, examines for entities but never keeps/discards", async () => {
    vi.mocked(openDriveFile).mockResolvedValue({
      file: file("c1", "f1", "Doc"),
      content: "hello world"
    });
    const runState = makeState();
    const events: AgentProgress[] = [];
    const gradeFile = vi.fn(async () => ({ relevant: true, reason: "x", entities: ["Airwallex"] }));
    const context = uncuratedContext({
      emit: (event) => {
        events.push(event);
      },
      gradeFile
    });

    const result = await handleReviewFileTool(context, runState, 0, reviewCall("u1"));

    const payload = JSON.parse(result.content) as { examined?: boolean; entities?: string[] };
    expect(payload.examined).toBe(true);
    expect(payload.entities).toEqual(["Airwallex"]);
    // Uncurated returns every match at search time, so review never keeps/discards
    // and emits none of the curated lifecycle events.
    expect(runState.keptFiles).toHaveLength(0);
    expect(runState.reviewedFiles).toHaveLength(1);
    expect(events.some((event) => event.type === "reviewing")).toBe(false);
    expect(events.some((event) => event.type === "kept")).toBe(false);
    expect(events.some((event) => event.type === "discarded")).toBe(false);
  });

  it("rejects an out-of-scope connectionId as an observation without opening or grading", async () => {
    const runState = makeState();
    const gradeFile = vi.fn(async () => ({ relevant: true, reason: "x", entities: [] }));
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
    const gradeFile = vi.fn(async () => ({ relevant: true, reason: "x", entities: [] }));
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

  it("skips a file already examined earlier in the run", async () => {
    const { runState, gradeFile, context } = setup({ relevant: true, reason: "on topic", entities: [] });

    await handleReviewFileTool(context, runState, 0, reviewCall("r5"));
    const second = await handleReviewFileTool(context, runState, 0, reviewCall("r6"));

    const payload = JSON.parse(second.content) as { examined?: boolean; alreadyExamined?: boolean };
    expect(payload.alreadyExamined).toBe(true);
    expect(openDriveFile).toHaveBeenCalledTimes(1);
    expect(gradeFile).toHaveBeenCalledTimes(1);
    expect(runState.keptFiles).toHaveLength(1);
  });

  it("attaches a diminishing-returns note once spend has stalled past the soft limit", async () => {
    vi.mocked(openDriveFile).mockResolvedValue({
      file: file("c1", "f1", "Doc"),
      content: "hello world"
    });
    const runState = makeState({
      // Spend well past the soft limit with no progress recorded.
      tokensSpent: 40_000,
      tokensAtLastProgress: 0
    });
    const gradeFile = vi.fn(async () => ({ relevant: false, reason: "x", entities: [] }));
    const context = curatedContext({ gradeFile });

    const result = await handleReviewFileTool(context, runState, 0, reviewCall("r7"));

    const payload = JSON.parse(result.content) as { note?: string };
    expect(payload.note).toContain("Returns are diminishing");
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

  it("returns files with no note and records progress when the search surfaces new files", async () => {
    vi.mocked(searchDriveFiles).mockReset();
    vi.mocked(searchDriveFiles).mockResolvedValue([file("c1", "f1"), file("c1", "f2")]);
    // Synthesis context: search hits are results, so new files are useful progress.
    const runState = makeState({ tokensSpent: 5_000, tokensAtLastProgress: 0 });

    const result = await handleSearchTool(makeContext(), runState, 0, searchCall("s1", "alpha beta"));

    const payload = JSON.parse(result.content) as { files?: unknown[]; note?: string };
    expect(payload.files).toHaveLength(2);
    expect(payload.note).toBeUndefined();
    expect(runState.touchedFiles).toHaveLength(2);
    // New results reset the diminishing-returns clock to the current spend.
    expect(runState.tokensAtLastProgress).toBe(5_000);
  });

  it("in curated mode, search records touched files and emits them but is not progress", async () => {
    vi.mocked(searchDriveFiles).mockReset();
    vi.mocked(searchDriveFiles).mockResolvedValue([file("c1", "f1"), file("c1", "f2")]);
    const runState = makeState({ tokensSpent: 5_000, tokensAtLastProgress: 0 });
    const events: AgentProgress[] = [];
    const context = curatedContext({
      emit: (event) => {
        events.push(event);
      }
    });

    const result = await handleSearchTool(context, runState, 0, searchCall("s1", "alpha beta"));

    const payload = JSON.parse(result.content) as { files?: unknown[] };
    // Candidates are still returned to the model and tracked/streamed as touched
    // for the audit disclosure...
    expect(payload.files).toHaveLength(2);
    expect(runState.touchedFiles).toHaveLength(2);
    expect(events.filter((event) => event.type === "file")).toHaveLength(2);
    // ...but a bare search hit is a candidate, not a result, in curated mode, so
    // it must NOT reset the diminishing-returns clock (only an examiner keep does).
    expect(runState.tokensAtLastProgress).toBe(0);
  });

  it("does NOT flag a search that overlaps already-seen files (cheap searches are not penalized)", async () => {
    vi.mocked(searchDriveFiles).mockReset();
    // Both searches return the same file, so the second adds nothing new — but
    // under the cheap-search philosophy that is not flagged; diminishing returns
    // is judged over tokens, not a single search's novelty.
    vi.mocked(searchDriveFiles).mockResolvedValue([file("c1", "f1")]);
    const runState = makeState();
    const context = makeContext();

    await handleSearchTool(context, runState, 0, searchCall("s1", "alpha"));
    const result = await handleSearchTool(context, runState, 1, searchCall("s2", "beta"));

    const payload = JSON.parse(result.content) as { note?: string };
    expect(payload.note).toBeUndefined();
  });

  it("stops searching (not the whole run) when the search backstop is reached", async () => {
    vi.mocked(searchDriveFiles).mockReset();
    vi.mocked(searchDriveFiles).mockResolvedValue([file("c1", "f1")]);
    const runState = makeState({ searchCallCount: 50 });
    const context = makeContext();

    const result = await handleSearchTool(context, runState, 0, searchCall("s1", "alpha"));

    const payload = JSON.parse(result.content) as { skipped?: boolean; reason?: string };
    expect(payload.skipped).toBe(true);
    expect(searchDriveFiles).not.toHaveBeenCalled();
    // The search backstop stops searching but does not wind down the whole run.
    expect(runState.stopSearchingReason).not.toBeNull();
    expect(runState.windDownReason).toBeNull();
  });

  it("nudges the model to vary terms when it repeats the exact same query (H3)", async () => {
    vi.mocked(searchDriveFiles).mockReset();
    vi.mocked(searchDriveFiles).mockResolvedValue([file("c1", "f1")]);
    const runState = makeState();
    const context = makeContext();

    await handleSearchTool(context, runState, 0, searchCall("s1", "Airwallex feedback"));
    // Same query up to case/whitespace normalization => treated as a repeat.
    const repeat = await handleSearchTool(
      context,
      runState,
      1,
      searchCall("s2", "airwallex   FEEDBACK")
    );

    const payload = JSON.parse(repeat.content) as { files?: unknown[]; note?: string };
    expect(payload.note).toContain("exact query you already ran");
    // The files are still returned (consistent), just with the corrective note.
    expect(payload.files).toHaveLength(1);
  });

  it("nudges when a query matches no files at all", async () => {
    vi.mocked(searchDriveFiles).mockReset();
    vi.mocked(searchDriveFiles).mockResolvedValue([]);
    const runState = makeState();

    const result = await handleSearchTool(makeContext(), runState, 0, searchCall("s1", "zzz"));

    const payload = JSON.parse(result.content) as { files?: unknown[]; note?: string };
    expect(payload.files).toHaveLength(0);
    expect(payload.note).toContain("matched no files");
  });
});
