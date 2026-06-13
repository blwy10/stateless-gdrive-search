import { appendFile, mkdir } from "fs/promises";
import path from "path";
import { createHash, randomUUID } from "crypto";

export type DebugLogEvent = {
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  requestId?: string;
  [key: string]: unknown;
};

function enabled(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true";
}

export function isDebugLogEnabled() {
  return enabled(process.env.DEBUG_LOGS);
}

export function isDebugContentLogEnabled() {
  return enabled(process.env.DEBUG_LOG_CONTENT);
}

export function createDebugRequestId(prefix = "req") {
  return `${prefix}_${randomUUID()}`;
}

export function hashForDebug(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function debugText(value: string) {
  if (isDebugContentLogEnabled()) {
    return {
      text: value.slice(0, 500),
      length: value.length,
      hash: hashForDebug(value)
    };
  }

  return {
    length: value.length,
    hash: hashForDebug(value)
  };
}

export function debugError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message.slice(0, 500)
    };
  }

  return {
    name: "UnknownError",
    message: String(error).slice(0, 500)
  };
}

function logPath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(process.cwd(), ".codex-debug", "logs", `agent-${date}.jsonl`);
}

export async function writeDebugLog(event: DebugLogEvent) {
  if (!isDebugLogEnabled()) return;

  try {
    const file = logPath();
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(
      file,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: event.level ?? "debug",
        ...event
      })}\n`,
      "utf8"
    );
  } catch (error) {
    console.warn("Failed to write debug log", debugError(error));
  }
}
