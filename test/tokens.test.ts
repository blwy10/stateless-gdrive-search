// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { estimateMessagesChars, resolveUsageTokens } from "@/lib/agent/tokens";

describe("resolveUsageTokens", () => {
  it("prefers the provider's totalTokens (already includes reasoning)", () => {
    expect(resolveUsageTokens({ totalTokens: 1234, inputTokens: 1000, outputTokens: 200 })).toBe(1234);
  });

  it("falls back to inputTokens + outputTokens when no total is reported", () => {
    expect(resolveUsageTokens({ inputTokens: 1000, outputTokens: 200 })).toBe(1200);
  });

  it("estimates from output text (chars / 4) only when the provider reports no usage", () => {
    // 40 chars -> 10 tokens.
    expect(resolveUsageTokens(undefined, "x".repeat(40))).toBe(10);
  });

  it("folds the input-char estimate into the no-usage fallback (the regression guard)", () => {
    // The bug was ignoring the input side: an output-only estimate here is 10
    // tokens, but the dominant prompt (4000 chars -> 1000 tokens) must be counted
    // or the token budget guards under-count ~8x and go blind.
    expect(resolveUsageTokens(undefined, "x".repeat(40), 4000)).toBe(1010);
  });

  it("ignores the estimate entirely once any real usage is present", () => {
    expect(resolveUsageTokens({ totalTokens: 5 }, "x".repeat(4000), 4000)).toBe(5);
  });

  it("returns 0 when there is neither usage nor any estimate basis", () => {
    expect(resolveUsageTokens(undefined, "", 0)).toBe(0);
  });
});

describe("estimateMessagesChars", () => {
  it("counts the serialised message content (text, tool-call args, tool results)", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "a long tool result body" }] }
    ];
    expect(estimateMessagesChars(messages)).toBe(JSON.stringify(messages).length);
  });

  it("returns 0 for an unserialisable value so the caller degrades to an output-only estimate", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(estimateMessagesChars(cyclic)).toBe(0);
  });
});
