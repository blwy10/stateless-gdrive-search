// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { NextRequest, NextResponse } from "next/server";
import { requireSession, withAuth } from "@/lib/auth";
import { deleteDriveConnection, listDriveConnections } from "@/lib/drive-connections";

export const GET = withAuth(async () => {
  const session = await requireSession();
  return NextResponse.json({ connections: await listDriveConnections(session.user.id) });
});

export const DELETE = withAuth(async (request: NextRequest) => {
  const session = await requireSession();
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing connection id" }, { status: 400 });
  }
  await deleteDriveConnection(session.user.id, id);
  return NextResponse.json({ ok: true });
});
