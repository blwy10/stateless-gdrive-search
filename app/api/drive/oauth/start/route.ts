import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { createDriveOAuthUrl } from "@/lib/google-oauth";

export async function GET() {
  const session = await requireSession();
  const url = await createDriveOAuthUrl(session.user.id);
  return NextResponse.redirect(url);
}
