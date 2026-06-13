// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  },
  resolve: {
    alias: {
      "@": resolve(rootDir, ".")
    }
  }
});
