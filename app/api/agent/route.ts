import { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { parseAgentRequest, runDriveAgent, type AgentProgress } from "@/lib/agent";

function encodeSse(event: AgentProgress) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: NextRequest) {
  let session;
  try {
    session = await requireSession();
  } catch {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const body = await request.json();
  const input = parseAgentRequest(body);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AgentProgress) => {
        controller.enqueue(encoder.encode(encodeSse(event)));
      };

      try {
        await runDriveAgent(session.user.id, input, emit);
      } catch (error) {
        emit({
          type: "error",
          message: error instanceof Error ? error.message : "Unknown agent error"
        });
      } finally {
        controller.close();
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
}
