// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  debugText,
  hashForDebug,
  isDebugContentLogEnabled,
  isDebugLogEnabled,
  isDebugTranscriptLogEnabled
} from "@/lib/debug-log";

// debug-log.ts reads DEBUG_LOGS / DEBUG_LOG_CONTENT / DEBUG_LOG_TRANSCRIPT /
// NODE_ENV lazily (inside the functions), so stubbing per-test is sufficient.
// Restore the real env after each test.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isDebugLogEnabled", () => {
  it("is off when the flag is unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEBUG_LOGS", "");
    expect(isDebugLogEnabled()).toBe(false);
  });

  it("can be enabled outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const value of ["1", "true", "TRUE"]) {
      vi.stubEnv("DEBUG_LOGS", value);
      expect(isDebugLogEnabled()).toBe(true);
    }
  });

  it("is forced off in production even when the flag is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEBUG_LOGS", "1");
    expect(isDebugLogEnabled()).toBe(false);
  });
});

describe("isDebugContentLogEnabled", () => {
  it("is off when the flag is unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEBUG_LOG_CONTENT", "");
    expect(isDebugContentLogEnabled()).toBe(false);
  });

  it("can be enabled outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const value of ["1", "true", "TRUE"]) {
      vi.stubEnv("DEBUG_LOG_CONTENT", value);
      expect(isDebugContentLogEnabled()).toBe(true);
    }
  });

  it("is forced off in production even when the flag is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEBUG_LOG_CONTENT", "1");
    expect(isDebugContentLogEnabled()).toBe(false);
  });
});

describe("isDebugTranscriptLogEnabled", () => {
  it("is off when the flag is unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEBUG_LOG_TRANSCRIPT", "");
    expect(isDebugTranscriptLogEnabled()).toBe(false);
  });

  it("can be enabled outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const value of ["1", "true", "TRUE"]) {
      vi.stubEnv("DEBUG_LOG_TRANSCRIPT", value);
      expect(isDebugTranscriptLogEnabled()).toBe(true);
    }
  });

  it("is forced off in production even when the flag is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEBUG_LOG_TRANSCRIPT", "1");
    expect(isDebugTranscriptLogEnabled()).toBe(false);
  });

  it("is independent of DEBUG_LOG_CONTENT", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEBUG_LOG_CONTENT", "1");
    vi.stubEnv("DEBUG_LOG_TRANSCRIPT", "");
    expect(isDebugTranscriptLogEnabled()).toBe(false);

    vi.stubEnv("DEBUG_LOG_CONTENT", "");
    vi.stubEnv("DEBUG_LOG_TRANSCRIPT", "1");
    expect(isDebugTranscriptLogEnabled()).toBe(true);
    expect(isDebugContentLogEnabled()).toBe(false);
  });
});

describe("debugText", () => {
  it("returns metadata only when content logging is disabled", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEBUG_LOG_CONTENT", "");
    const value = "sensitive query text";
    expect(debugText(value)).toEqual({ length: value.length, hash: hashForDebug(value) });
  });

  it("includes a truncated preview when content logging is enabled", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEBUG_LOG_CONTENT", "1");
    const value = "x".repeat(600);
    expect(debugText(value)).toEqual({
      text: value.slice(0, 500),
      length: 600,
      hash: hashForDebug(value)
    });
  });

  it("never includes a preview in production, even with the flag set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEBUG_LOG_CONTENT", "1");
    const value = "sensitive query text";
    const result = debugText(value);
    expect(result).not.toHaveProperty("text");
    expect(result).toEqual({ length: value.length, hash: hashForDebug(value) });
  });
});
