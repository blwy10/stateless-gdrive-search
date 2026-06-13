import { z } from "zod";
import { listDriveConnections } from "@/lib/drive-connections";
import { openDriveFile, searchDriveFiles, type DriveFile } from "@/lib/drive";
import { formatMimeType } from "@/lib/file-types";
import { getEffectiveModelSettings, type EffectiveModelSettings } from "@/lib/model-settings";
import {
  createDebugRequestId,
  debugError,
  debugText,
  hashForDebug,
  writeDebugLog
} from "@/lib/debug-log";

const AgentRequest = z.object({
  query: z.string().trim().min(1).max(2000),
  mode: z.enum(["list", "synthesis"]),
  driveIds: z.array(z.string().min(1)).min(1).max(20),
  curateList: z.boolean().optional().default(false)
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

function basePrompt(allowedDriveIds: string[], budget: AgentBudget) {
  return `You are a Google Drive research agent.

You have exactly two tools: search_drive and open_file.
You may only work with these selected Drive connection IDs: ${allowedDriveIds.join(", ")}.
Use at most ${budget.maxSearchCalls} search_drive calls.
Use at most ${budget.maxOpenFileCalls} open_file calls.
Search using targeted query variants before deciding there is not enough evidence.
Do not repeat equivalent searches.
If searches stop producing new relevant files, answer with the evidence found.
Never claim you searched outside Google Drive.
Never ask for permissions or tokens.
If evidence is weak, say that directly.`;
}

function synthesisSystemPrompt(allowedDriveIds: string[], budget: AgentBudget) {
  return `${basePrompt(allowedDriveIds, budget)}

Open files when their titles or snippets appear relevant.
Return a concise synthesis answering the user's query, followed by the source files you relied on.
Your final response must start with exactly one format line:
FORMAT: markdown
or
FORMAT: plain
Then put the answer body after that line.
Use markdown only when headings, lists, links, or other markdown structure materially improve readability.
Never return HTML or any format other than markdown or plain.`;
}

function listSystemPrompt(
  allowedDriveIds: string[],
  budget: AgentBudget,
  curateList: boolean
) {
  if (curateList) {
    return `${basePrompt(allowedDriveIds, budget)}

Find relevant files only. Do not synthesize an answer.
Open files that may be relevant, then curate the final list from opened files only.
Only include a file in your final selection if its opened content is relevant to the query.
When you are done, return exactly:
FORMAT: plain
CURATED_FILE_LIST: [{"connectionId":"...","fileId":"..."}]
Use an empty array if no opened files are relevant.`;
  }

  return `${basePrompt(allowedDriveIds, budget)}

Find relevant files only. Do not synthesize an answer.
Open files when their titles or snippets appear relevant and opening is needed to judge relevance.
When you are done, return exactly:
FORMAT: plain
FILE_LIST_COMPLETE`;
}

function systemPrompt(input: AgentRequest, allowedDriveIds: string[], budget: AgentBudget) {
  return input.mode === "synthesis"
    ? synthesisSystemPrompt(allowedDriveIds, budget)
    : listSystemPrompt(allowedDriveIds, budget, input.curateList);
}

function safeJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

async function callModel(
  settings: EffectiveModelSettings,
  messages: ChatMessage[],
  requestId: string,
  step: number
) {
  const startedAt = Date.now();

  await writeDebugLog({
    event: "agent.model.request",
    requestId,
    step,
    model: settings.model,
    modelSettingsSource: settings.source,
    messageCount: messages.length
  });

  try {
    const response = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.2
      })
    });
    if (!response.ok) {
      const responseBody = await response.text();
      await writeDebugLog({
        event: "agent.model.failed",
        level: "error",
        requestId,
        step,
        model: settings.model,
        modelSettingsSource: settings.source,
        status: response.status,
        durationMs: Date.now() - startedAt,
        response: debugText(responseBody)
      });
      throw new Error(`AI request failed with status ${response.status}`);
    }

    const completion = (await response.json()) as ChatCompletion;
    const message = completion.choices[0]?.message;
    await writeDebugLog({
      event: "agent.model.completed",
      requestId,
      step,
      model: settings.model,
      modelSettingsSource: settings.source,
      durationMs: Date.now() - startedAt,
      toolCallCount: message?.tool_calls?.length ?? 0,
      responseContentLength: message?.content?.length ?? 0
    });
    return completion;
  } catch (error) {
    await writeDebugLog({
      event: "agent.model.error",
      level: "error",
      requestId,
      step,
      model: settings.model,
      modelSettingsSource: settings.source,
      durationMs: Date.now() - startedAt,
      error: debugError(error)
    });
    throw error;
  }
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

