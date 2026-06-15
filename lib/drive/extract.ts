// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import JSZip from "jszip";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export async function extractPdfText(buffer: Buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

export async function extractPptxText(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const chunks: string[] = [];
  for (const path of slidePaths) {
    const xml = await zip.files[path].async("text");
    const text = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)]
      .map((match) =>
        match[1]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
      )
      .join(" ");
    if (text.trim()) chunks.push(text);
  }
  return chunks.join("\n\n");
}

function xmlText(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export async function extractXlsxText(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const sharedStringsXml = zip.files["xl/sharedStrings.xml"]
    ? await zip.files["xl/sharedStrings.xml"].async("text")
    : "";
  const sharedStrings = [...sharedStringsXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((textMatch) => xmlText(textMatch[1]))
      .join("")
  );

  const sheetNames = new Map<string, string>();
  if (zip.files["xl/workbook.xml"]) {
    const workbookXml = await zip.files["xl/workbook.xml"].async("text");
    for (const match of workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*sheetId="([^"]+)"/g)) {
      sheetNames.set(`xl/worksheets/sheet${match[2]}.xml`, xmlText(match[1]));
    }
  }

  const sheetPaths = Object.keys(zip.files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const chunks: string[] = [];
  for (const path of sheetPaths) {
    const xml = await zip.files[path].async("text");
    const rows: string[] = [];
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map(
        (cellMatch) => {
          const attrs = cellMatch[1];
          const cellXml = cellMatch[2];
          const inline = cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
          if (inline) return xmlText(inline);
          const raw = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
          if (attrs.includes('t="s"')) return sharedStrings[Number(raw)] ?? "";
          return xmlText(raw);
        }
      );
      if (cells.some(Boolean)) rows.push(cells.join(","));
    }
    chunks.push(`Sheet: ${sheetNames.get(path) ?? path}\n${rows.join("\n")}`);
  }
  return chunks.join("\n\n");
}

/** Extract raw text from a Word .docx/.doc buffer via mammoth. */
export async function extractDocxText(buffer: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}
