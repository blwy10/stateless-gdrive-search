// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  serverExternalPackages: ["pdf-parse", "mammoth", "xlsx", "jszip"]
};

export default nextConfig;