function formatFileProgressLabel(file: DriveFile) {
  return `${formatMimeType(file.mimeType)} "${file.name}"`;
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

function curatedListFiles(content: string | null, openedFiles: DriveFile[]) {
  const raw = content?.trim() ?? "";
  const match = raw.match(/CURATED_FILE_LIST:\s*(\[[\s\S]*\])\s*$/);
  if (!match) return uniqueFiles(openedFiles);

  const openedByKey = new Map(openedFiles.map((file) => [fileKey(file), file]));
  try {
    const selected = z
      .array(
        z.object({
          connectionId: z.string().min(1),
          fileId: z.string().min(1).optional(),
          id: z.string().min(1).optional()
        })
      )
      .parse(JSON.parse(match[1]));
    return uniqueFiles(
      selected
        .map((file) => openedByKey.get(`${file.connectionId}:${file.fileId ?? file.id}`))
        .filter((file): file is DriveFile => Boolean(file))
    );
  } catch {
    return uniqueFiles(openedFiles);
  }
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
  const requestId = createDebugRequestId("agent");
  const startedAt = Date.now();
  const budget = resolveAgentBudget(input.mode, options.budget);
  const modelSettings = await getEffectiveModelSettings(ownerSub);
  await writeDebugLog({
    event: "agent.started",
    requestId,
    mode: input.mode,
    curateList: input.curateList,
    query: debugText(input.query),
    requestedDriveCount: input.driveIds.length,
    ownerSubHash: hashForDebug(ownerSub),
    modelSettingsSource: modelSettings.source,
    model: modelSettings.model,
    budget
  });

  const connections = await listDriveConnections(ownerSub);
  const allowed = new Set(connections.map((connection) => connection.id));
  const selectedDriveIds = input.driveIds.includes("all")
    ? connections.map((connection) => connection.id)
    : input.driveIds.filter((id) => allowed.has(id));

  await writeDebugLog({
    event: "agent.connections.selected",
    requestId,
    availableConnectionCount: connections.length,
    selectedConnectionCount: selectedDriveIds.length,
    selectedConnectionIdHashes: selectedDriveIds.map(hashForDebug)
  });

  if (selectedDriveIds.length === 0) {
    await writeDebugLog({
      event: "agent.failed",
      level: "warn",
      requestId,
      reason: "no_connected_drive_selected",
      durationMs: Date.now() - startedAt
    });
    throw new Error("No connected Drive selected");
  }

  const referencedFiles: DriveFile[] = [];
  const openedFiles: DriveFile[] = [];
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(input, selectedDriveIds, budget) },
    {
      role: "user",
      content: `Query: ${input.query}\nMode: ${input.mode}\nCurate list: ${input.curateList}`
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

    const completion = await callModel(modelSettings, messages, requestId, step);
    const message = completion.choices[0]?.message;
    if (!message) {
      await writeDebugLog({
        event: "agent.failed",
        level: "error",
        requestId,
        reason: "model_returned_no_message",
        step,
        durationMs: Date.now() - startedAt
      });
      throw new Error("AI returned no message");
    }

    messages.push({
      role: "assistant",
      content: message.content,
      tool_calls: message.tool_calls
    });

    if (!message.tool_calls?.length) {
      const { answer, answerFormat } = parseFinalAnswer(message.content, input.mode);
      const files =
        input.mode === "list" && input.curateList
          ? curatedListFiles(message.content, openedFiles)
          : uniqueFiles(referencedFiles);
      await writeDebugLog({
        event: "agent.completed",
        requestId,
        reason: "final_message",
        durationMs: Date.now() - startedAt,
        step,
        searchCallCount,
        openFileCallCount,
        referencedFileCount: referencedFiles.length,
        returnedFileCount: files.length,
        answerFormat,
        answerLength: answer.length
      });
      await emit({ type: "final", answer, answerFormat, files });
      return;
    }

    for (const toolCall of message.tool_calls) {
      if (toolCall.function.name === "search_drive") {
        const args = searchArgs.parse(JSON.parse(toolCall.function.arguments || "{}"));
        const normalizedQuery = normalizeSearchQuery(args.query);
        await writeDebugLog({
          event: "agent.tool.search_drive.requested",
          requestId,
          step,
          toolCallIdHash: hashForDebug(toolCall.id),
          query: debugText(args.query),
          limit: args.limit ?? null,
          searchCallCount
        });
        if (searchCallCount >= budget.maxSearchCalls) {
          const reason = `Search budget reached after ${searchCallCount} search_drive call(s).`;
          await emit({ type: "progress", message: reason });
          await writeDebugLog({
            event: "agent.tool.search_drive.skipped",
            level: "warn",
            requestId,
            step,
            reason: "search_budget_reached",
            searchCallCount
          });
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
        const toolStartedAt = Date.now();
        let files: DriveFile[];
        try {
          files = await withToolRetries(
            () =>
              searchDriveFiles({
                ownerSub,
                connectionIds: selectedDriveIds,
                query: args.query,
                limit: args.limit,
                debugRequestId: requestId
              }),
            budget.maxToolRetries
          );
        } catch (error) {
          await writeDebugLog({
            event: "agent.tool.search_drive.failed",
            level: "error",
            requestId,
            step,
            durationMs: Date.now() - toolStartedAt,
            searchCallCount,
            error: debugError(error)
          });
          throw error;
        }
        const newFiles = files.filter((file) => !knownFileKeys.has(fileKey(file)));
        await writeDebugLog({
          event: "agent.tool.search_drive.completed",
          requestId,
          step,
          durationMs: Date.now() - toolStartedAt,
          repeatedQuery: wasRepeatedQuery,
          resultCount: files.length,
          newResultCount: newFiles.length,
          searchCallCount
        });
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
          await writeDebugLog({
            event: "agent.low_progress_search_limit_reached",
            level: "warn",
            requestId,
            step,
            lowProgressSearchCount
          });
        }
        if (!input.curateList) {
          referencedFiles.push(...files);
          for (const file of files) {
            await emit({ type: "file", file });
          }
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: safeJson({ files })
        });
      } else if (toolCall.function.name === "open_file") {
        const args = openArgs.parse(JSON.parse(toolCall.function.arguments || "{}"));
        await writeDebugLog({
          event: "agent.tool.open_file.requested",
          requestId,
          step,
          toolCallIdHash: hashForDebug(toolCall.id),
          connectionIdHash: hashForDebug(args.connectionId),
          fileIdHash: hashForDebug(args.fileId),
          openFileCallCount
        });
        if (!selectedDriveIds.includes(args.connectionId)) {
          await writeDebugLog({
            event: "agent.tool.open_file.rejected",
            level: "error",
            requestId,
            step,
            reason: "outside_selected_drive_scope",
            connectionIdHash: hashForDebug(args.connectionId),
            fileIdHash: hashForDebug(args.fileId)
          });
          throw new Error("AI attempted to open a file outside the selected Drive scope");
        }
        const key = `${args.connectionId}:${args.fileId}`;
        if (openedFileKeys.has(key)) {
          const reason = "File was already opened earlier in this run.";
          await writeDebugLog({
            event: "agent.tool.open_file.skipped",
            requestId,
            step,
            reason: "already_opened",
            fileKeyHash: hashForDebug(key)
          });
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
          await writeDebugLog({
            event: "agent.tool.open_file.skipped",
            level: "warn",
            requestId,
            step,
            reason: "open_file_budget_reached",
            openFileCallCount
          });
          stopAfterToolUseReason = reason;
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: safeJson({ skipped: true, reason })
          });
          continue;
        }

        openFileCallCount += 1;
        openedFileKeys.add(key);
        const toolStartedAt = Date.now();
        let opened: { file: DriveFile; content: string };
        try {
          opened = await withToolRetries(
            () =>
              openDriveFile({
                ownerSub,
                connectionId: args.connectionId,
                fileId: args.fileId,
                debugRequestId: requestId
              }),
            budget.maxToolRetries
          );
        } catch (error) {
          await writeDebugLog({
            event: "agent.tool.open_file.failed",
            level: "error",
            requestId,
            step,
            durationMs: Date.now() - toolStartedAt,
            fileKeyHash: hashForDebug(key),
            openFileCallCount,
            error: debugError(error)
          });
          throw error;
        }
        await writeDebugLog({
          event: "agent.tool.open_file.completed",
          requestId,
          step,
          durationMs: Date.now() - toolStartedAt,
          fileKeyHash: hashForDebug(fileKey(opened.file)),
          mimeType: opened.file.mimeType,
          contentLength: opened.content.length,
          openFileCallCount
        });
        knownFileKeys.add(fileKey(opened.file));
        referencedFiles.push(opened.file);
        openedFiles.push(opened.file);
        await emit({ type: "progress", message: `Opened ${formatFileProgressLabel(opened.file)}` });
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
  const files =
    input.mode === "list" && input.curateList
      ? uniqueFiles(openedFiles)
      : uniqueFiles(referencedFiles);
  await writeDebugLog({
    event: "agent.completed",
    requestId,
    reason: "max_tool_steps_reached",
    durationMs: Date.now() - startedAt,
    searchCallCount,
    openFileCallCount,
    referencedFileCount: referencedFiles.length,
    returnedFileCount: files.length,
    answerFormat,
    answerLength: answer.length
  });
  await emit({ type: "final", answer, answerFormat, files });
}
