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

export type AgentBudget = {
  maxToolSteps: number;
  maxSearchCalls: number;
  maxOpenFileCalls: number;
  maxLowProgressSearches: number;
  maxToolRetries: number;
};

export type AgentOptions = {
  budget?: Partial<AgentBudget>;
};

export type AgentProgress =
  | { type: "progress"; message: string }
  | { type: "file"; file: DriveFile }
  | { type: "final"; answer: string; answerFormat: "markdown" | "plain"; files: DriveFile[] }
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

export const defaultAgentBudgets: Record<AgentRequest["mode"], AgentBudget> = {
  list: {
    maxToolSteps: 8,
    maxSearchCalls: 4,
    maxOpenFileCalls: 6,
    maxLowProgressSearches: 2,
    maxToolRetries: 1
  },
  synthesis: {
    maxToolSteps: 8,
    maxSearchCalls: 5,
    maxOpenFileCalls: 8,
    maxLowProgressSearches: 2,
    maxToolRetries: 1
  }
};

export function resolveAgentBudget(
  mode: AgentRequest["mode"],
  override?: Partial<AgentBudget>
): AgentBudget {
  return {
    ...defaultAgentBudgets[mode],
    ...override
  };
}

function systemPrompt(mode: AgentRequest["mode"], allowedDriveIds: string[], budget: AgentBudget) {
  const answerInstruction =
    mode === "synthesis"
      ? `Return a concise synthesis answering the user's query, followed by the source files you relied on.
Your final response must start with exactly one format line:
FORMAT: markdown
or
FORMAT: plain
Then put the answer body after that line.
Use markdown only when headings, lists, links, or other markdown structure materially improve readability.
Never return HTML or any format other than markdown or plain.`
      : `Find relevant files only. Do not synthesize an answer.
When you are done, return exactly:
FORMAT: plain
FILE_LIST_COMPLETE`;

  return `You are a Google Drive research agent.

You have exactly two tools: search_drive and open_file.
You may only work with these selected Drive connection IDs: ${allowedDriveIds.join(", ")}.
Use at most ${budget.maxSearchCalls} search_drive calls.
Use at most ${budget.maxOpenFileCalls} open_file calls.
Search using targeted query variants before deciding there is not enough evidence.
Do not repeat equivalent searches.
Open files when their titles or snippets appear relevant. In list mode, opening files is allowed when needed to judge relevance.
If searches stop producing new relevant files, answer with the evidence found.
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
    const key = fileKey(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fileKey(file: Pick<DriveFile, "connectionId" | "id">) {
  return `${file.connectionId}:${file.id}`;
}

function normalizeSearchQuery(query: string) {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function partialAnswer(reason: string, mode: AgentRequest["mode"]) {
  if (mode === "list") {
    return { answer: "", answerFormat: "plain" as const };
  }

  return {
    answerFormat: "plain" as const,
    answer: `${reason} Returning the files found so far.`
  };
}

function parseFinalAnswer(content: string | null, mode: AgentRequest["mode"]) {
  if (mode === "list") {
    return { answer: "", answerFormat: "plain" as const };
  }

  const raw = content?.trim() || "No answer returned.";
  const match = raw.match(/^FORMAT:\s*(markdown|plain)\s*\n([\s\S]*)$/i);
  if (match) {
    return {
      answerFormat: match[1].toLowerCase() === "markdown" ? ("markdown" as const) : ("plain" as const),
      answer: match[2].trim()
    };
  }

  const likelyMarkdown = /(^|\n)\s*(#{1,6}\s+|[-*]\s+|\d+\.\s+|```|\[[^\]]+\]\([^)]+\))/.test(raw);
  return {
    answerFormat: likelyMarkdown ? ("markdown" as const) : ("plain" as const),
    answer: raw
  };
}

function isRetryableToolError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /\b(408|409|429|500|502|503|504)\b/.test(error.message);
}

async function withToolRetries<T>(
  operation: () => Promise<T>,
  retryCount: number
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= retryCount || !isRetryableToolError(error)) break;
    }
  }
  throw lastError;
}

export function parseAgentRequest(value: unknown) {
  return AgentRequest.parse(value);
}

