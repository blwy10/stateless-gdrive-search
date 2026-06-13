// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

// crypto.ts reads TOKEN_ENCRYPTION_KEY lazily (inside the functions), not at
// import time, so setting it at module scope before any test body runs is
// enough. Use a deterministic base64-encoded 32-byte key.
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

describe("encryptSecret / decryptSecret", () => {
  it("round-trips plain ASCII", () => {
    const plaintext = "hello world";
    expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
  });

  it("round-trips unicode and long values", () => {
    for (const plaintext of ["héllo 🚀 — ünïcode", "x".repeat(10_000), "a.b.c.d"]) {
      expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
    }
  });

  it("does not support empty plaintext (empty ciphertext segment is rejected)", () => {
    // Encrypting "" yields an empty base64 ciphertext segment, which
    // decryptSecret treats as a malformed payload. This is acceptable because
    // every secret we store (API keys, refresh tokens) is non-empty, but the
    // behaviour is asserted here so it is not mistaken for a silent data loss.
    expect(() => decryptSecret(encryptSecret(""))).toThrow("Invalid encrypted secret payload");
  });

  it("emits an iv.tag.ciphertext payload of three base64 parts", () => {
    const parts = encryptSecret("payload").split(".");
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part).toMatch(/^[A-Za-z0-9+\/]+=*$/);
    }
  });

  it("uses a fresh iv so ciphertext is non-deterministic", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects malformed payloads", () => {
    expect(() => decryptSecret("not-a-payload")).toThrow("Invalid encrypted secret payload");
    expect(() => decryptSecret("only.two")).toThrow("Invalid encrypted secret payload");
  });

  it("rejects tampered ciphertext (GCM authentication)", () => {
    const [iv, tag, ciphertext] = encryptSecret("authentic").split(".");
    const flipped = ciphertext[0] === "A" ? "B" : "A";
    const tampered = [iv, tag, flipped + ciphertext.slice(1)].join(".");
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
