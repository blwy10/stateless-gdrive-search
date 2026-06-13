import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { deleteDriveConnection, listDriveConnections } from "@/lib/drive-connections";

export async function GET() {
  const session = await requireSession();
  return NextResponse.json({ connections: await listDriveConnections(session.user.id) });
}

export async function DELETE(request: NextRequest) {
  const session = await requireSession();
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing connection id" }, { status: 400 });
  }
  await deleteDriveConnection(session.user.id, id);
  return NextResponse.json({ ok: true });
}