export async function runDriveAgent(
  ownerSub: string,
  input: AgentRequest,
  emit: (event: AgentProgress) => void | Promise<void>,
  options: AgentOptions = {}
) {
  const budget = resolveAgentBudget(input.mode, options.budget);
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
    { role: "system", content: systemPrompt(input.mode, selectedDriveIds, budget) },
    {
      role: "user",
      content: `Query: ${input.query}\nMode: ${input.mode}`
    }
  ];
  const searchedQueries = new Set<string>();
  const knownFileKeys = new Set<string>();
  const openedFileKeys = new Set<string>();
  let searchCallCount = 0;
  let openFileCallCount = 0;
  let lowProgressSearchCount = 0;
  let stopAfterToolUseReason: string | null = null;
  let stopInstructionSent = false;

  await emit({
    type: "progress",
    message: `Agent started with ${selectedDriveIds.length} Drive connection(s).`
  });

  for (let step = 0; step < budget.maxToolSteps; step += 1) {
    if (stopAfterToolUseReason && !stopInstructionSent) {
      messages.push({
        role: "user",
        content: `${stopAfterToolUseReason} Stop using tools and return the final result now.`
      });
      stopInstructionSent = true;
    }

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
      const { answer, answerFormat } = parseFinalAnswer(message.content, input.mode);
      await emit({ type: "final", answer, answerFormat, files: uniqueFiles(referencedFiles) });
      return;
    }

    for (const toolCall of message.tool_calls) {
      if (toolCall.function.name === "search_drive") {
        const args = searchArgs.parse(JSON.parse(toolCall.function.arguments || "{}"));
        const normalizedQuery = normalizeSearchQuery(args.query);
        if (searchCallCount >= budget.maxSearchCalls) {
          const reason = `Search budget reached after ${searchCallCount} search_drive call(s).`;
          await emit({ type: "progress", message: reason });
          stopAfterToolUseReason = reason;
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: safeJson({ skipped: true, reason })
          });
          continue;
        }

        await emit({ type: "progress", message: `Searching Drive for "${args.query}"` });
        searchCallCount += 1;
        const wasRepeatedQuery = searchedQueries.has(normalizedQuery);
        searchedQueries.add(normalizedQuery);
        const files = await withToolRetries(
          () =>
            searchDriveFiles({
              ownerSub,
              connectionIds: selectedDriveIds,
              query: args.query,
              limit: args.limit
            }),
          budget.maxToolRetries
        );
        const newFiles = files.filter((file) => !knownFileKeys.has(fileKey(file)));
        for (const file of files) {
          knownFileKeys.add(fileKey(file));
        }
        if (wasRepeatedQuery || newFiles.length === 0) {
          lowProgressSearchCount += 1;
        } else {
          lowProgressSearchCount = 0;
        }
        if (lowProgressSearchCount >= budget.maxLowProgressSearches) {
          stopAfterToolUseReason = `Searches stopped producing new files after ${lowProgressSearchCount} low-progress search(es).`;
        }
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
        const key = `${args.connectionId}:${args.fileId}`;
        if (openedFileKeys.has(key)) {
          const reason = "File was already opened earlier in this run.";
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: safeJson({ skipped: true, reason })
          });
          continue;
        }
        if (openFileCallCount >= budget.maxOpenFileCalls) {
          const reason = `Open-file budget reached after ${openFileCallCount} open_file call(s).`;
          await emit({ type: "progress", message: reason });
          stopAfterToolUseReason = reason;
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: safeJson({ skipped: true, reason })
          });
          continue;
        }

        await emit({ type: "progress", message: `Opening file ${args.fileId}` });
        openFileCallCount += 1;
        openedFileKeys.add(key);
        const opened = await withToolRetries(
          () =>
            openDriveFile({
              ownerSub,
              connectionId: args.connectionId,
              fileId: args.fileId
            }),
          budget.maxToolRetries
        );
        knownFileKeys.add(fileKey(opened.file));
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

  const reason = `Agent stopped after reaching the ${budget.maxToolSteps}-step tool-use budget.`;
  const { answer, answerFormat } = partialAnswer(reason, input.mode);
  await emit({ type: "final", answer, answerFormat, files: uniqueFiles(referencedFiles) });
}
