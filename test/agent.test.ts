// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { curatedListFiles, parseFinalAnswer } from "@/lib/agent";
import type { DriveFile } from "@/lib/drive";

function file(connectionId: string, id: string, name = id): DriveFile {
  return {
    connectionId,
    id,
    name,
    driveEmail: `${connectionId}@example.com`,
    mimeType: "text/plain"
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

describe("curatedListFiles", () => {
  const opened = [file("c1", "a"), file("c1", "b"), file("c2", "a")];

  it("returns all opened files (de-duplicated) when there is no curated marker", () => {
    const withDupes = [file("c1", "a"), file("c1", "a"), file("c2", "a")];
    expect(curatedListFiles("no marker here", withDupes)).toEqual([
      file("c1", "a"),
      file("c2", "a")
    ]);
    expect(curatedListFiles(null, opened)).toEqual(opened);
  });

  it("selects the curated subset, preserving order via fileId", () => {
    const content = 'CURATED_FILE_LIST: [{"connectionId":"c2","fileId":"a"},{"connectionId":"c1","fileId":"a"}]';
    expect(curatedListFiles(content, opened)).toEqual([file("c2", "a"), file("c1", "a")]);
  });

  it("accepts the `id` field as an alias for `fileId`", () => {
    const content = 'CURATED_FILE_LIST: [{"connectionId":"c1","id":"b"}]';
    expect(curatedListFiles(content, opened)).toEqual([file("c1", "b")]);
  });

  it("drops selections that were never opened and de-duplicates", () => {
    const content =
      'CURATED_FILE_LIST: [{"connectionId":"c1","fileId":"b"},{"connectionId":"c1","fileId":"ghost"},{"connectionId":"c1","fileId":"b"}]';
    expect(curatedListFiles(content, opened)).toEqual([file("c1", "b")]);
  });

  it("works when the marker is preceded by other prose", () => {
    const content = 'Here is my curated list.\nCURATED_FILE_LIST: [{"connectionId":"c1","fileId":"a"}]';
    expect(curatedListFiles(content, opened)).toEqual([file("c1", "a")]);
  });

  it("falls back to all opened files on invalid JSON or schema", () => {
    expect(curatedListFiles("CURATED_FILE_LIST: [oops]", opened)).toEqual(opened);
    expect(curatedListFiles('CURATED_FILE_LIST: [{"connectionId":""}]', opened)).toEqual(opened);
  });
});
