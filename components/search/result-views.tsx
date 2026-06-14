// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import { MarkdownContent } from "@/components/markdown";
import { formatMimeType } from "@/lib/file-types";
import type { DriveFile } from "@/hooks/use-query-sessions";

export function FileList({ files }: { files: DriveFile[] }) {
  return (
    <ul className="file-list">
      {files.map((file) => (
        <li className="file-card" key={`${file.connectionId}:${file.id}`}>
          {file.webViewLink ? (
            <a href={file.webViewLink} target="_blank" rel="noreferrer">
              {file.name}
            </a>
          ) : (
            <strong>{file.name}</strong>
          )}
          <span className="muted">Drive account: {file.driveEmail}</span>
          <span className="muted">Type: {formatMimeType(file.mimeType)}</span>
        </li>
      ))}
    </ul>
  );
}

export function AnswerView({ answer, format }: { answer: string; format: "markdown" | "plain" }) {
  if (format === "markdown") {
    return (
      <div className="answer markdown-answer">
        <MarkdownContent>{answer}</MarkdownContent>
      </div>
    );
  }
  return <div className="answer">{answer}</div>;
}
