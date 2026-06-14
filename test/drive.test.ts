// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import {
  MAX_FILE_CHARS,
  MIN_SUMMARY_CHARS,
  buildDriveSearchQuery,
  emptyExtractionNote,
  escapeDriveQuery,
  resolveFileContent,
  type DriveFile
} from "@/lib/drive";

function driveFile(overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    connectionId: "c1",
    driveEmail: "c1@example.com",
    id: "f1",
    name: "Doc.txt",
    mimeType: "text/plain",
    ...overrides
  };
}

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

describe("buildDriveSearchQuery", () => {
  it("keeps a single-word query as one name/fullText pair (unchanged behaviour)", () => {
    expect(buildDriveSearchQuery("Airwallex")).toBe(
      "trashed = false and (name contains 'Airwallex' or fullText contains 'Airwallex')"
    );
  });

  it("trims surrounding whitespace before matching", () => {
    expect(buildDriveSearchQuery("  Airwallex  ")).toBe(
      "trashed = false and (name contains 'Airwallex' or fullText contains 'Airwallex')"
    );
  });

  it("matches ANY term for a multi-word query so partial matches survive (H1)", () => {
    // The whole point: a doc named "Airwallex Reflection" (no "feedback") must
    // still be reachable from the query "Airwallex feedback".
    expect(buildDriveSearchQuery("Airwallex feedback")).toBe(
      "trashed = false and (" +
        "name contains 'Airwallex' or fullText contains 'Airwallex'" +
        " or name contains 'feedback' or fullText contains 'feedback'" +
        ")"
    );
  });

  it("collapses arbitrary internal whitespace between terms", () => {
    expect(buildDriveSearchQuery("Airwallex\t  feedback")).toBe(
      buildDriveSearchQuery("Airwallex feedback")
    );
  });

  it("escapes each term independently", () => {
    expect(buildDriveSearchQuery("O'Hara report")).toBe(
      "trashed = false and (" +
        "name contains 'O\\'Hara' or fullText contains 'O\\'Hara'" +
        " or name contains 'report' or fullText contains 'report'" +
        ")"
    );
  });

  it("dedupes repeated terms case-insensitively", () => {
    expect(buildDriveSearchQuery("report Report")).toBe(
      "trashed = false and (name contains 'report' or fullText contains 'report')"
    );
  });

  it("caps the number of terms so a pathological query stays bounded", () => {
    const manyTerms = Array.from({ length: 30 }, (_, i) => `t${i}`).join(" ");
    const q = buildDriveSearchQuery(manyTerms);
    // 12 terms max, each contributing a name+fullText pair => 24 "contains".
    expect((q.match(/contains/g) ?? []).length).toBe(24);
    expect(q).toContain("name contains 't0'");
    expect(q).toContain("name contains 't11'");
    expect(q).not.toContain("name contains 't12'");
  });
});

describe("emptyExtractionNote", () => {
  it("states that no text was extracted and names the file", () => {
    const note = emptyExtractionNote({ name: "Scan.pdf" });
    expect(note).toContain("No readable text");
    expect(note).toContain("Scan.pdf");
  });

  it("appends a Drive link when webViewLink is present", () => {
    const note = emptyExtractionNote({
      name: "Scan.pdf",
      webViewLink: "https://drive.example/abc"
    });
    expect(note).toContain("Open it in Drive");
    expect(note).toContain("https://drive.example/abc");
  });

  it("omits the link clause when there is no webViewLink", () => {
    expect(emptyExtractionNote({ name: "Empty.txt" })).not.toContain("Open it in Drive");
  });
});

describe("resolveFileContent", () => {
  const oversize = "x".repeat(MAX_FILE_CHARS + 500);

  it("returns content unchanged when within the cap (full)", async () => {
    const result = await resolveFileContent({ normalized: "hello", file: driveFile() });
    expect(result.disposition).toBe("full");
    expect(result.content).toBe("hello");
  });

  it("returns an empty-extraction note for empty content (empty)", async () => {
    const result = await resolveFileContent({
      normalized: "",
      file: driveFile({ name: "Scan.pdf" })
    });
    expect(result.disposition).toBe("empty");
    expect(result.content).toContain("No readable text");
    expect(result.content).toContain("Scan.pdf");
  });

  it("hard-truncates oversize content when no summarizer hook is given (truncated)", async () => {
    const result = await resolveFileContent({ normalized: oversize, file: driveFile() });
    expect(result.disposition).toBe("truncated");
    expect(result.content).toContain(`[Truncated at ${MAX_FILE_CHARS} characters]`);
    expect(result.content.startsWith("x".repeat(MAX_FILE_CHARS))).toBe(true);
  });

  it("uses the summarizer's output for oversize content when it meets the floor (summarized)", async () => {
    const summary = "S".repeat(MIN_SUMMARY_CHARS);
    const result = await resolveFileContent({
      normalized: oversize,
      file: driveFile(),
      summarizeOversize: async () => summary
    });
    expect(result.disposition).toBe("summarized");
    expect(result.content).toBe(summary);
  });

  it("falls back to truncation when the summary is implausibly short (over-compressed)", async () => {
    // A summary below MIN_SUMMARY_CHARS is treated as pathological over-compression;
    // truncation preserves more of the document, so it wins.
    const result = await resolveFileContent({
      normalized: oversize,
      file: driveFile(),
      summarizeOversize: async () => "x".repeat(MIN_SUMMARY_CHARS - 1)
    });
    expect(result.disposition).toBe("truncated");
    expect(result.content).toContain(`[Truncated at ${MAX_FILE_CHARS} characters]`);
  });

  it("re-caps a summary that itself overshoots the budget", async () => {
    const overshoot = "y".repeat(MAX_FILE_CHARS + 1000);
    const result = await resolveFileContent({
      normalized: oversize,
      file: driveFile(),
      summarizeOversize: async () => overshoot
    });
    expect(result.disposition).toBe("summarized");
    expect(result.content).toContain(`[Summary truncated at ${MAX_FILE_CHARS} characters]`);
    expect(result.content.startsWith("y".repeat(MAX_FILE_CHARS))).toBe(true);
  });

  it("falls back to truncation when the summarizer returns null", async () => {
    const result = await resolveFileContent({
      normalized: oversize,
      file: driveFile(),
      summarizeOversize: async () => null
    });
    expect(result.disposition).toBe("truncated");
    expect(result.content).toContain(`[Truncated at ${MAX_FILE_CHARS} characters]`);
  });

  it("falls back to truncation when the summarizer returns blank text", async () => {
    const result = await resolveFileContent({
      normalized: oversize,
      file: driveFile(),
      summarizeOversize: async () => "   "
    });
    expect(result.disposition).toBe("truncated");
  });

  it("never invokes the summarizer for content within the cap", async () => {
    const hook = vi.fn(async () => "should not run");
    const result = await resolveFileContent({
      normalized: "small",
      file: driveFile(),
      summarizeOversize: hook
    });
    expect(hook).not.toHaveBeenCalled();
    expect(result.disposition).toBe("full");
  });
});
