import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { requireSession } from "@/lib/auth";
import {
  deleteModelSettings,
  getModelSettingsSummary,
  parseModelSettingsInput,
  upsertModelSettings
} from "@/lib/model-settings";

export async function GET() {
  const session = await requireSession();
  return NextResponse.json({ settings: await getModelSettingsSummary(session.user.id) });
}

export async function PUT(request: NextRequest) {
  const session = await requireSession();

  try {
    const input = parseModelSettingsInput(await request.json());
    await upsertModelSettings(session.user.id, input);
    return NextResponse.json({ settings: await getModelSettingsSummary(session.user.id) });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}

export async function DELETE() {
  const session = await requireSession();
  await deleteModelSettings(session.user.id);
  return NextResponse.json({ settings: await getModelSettingsSummary(session.user.id) });
}

function errorMessage(error: unknown) {
  if (error instanceof ZodError) {
    return error.issues[0]?.message ?? "Invalid model settings";
  }
  if (error instanceof Error) return error.message;
  return "Invalid model settings";
}
