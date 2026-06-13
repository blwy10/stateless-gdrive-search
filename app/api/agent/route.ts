// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { NextRequest } from "next/server";
import { ZodError } from "zod";
import { requireSession, withAuth } from "@/lib/auth";
import { parseAgentRequest, runDriveAgent, type AgentProgress } from "@/lib/agent";
import {
  CONCURRENCY_RETRY_AFTER_SECONDS,
  getAgentConcurrencyLimiter,
  getAgentRateLimiter
} from "@/lib/rate-limit";

function encodeSse(event: AgentProgress) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function tooManyRequests(message: string, retryAfterSeconds: number) {
  return new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSeconds)
    }
  });
}

function badRequest(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": "application/json" }
  });
}

function errorMessage(error: unknown) {
  if (error instanceof ZodError) {
    return error.issues[0]?.message ?? "Invalid agent request";
  }
  if (error instanceof Error) return error.message;
  return "Invalid agent request";
}

export const POST = withAuth(async (request: NextRequest) => {
  const session = await requireSession();
  const ownerSub = session.user.id;

  // Abuse protection. Each run fans out to a paid AI API and Google Drive, and
  // holds an open SSE stream, so an authenticated user must not be able to spam
  // this endpoint. The token bucket bounds how often a user can start runs; the
  // concurrency cap bounds how many they can run at once. See lib/rate-limit.ts.
  const rateDecision = getAgentRateLimiter().take(ownerSub);
  if (!rateDecision.allowed) {
    return tooManyRequests(
      "Too many requests. Please wait a moment before searching again.",
      rateDecision.retryAfterSeconds
    );
  }

  let input: ReturnType<typeof parseAgentRequest>;
  try {
    input = parseAgentRequest(await request.json());
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const concurrency = getAgentConcurrencyLimiter();
  if (!concurrency.tryAcquire(ownerSub)) {
    return tooManyRequests(
      "You already have the maximum number of searches running. Let one finish first.",
      CONCURRENCY_RETRY_AFTER_SECONDS
    );
  }

  const encoder = new TextEncoder();
  // The slot is held for the lifetime of the run and released exactly once when
  // the run settles (success or error). Guarded so we never double-release.
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    concurrency.release(ownerSub);
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AgentProgress) => {
        // Swallow enqueue errors: if the client disconnected the stream is
        // already closed, but we still need the run to settle and free its slot.
        try {
          controller.enqueue(encoder.encode(encodeSse(event)));
        } catch {
          // no-op: consumer is gone
        }
      };

      try {
        await runDriveAgent(ownerSub, input, emit);
      } catch (error) {
        emit({
          type: "error",
          message: error instanceof Error ? error.message : "Unknown agent error"
        });
      } finally {
        releaseSlot();
        try {
          controller.close();
        } catch {
          // no-op: stream may already be closed if the consumer disconnected
        }
      }
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
});
