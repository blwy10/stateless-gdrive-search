// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { formatMimeType } from "@/lib/file-types";

describe("formatMimeType", () => {
  it("returns a placeholder for empty input", () => {
    expect(formatMimeType("")).toBe("Unknown file type");
  });

  it("maps known MIME types to friendly labels", () => {
    expect(formatMimeType("application/pdf")).toBe("PDF");
    expect(formatMimeType("application/vnd.google-apps.document")).toBe("Google Docs document");
    expect(formatMimeType("application/vnd.google-apps.spreadsheet")).toBe(
      "Google Sheets spreadsheet"
    );
    expect(formatMimeType("image/png")).toBe("PNG image");
    expect(formatMimeType("text/plain")).toBe("Plain text");
    expect(
      formatMimeType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
    ).toBe("Word document");
  });

  it("humanizes unknown google-apps subtypes", () => {
    expect(formatMimeType("application/vnd.google-apps.jam")).toBe("Google Jam");
    expect(formatMimeType("application/vnd.google-apps.my-custom_type")).toBe(
      "Google My Custom Type"
    );
  });

  it("builds a label from category + subtype for generic types", () => {
    expect(formatMimeType("audio/mpeg")).toBe("Mpeg audio");
    expect(formatMimeType("video/mp4")).toBe("Mp4 video");
    expect(formatMimeType("application/zip")).toBe("Zip file");
    expect(formatMimeType("image/webp")).toBe("Webp image");
    expect(formatMimeType("text/x-python")).toBe("X Python document");
  });

  it("returns the raw value when it is not a category/subtype pair", () => {
    expect(formatMimeType("notamimetype")).toBe("notamimetype");
    expect(formatMimeType("application/")).toBe("application/");
  });
});
