// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import { signIn } from "next-auth/react";

export function LoginPanel() {
  return (
    <section className="login-panel">
      <div className="login-box">
        <h1>Search your Drive with a bounded agent</h1>
        <p>
          Sign in with Google, connect one or more read-only Drive accounts, then ask a focused
          question.
        </p>
        <button className="button" type="button" onClick={() => signIn("google")}>
          Continue with Google
        </button>
      </div>
    </section>
  );
}
