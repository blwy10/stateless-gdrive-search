// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

export function formatDateTime(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

export function downloadAnswer(answer: string, format: "markdown" | "plain", query: string) {
  const extension = format === "markdown" ? "md" : "txt";
  const mimeType = format === "markdown" ? "text/markdown" : "text/plain";
  const slug = query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const filename = `${slug || "answer"}.${extension}`;
  const blob = new Blob([answer], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
