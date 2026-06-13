// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
