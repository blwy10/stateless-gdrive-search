// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assistantTurnMessage,
  dispatchToolCall,
  extractReasoningContent,
  handleOpenFileTool,
  handleReviewFileTool,
  handleSearchTool,
  isRetryableModelStatus,
  modelEventPrefix,
  parseFinalAnswer,
  parseGradeResponse,
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

describe("parseGradeResponse", () => {
  it("parses a clean JSON verdict", () => {
    expect(parseGradeResponse('{"relevant": true, "reason": "matches the query"}')).toEqual({
      relevant: true,
      reason: "matches the query"
    });
    expect(parseGradeResponse('{"relevant": false, "reason": "off topic"}')).toEqual({
      relevant: false,
      reason: "off topic"
    });
  });

  it("extracts the JSON object when wrapped in code fences or prose", () => {
    expect(
      parseGradeResponse('```json\n{"relevant": true, "reason": "ok"}\n```')
    ).toEqual({ relevant: true, reason: "ok" });
    expect(
      parseGradeResponse('Sure! Here is my verdict: {"relevant": false, "reason": "no"} done.')
    ).toEqual({ relevant: false, reason: "no" });
  });

  it("reads relevance leniently (string yes/true)", () => {
    expect(parseGradeResponse('{"relevant": "yes", "reason": "r"}').relevant).toBe(true);
    expect(parseGradeResponse('{"relevant": "false", "reason": "r"}').relevant).toBe(false);
  });

  it("supplies a default reason when the model omits one", () => {
    expect(parseGradeResponse('{"relevant": true}')).toEqual({
      relevant: true,
      reason: "Judged relevant."
    });
  });

  it("defaults to keeping the file when the reply cannot be parsed", () => {
    const verdict = parseGradeResponse("not json at all");
    expect(verdict.relevant).toBe(true);
    expect(verdict.reason).toContain("could not be parsed");
    expect(parseGradeResponse(null).relevant).toBe(true);
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

describe("dispatchToolCall", () => {
  beforeEach(() => {
    vi.mocked(openDriveFile).mockReset();
    vi.mocked(searchDriveFiles).mockReset();
  });

  it("answers an unknown tool name with a recoverable observation", async () => {
    const runState = makeState();
    // The wire type constrains tool names, but the model can emit anything; cast
    // to simulate a hallucinated tool the contract forbids. Leaving it
    // unanswered would corrupt the next request and abort the run.
    const unknownCall = {
      id: "call-unknown",
      type: "function" as const,
      function: { name: "delete_everything", arguments: "{}" }
    } as unknown as Parameters<typeof dispatchToolCall>[3];

    const result = await dispatchToolCall(makeContext(), runState, 0, unknownCall);

    expect(result.role).toBe("tool");
    expect(result.tool_call_id).toBe("call-unknown");
    const payload = JSON.parse(result.content) as { error?: boolean; message?: string };
    expect(payload.error).toBe(true);
    expect(payload.message).toContain('Unknown tool "delete_everything"');
    expect(payload.message).toContain("search_drive");
    expect(openDriveFile).not.toHaveBeenCalled();
    expect(searchDriveFiles).not.toHaveBeenCalled();
  });

  it("routes a known tool name to its handler", async () => {
    vi.mocked(openDriveFile).mockResolvedValue({
      file: file("c1", "f1", "Doc"),
      content: "hi"
    });
    const runState = makeState();
    const openCall = {
      id: "call-route",
      type: "function" as const,
      function: {
        name: "open_file" as const,
        arguments: JSON.stringify({ connectionId: "c1", fileId: "f1" })
      }
    };

    const result = await dispatchToolCall(makeContext(), runState, 0, openCall);

    const payload = JSON.parse(result.content) as { content?: string };
    expect(payload.content).toBe("hi");
    expect(openDriveFile).toHaveBeenCalledTimes(1);
  });

  it("routes review_file to its handler in curated mode", async () => {
    vi.mocked(openDriveFile).mockResolvedValue({
      file: file("c1", "f1", "Doc"),
      content: "hi"
    });
    const runState = makeState();
    const gradeFile = vi.fn(async () => ({ relevant: true, reason: "ok" }));
    const context = curatedContext({ gradeFile });

    const result = await dispatchToolCall(context, runState, 0, reviewCall("route-review"));

    const payload = JSON.parse(result.content) as { reviewed?: boolean; kept?: boolean };
    expect(payload.reviewed).toBe(true);
    expect(payload.kept).toBe(true);
    expect(gradeFile).toHaveBeenCalledTimes(1);
  });
});

describe("isRetryableModelStatus", () => {
  it("retries 5xx and 429 but not 4xx or success", () => {
    for (const status of [500, 502, 503, 504, 429]) {
      expect(isRetryableModelStatus(status), String(status)).toBe(true);
    }
    for (const status of [200, 400, 401, 403, 404, 422]) {
      expect(isRetryableModelStatus(status), String(status)).toBe(false);
    }
  });
});

describe("modelEventPrefix", () => {
  it("logs grader calls under a namespace distinct from the main agent", () => {
    // The whole point: a grader model call and a main-agent model call share a
    // requestId and step, so the debug-log event prefix is what keeps them
    // distinguishable in a transcript.
    expect(modelEventPrefix("agent")).toBe("agent.model");
    expect(modelEventPrefix("grader")).toBe("agent.grade");
    expect(modelEventPrefix("grader")).not.toBe(modelEventPrefix("agent"));
  });
});

describe("extractReasoningContent", () => {
  it("returns reasoning_content when the provider supplies it", () => {
    // Fireworks/DeepSeek/vLLM style: chain-of-thought in reasoning_content
    // (on a tool-call turn `content` would be null, hence the dedicated field).
    expect(extractReasoningContent({ reasoning_content: "step by step" })).toBe("step by step");
  });

  it("falls back to reasoning when reasoning_content is absent or null", () => {
    // OpenRouter style: chain-of-thought in reasoning.
    expect(extractReasoningContent({ reasoning: "thinking" })).toBe("thinking");
    expect(extractReasoningContent({ reasoning_content: null, reasoning: "thinking" })).toBe(
      "thinking"
    );
  });

  it("prefers reasoning_content over reasoning when both are present", () => {
    expect(
      extractReasoningContent({ reasoning_content: "primary", reasoning: "secondary" })
    ).toBe("primary");
  });

  it("returns null when neither field is present or the message is missing", () => {
    // A non-reasoning model's turn carries no reasoning_content/reasoning at all.
    expect(extractReasoningContent({})).toBeNull();
    expect(extractReasoningContent({ reasoning_content: null, reasoning: null })).toBeNull();
    expect(extractReasoningContent(undefined)).toBeNull();
  });

  it("preserves an empty-string reasoning rather than collapsing it to null", () => {
    // "" is a real (if empty) value, distinct from a missing field; nullish
    // coalescing must not skip it, so reasoningContentLength stays an honest 0.
    expect(extractReasoningContent({ reasoning_content: "" })).toBe("");
  });
});

describe("assistantTurnMessage", () => {
  const searchCall = {
    id: "call-1",
    type: "function" as const,
    function: { name: "search_drive" as const, arguments: "{}" }
  };

  it("replays reasoning_content so the model keeps thinking across tool calls", () => {
    // The core of the fix (Fireworks interleaved thinking): the prior turn's
    // chain-of-thought must be sent back or the model re-reasons from scratch
    // after every tool result. On a tool-call turn `content` is null, so
    // reasoning_content is the only place the rationale lives.
    expect(
      assistantTurnMessage({
        role: "assistant",
        content: null,
        reasoning_content: "first I'll search",
        tool_calls: [searchCall]
      })
    ).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [searchCall],
      reasoning_content: "first I'll search"
    });
  });

  it("normalises a provider's `reasoning` field back to reasoning_content", () => {
    // OpenRouter-style reasoning is re-emitted under the field Fireworks reads,
    // so a turn round-trips no matter which field name the provider returned.
    const replayed = assistantTurnMessage({
      role: "assistant",
      content: "done",
      reasoning: "openrouter-style"
    });
    expect(replayed.reasoning_content).toBe("openrouter-style");
  });

  it("omits reasoning_content when the turn has none", () => {
    // A non-reasoning model's turn carries no rationale; the field must be left
    // off entirely rather than sent as null, so it is never sent where it would
    // be meaningless (and providers that never return it stay untouched).
    const replayed = assistantTurnMessage({ role: "assistant", content: "hi" });
    expect("reasoning_content" in replayed).toBe(false);
    expect(replayed.content).toBe("hi");
  });

  it("preserves an empty-string reasoning rather than dropping it", () => {
    // "" is a real value distinct from a missing field (matches
    // extractReasoningContent), so it is replayed rather than omitted.
    const replayed = assistantTurnMessage({
      role: "assistant",
      content: null,
      reasoning_content: ""
    });
    expect(replayed.reasoning_content).toBe("");
  });
});
