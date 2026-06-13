import { z } from "zod";
import { listDriveConnections } from "@/lib/drive-connections";
import { openDriveFile, searchDriveFiles, type DriveFile } from "@/lib/drive";
import { env } from "@/lib/env";

const AgentRequest = z.object({
  query: z.string().trim().min(1).max(2000),
  mode: z.enum(["list", "synthesis"]),
  driveIds: z.array(z.string().min(1)).min(1).max(20)
});

type AgentRequest = z.infer<typeof AgentRequest>;

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: "search_drive" | "open_file";
    arguments: string;
  };
};

type ChatCompletion = {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
};

export type AgentProgress =
  | { type: "progress"; message: string }
  | { type: "file"; file: DriveFile }
  | { type: "final"; answer: string; files: DriveFile[] }
  | { type: "error"; message: string };

const searchArgs = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).optional()
});

const openArgs = z.object({
  connectionId: z.string().min(1),
  fileId: z.string().min(1)
});

const tools = [
  {
    type: "function",
    function: {
      name: "search_drive",
      description:
        "Search the user's selected Google Drive connections for files relevant to a query.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A concise Google Drive search query. Try alternate wording when needed."
          },
          limit: {
            type: "number",
            description: "Maximum results per connected Drive, up to 20."
          }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_file",
      description:
        "Open and read a file returned by search_drive. Use the exact connectionId and fileId from search results.",
      parameters: {
        type: "object",
        properties: {
          connectionId: { type: "string" },
          fileId: { type: "string" }
        },
        required: ["connectionId", "fileId"],
        additionalProperties: false
      }
    }
  }
];

function systemPrompt(mode: AgentRequest["mode"], allowedDriveIds: string[]) {
  const answerInstruction =
    mode === "synthesis"
      ? "Return a concise synthesis answering the user's query, followed by the source files you relied on."
      : "Return only a relevant file list. Do not synthesize an answer.";

  return `You are a Google Drive research agent.

You have exactly two tools: search_drive and open_file.
You may only work with these selected Drive connection IDs: ${allowedDriveIds.join(", ")}.
Search using several targeted query variants before deciding there is not enough evidence.
Open files when their titles or snippets appear relevant, especially when synthesis mode is requested.
Never claim you searched outside Google Drive.
Never ask for permissions or tokens.
If evidence is weak, say that directly.
${answerInstruction}`;
}

function safeJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

async function callModel(messages: ChatMessage[]) {
  const response = await fetch(`${env.aiBaseUrl().replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.aiApiKey()}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: env.aiModel(),
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2
    })
  });
  if (!response.ok) {
    throw new Error(`AI request failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as ChatCompletion;
}

function uniqueFiles(files: DriveFile[]) {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.connectionId}:${file.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseAgentRequest(value: unknown) {
  return AgentRequest.parse(value);
}

export async function runDriveAgent(
  ownerSub: string,
  input: AgentRequest,
  emit: (event: AgentProgress) => void | Promise<void>
) {
  const connections = await listDriveConnections(ownerSub);
  const allowed = new Set(connections.map((connection) => connection.id));
  const selectedDriveIds = input.driveIds.includes("all")
    ? connections.map((connection) => connection.id)
    : input.driveIds.filter((id) => allowed.has(id));

  if (selectedDriveIds.length === 0) {
    throw new Error("No connected Drive selected");
  }

  const referencedFiles: DriveFile[] = [];
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(input.mode, selectedDriveIds) },
    {
      role: "user",
      content: `Query: ${input.query}\nMode: ${input.mode}`
    }
  ];

  await emit({
    type: "progress",
    message: `Agent started with ${selectedDriveIds.length} Drive connection(s).`
  });

  for (let step = 0; step < 8; step += 1) {
    const completion = await callModel(messages);
    const message = completion.choices[0]?.message;
    if (!message) {
      throw new Error("AI returned no message");
    }

    messages.push({
      role: "assistant",
      content: message.content,
      tool_calls: message.tool_calls
    });

    if (!message.tool_calls?.length) {
      const answer = message.content?.trim() || "No answer returned.";
      await emit({ type: "final", answer, files: uniqueFiles(referencedFiles) });
      return;
    }

    for (const toolCall of message.tool_calls) {
      if (toolCall.function.name === "search_drive") {
        const args = searchArgs.parse(JSON.parse(toolCall.function.arguments || "{}"));
        await emit({ type: "progress", message: `Searching Drive for "${args.query}"` });
        const files = await searchDriveFiles({
          ownerSub,
          connectionIds: selectedDriveIds,
          query: args.query,
          limit: args.limit
        });
        referencedFiles.push(...files);
        for (const file of files) {
          await emit({ type: "file", file });
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: safeJson({ files })
        });
      } else if (toolCall.function.name === "open_file") {
        const args = openArgs.parse(JSON.parse(toolCall.function.arguments || "{}"));
        if (!selectedDriveIds.includes(args.connectionId)) {
          throw new Error("AI attempted to open a file outside the selected Drive scope");
        }
        await emit({ type: "progress", message: `Opening file ${args.fileId}` });
        const opened = await openDriveFile({
          ownerSub,
          connectionId: args.connectionId,
          fileId: args.fileId
        });
        referencedFiles.push(opened.file);
        await emit({ type: "file", file: opened.file });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: safeJson({
            file: opened.file,
            content: opened.content
          })
        });
      }
    }
  }

  throw new Error("Agent reached the maximum tool-use steps before completing");
}
