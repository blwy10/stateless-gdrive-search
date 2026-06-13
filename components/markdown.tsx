// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

// remark-gfm: tables, strikethrough, task lists, autolinks.
const remarkPlugins = [remarkGfm];
// rehype-raw parses inline HTML (e.g. <br> inside table cells); rehype-sanitize
// must run afterwards so that raw HTML is restricted to the safe default schema
// (drops <script>, style/event-handler attributes, javascript: URLs, ...).
const rehypePlugins = [rehypeRaw, rehypeSanitize];

// Answers render inside a card that already sits below the page chrome, so map
// the document headings down to h3-h5 (matching the .markdown-answer styles)
// and keep the horizontal-scroll wrapper around wide tables.
const components: Components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  h1: ({ node, ...props }) => <h3 {...props} />,
  h2: ({ node, ...props }) => <h4 {...props} />,
  h3: ({ node, ...props }) => <h5 {...props} />,
  h4: ({ node, ...props }) => <h5 {...props} />,
  h5: ({ node, ...props }) => <h5 {...props} />,
  h6: ({ node, ...props }) => <h5 {...props} />,
  table: ({ node, ...props }) => (
    <div className="markdown-table-wrap">
      <table {...props} />
    </div>
  )
};

export function MarkdownContent({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}
