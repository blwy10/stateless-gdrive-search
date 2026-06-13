// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  curatedResultFiles,
  dispatchToolCall,
  handleKeepFileTool,
  handleOpenFileTool,
  handleSearchTool,
  isRetryableModelStatus,
  parseFinalAnswer,
  type AgentProgress,
  type AgentRunContext,
  type AgentRunState
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
    ...overrides
  };
}

function makeState(overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    referencedFiles: [],
    openedFiles: [],
    keptFiles: [],
    searchedQueries: new Set<string>(),
    knownFileKeys: new Set<string>(),
    openedFileKeys: new Set<string>(),
    keptFileKeys: new Set<string>(),
    searchCallCount: 0,
    openFileCallCount: 0,
    lowProgressSearchCount: 0,
    stopAfterToolUseReason: null,
    ...overrides
  };
}

function keepCall(id: string, connectionId: string, fileId: string) {
  return {
    id,
    type: "function" as const,
    function: {
      name: "keep_file" as const,
      arguments: JSON.stringify({ connectionId, fileId })
    }
  };
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

describe("curatedResultFiles", () => {
  it("returns the kept files (de-duplicated) when any were kept", () => {
    const kept = [file("c1", "a"), file("c1", "a"), file("c2", "b")];
    const opened = [file("c1", "a"), file("c2", "b"), file("c3", "c")];
    expect(curatedResultFiles(kept, opened)).toEqual({
      files: [file("c1", "a"), file("c2", "b")],
      fallback: false
    });
  });

  it("falls back to the reviewed files when nothing was kept", () => {
    const opened = [file("c1", "a"), file("c1", "a"), file("c2", "b")];
    expect(curatedResultFiles([], opened)).toEqual({
      files: [file("c1", "a"), file("c2", "b")],
      fallback: true
    });
  });

  it("returns an empty list (no fallback) when nothing was kept or opened", () => {
    expect(curatedResultFiles([], [])).toEqual({ files: [], fallback: false });
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

  it("emits a provisional 'reviewing' event and skips referencedFiles when curating", async () => {
    vi.mocked(openDriveFile).mockResolvedValue({
      file: file("c1", "f1", "Doc"),
      content: "hello world"
    });
    const runState = makeState();
    const events: AgentProgress[] = [];
    const context = makeContext({
      input: { query: "q", mode: "list", driveIds: ["c1"], curateList: true },
      emit: (event) => {
        events.push(event);
      }
    });

    await handleOpenFileTool(context, runState, 0, openCall("call-3"));

    // Opening only stages a candidate when curating: it must NOT become a result
    // (that happens via keep_file), so no "file" event and nothing referenced.
    expect(runState.openedFiles).toHaveLength(1);
    expect(runState.referencedFiles).toHaveLength(0);
    expect(events.some((event) => event.type === "reviewing")).toBe(true);
    expect(events.some((event) => event.type === "file")).toBe(false);
  });
});

describe("handleKeepFileTool", () => {
  it("keeps an opened file and emits a 'kept' event", async () => {
    const opened = file("c1", "f1", "Doc");
    const runState = makeState({ openedFiles: [opened] });
    const events: AgentProgress[] = [];
    const context = makeContext({
      input: { query: "q", mode: "list", driveIds: ["c1"], curateList: true },
      emit: (event) => {
        events.push(event);
      }
    });

    const result = await handleKeepFileTool(context, runState, 0, keepCall("k1", "c1", "f1"));

    const payload = JSON.parse(result.content) as { kept?: boolean };
    expect(payload.kept).toBe(true);
    expect(runState.keptFiles).toEqual([opened]);
    expect(events).toContainEqual({ type: "kept", file: opened });
  });

  it("rejects keeping a file that was never opened, without throwing", async () => {
    const runState = makeState();

    const result = await handleKeepFileTool(
      makeContext(),
      runState,
      0,
      keepCall("k2", "c1", "ghost")
    );

    const payload = JSON.parse(result.content) as { error?: boolean; message?: string };
    expect(payload.error).toBe(true);
    expect(payload.message).toContain("open_file");
    expect(runState.keptFiles).toHaveLength(0);
  });

  it("is idempotent: keeping the same file twice records it once", async () => {
    const opened = file("c1", "f1", "Doc");
    const runState = makeState({ openedFiles: [opened] });

    await handleKeepFileTool(makeContext(), runState, 0, keepCall("k3", "c1", "f1"));
    const second = await handleKeepFileTool(makeContext(), runState, 0, keepCall("k4", "c1", "f1"));

    const payload = JSON.parse(second.content) as { kept?: boolean; alreadyKept?: boolean };
    expect(payload.kept).toBe(true);
    expect(payload.alreadyKept).toBe(true);
    expect(runState.keptFiles).toHaveLength(1);
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
