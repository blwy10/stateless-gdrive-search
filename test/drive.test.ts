// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { escapeDriveQuery } from "@/lib/drive";

describe("escapeDriveQuery", () => {
  it("leaves ordinary text untouched", () => {
    expect(escapeDriveQuery("annual report 2024")).toBe("annual report 2024");
    expect(escapeDriveQuery("")).toBe("");
  });

  it("escapes single quotes so they cannot terminate a Drive query string", () => {
    // a single quote becomes \'
    expect(escapeDriveQuery("O'Hara")).toBe("O\\'Hara");
  });

  it("doubles backslashes", () => {
    // one backslash becomes two
    expect(escapeDriveQuery("a\\b")).toBe("a\\\\b");
  });

  it("escapes backslashes before quotes (order matters)", () => {
    // input: backslash + quote  ->  \\ (doubled) then \' (escaped) => \\\'
    expect(escapeDriveQuery("\\'")).toBe("\\\\\\'");
  });

  it("escapes every occurrence", () => {
    expect(escapeDriveQuery("'a'b'")).toBe("\\'a\\'b\\'");
  });
});
