// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { listDriveConnections, type DriveConnectionSummary } from "@/lib/drive-connections";
import {
  getEffectiveModelSettings,
  type EffectiveModelSettings,
  type EffectiveModelSettingsBundle
} from "@/lib/model-settings";
import { resolveModel, type ResolvedModel } from "@/lib/model-provider";
import {
  createDebugRequestId,
  debugError,
  debugText,
  hashForDebug,
  writeDebugLog
} from "@/lib/debug-log";
import {
  MODEL_REQUEST_MAX_RETRIES,
  type AgentBudget,
  type AgentOptions,
  type AgentProgress,
  type AgentRequest
} from "./types";
import { evaluateTokenBudget, resolveAgentBudget } from "./budget";
import { resolveUsageTokens } from "./tokens";
import { describeSubjectIdentity, systemPrompt } from "./prompts";
import { gradeFileRelevance } from "./examiner";
import { summarizeOversizeContent } from "./summarizer";
import { buildAgentResult, parseFinalAnswer, partialAnswer } from "./answer";
import { logModelStep, type LogSettings } from "./logging";
import { buildAgentTools } from "./tools";
import { createRunState, type AgentRunContext, type AgentRunState } from "./state";

/** The resolved model + log settings for every role used in one run. */
type RunModels = {
  main: ResolvedModel;
  grader: ResolvedModel;
  summarizer: ResolvedModel;
  mainLog: LogSettings;
  graderLog: LogSettings;
  summarizerLog: LogSettings;
};

/** The debug-log attribution triple for one role's effective settings. */
function logSettingsFor(role: EffectiveModelSettings): LogSettings {
  return { model: role.model, provider: role.provider, source: role.source };
}

/** Resolve the concrete model + log settings for all three roles up front. */
function resolveRunModels(settings: EffectiveModelSettingsBundle): RunModels {
  return {
    main: resolveModel(settings.main),
    grader: resolveModel(settings.grader),
    summarizer: resolveModel(settings.summarizer),
    mainLog: logSettingsFor(settings.main),
    graderLog: logSettingsFor(settings.grader),
    summarizerLog: logSettingsFor(settings.summarizer)
  };
}

/**
 * Resolve the connections the run may touch: "all" expands to every connection,
 * otherwise the requested ids are filtered to those the owner actually has.
 */
function selectDriveIds(connections: DriveConnectionSummary[], driveIds: string[]): string[] {
  const allowed = new Set(connections.map((connection) => connection.id));
  return driveIds.includes("all")
    ? connections.map((connection) => connection.id)
    : driveIds.filter((id) => allowed.has(id));
}

function logRunStarted(
  requestId: string,
  ownerSub: string,
  input: AgentRequest,
  settings: EffectiveModelSettingsBundle,
  budget: AgentBudget
) {
  return writeDebugLog({
    event: "agent.started",
    requestId,
    mode: input.mode,
    curateList: input.curateList,
    query: debugText(input.query),
    requestedDriveCount: input.driveIds.length,
    ownerSubHash: hashForDebug(ownerSub),
    modelSettingsSource: settings.main.source,
    provider: settings.main.provider,
    model: settings.main.model,
    // Reasoning effort is a coarse enum (not content/PII), so it's logged plainly.
    reasoningEffort: settings.main.reasoningEffort,
    graderModelSettingsSource: settings.grader.source,
    graderProvider: settings.grader.provider,
    graderModel: settings.grader.model,
    graderReasoningEffort: settings.grader.reasoningEffort,
    summarizerModelSettingsSource: settings.summarizer.source,
    summarizerProvider: settings.summarizer.provider,
    summarizerModel: settings.summarizer.model,
    summarizerReasoningEffort: settings.summarizer.reasoningEffort,
    budget
  });
}

function logConnectionsSelected(
  requestId: string,
  connections: DriveConnectionSummary[],
  selectedDriveIds: string[],
  subjectIdentity: string | null
) {
  return writeDebugLog({
    event: "agent.connections.selected",
    requestId,
    availableConnectionCount: connections.length,
    selectedConnectionCount: selectedDriveIds.length,
    selectedConnectionIdHashes: selectedDriveIds.map(hashForDebug),
    subjectIdentity: subjectIdentity ? debugText(subjectIdentity) : null
  });
}

/**
 * Build the per-run {@link AgentRunContext}: the fixed `base` fields plus the two
 * injected isolated-model closures. Each closure folds its own token usage into
 * the run-wide total (the examiner is the dominant token cost in list modes; the
 * summarizer runs once per oversize file opened during synthesis) before handing
 * back the verdict / summary.
 */
function buildRunContext(
  base: {
    ownerSub: string;
    input: AgentRequest;
    budget: AgentBudget;
    selectedDriveIds: string[];
    requestId: string;
    emit: (event: AgentProgress) => void | Promise<void>;
  },
  models: RunModels,
  state: AgentRunState
): AgentRunContext {
  return {
    ...base,
    gradeFile: async (file, content, step) => {
      const { verdict, usageTokens } = await gradeFileRelevance(
        models.grader,
        models.graderLog,
        base.input.query,
        file,
        content,
        base.requestId,
        step
      );
      state.tokensSpent += usageTokens;
      return verdict;
    },
    summarizeOversize: async (file, fullText, step) => {
      const { summary, usageTokens } = await summarizeOversizeContent(
        models.summarizer,
        models.summarizerLog,
        base.input.query,
        file,
        fullText,
        base.requestId,
        step
      );
      state.tokensSpent += usageTokens;
      return summary;
    }
  };
}

/**
 * Run the main tool-use loop via the AI SDK. The SDK appends each assistant turn
 * (carrying reasoning, round-tripped automatically per provider) and the tool
 * results, re-prompts, and stops at the step budget. Our per-tool budgets/dedup/
 * emit and the run-resilience invariant live inside the tool handlers (see
 * buildAgentTools); `state` is mutated in place so a throw can still finalize
 * with whatever was gathered.
 */
function runMainModelLoop(params: {
  resolved: ResolvedModel;
  logSettings: LogSettings;
  systemPromptText: string;
  userText: string;
  tools: ToolSet;
  budget: AgentBudget;
  state: AgentRunState;
  requestId: string;
  listMode: boolean;
}) {
  const { resolved, logSettings, systemPromptText, userText, tools, budget, state, requestId, listMode } =
    params;
  return generateText({
    model: resolved.model,
    providerOptions: resolved.providerOptions,
    ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
    ...(resolved.maxOutputTokens !== undefined ? { maxOutputTokens: resolved.maxOutputTokens } : {}),
    maxRetries: MODEL_REQUEST_MAX_RETRIES,
    system: systemPromptText,
    messages: [{ role: "user", content: userText }],
    tools,
    toolChoice: "auto",
    // maxToolSteps is only the loop-insurance backstop; diminishing returns and
    // the token guards (evaluated in prepareStep) are the normal stop.
    stopWhen: stepCountIs(budget.maxToolSteps),
    // Before each step: record the step index (so possibly-parallel tool executes
    // attribute their logs), evaluate the token-based budget guards, then gate
    // tools. A hard wind-down (diminishing-returns limit, cost seatbelt, or
    // context-window limit) drops every tool so the model must finish; a search
    // backstop drops only search_drive, leaving the read tool so the model can
    // finish with the files it already found.
    prepareStep: ({ stepNumber }) => {
      state.currentStep = stepNumber;
      evaluateTokenBudget(state, budget);
      if (state.windDownReason) return { activeTools: [] };
      if (state.stopSearchingReason) {
        return { activeTools: listMode ? ["review_file"] : ["open_file"] };
      }
      return undefined;
    },
    onStepFinish: (step) => {
      // Fold each main-loop step's tokens into the run total (drives the
      // diminishing-returns budget and cost seatbelt), estimating from the
      // visible text + reasoning when a provider reports no usage. The
      // context-window guard tracks raw input tokens only (never an estimate or
      // fudge) and simply doesn't fire when the provider omits them — the step
      // backstop carries the run then (see AgentBudget docs).
      state.tokensSpent += resolveUsageTokens(
        step.usage,
        `${step.text ?? ""}${step.reasoningText ?? ""}`
      );
      if (typeof step.usage?.inputTokens === "number") {
        state.lastInputTokens = step.usage.inputTokens;
      }
      return logModelStep(requestId, logSettings, step);
    }
  });
}

/**
 * Force one final, tool-free synthesis turn after the loop ends without a usable
 * answer (e.g. the step budget was hit mid-tool-use). Without it, a synthesis run
 * that ran out of steps would return only the raw files read. Reuses the run's
 * conversation (system + the original question + the SDK's response messages) and
 * offers no tools, so the model must produce prose. Returns null on failure so
 * the caller falls back to a partial answer.
 */
async function forceSynthesis(
  resolved: ResolvedModel,
  systemPromptText: string,
  userText: string,
  priorMessages: ModelMessage[],
  reason: string,
  requestId: string,
  logSettings: LogSettings
): Promise<string | null> {
  try {
    const forced = await generateText({
      model: resolved.model,
      providerOptions: resolved.providerOptions,
      ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
      ...(resolved.maxOutputTokens !== undefined ? { maxOutputTokens: resolved.maxOutputTokens } : {}),
      maxRetries: MODEL_REQUEST_MAX_RETRIES,
      system: systemPromptText,
      messages: [
        { role: "user", content: userText },
        ...priorMessages,
        { role: "user", content: `${reason} Stop using tools and return the final result now.` }
      ],
      onStepFinish: (step) => logModelStep(requestId, logSettings, step)
    });
    return forced.text;
  } catch (error) {
    await writeDebugLog({
      event: "agent.final_turn.failed",
      level: "error",
      requestId,
      error: debugError(error)
    });
    return null;
  }
}

/**
 * Assemble the final result, emit the terminal `final` event, and log
 * `agent.completed`. Shared by the success and error paths so gathered work is
 * never discarded. `steps`/`forcedFinalAnswer` and the stop-reason fields are
 * only present on the success path (the error path omits them, as before).
 */
async function finalizeRun(params: {
  emit: (event: AgentProgress) => void | Promise<void>;
  requestId: string;
  startedAt: number;
  input: AgentRequest;
  state: AgentRunState;
  parsed: { answer: string; answerFormat: "markdown" | "plain" };
  reason: string;
  steps?: number;
  forcedFinalAnswer?: boolean;
  withStopReasons: boolean;
}) {
  const { emit, requestId, startedAt, input, state, parsed, reason, steps, forcedFinalAnswer, withStopReasons } =
    params;
  const { answer, answerFormat, files, touchedFiles } = buildAgentResult(input, state, parsed);
  await writeDebugLog({
    event: "agent.completed",
    requestId,
    reason,
    durationMs: Date.now() - startedAt,
    ...(steps !== undefined ? { steps } : {}),
    ...(forcedFinalAnswer !== undefined ? { forcedFinalAnswer } : {}),
    searchCallCount: state.searchCallCount,
    openFileCallCount: state.openFileCallCount,
    reviewFileCallCount: state.reviewFileCallCount,
    touchedFileCount: state.touched.size,
    keptFileCount: state.kept.size,
    reviewedFileCount: state.reviewed.size,
    returnedFileCount: files.length,
    tokensSpent: state.tokensSpent,
    ...(withStopReasons
      ? { windDownReason: state.windDownReason, stopSearchingReason: state.stopSearchingReason }
      : {}),
    answerFormat,
    answerLength: answer.length
  });
  await emit({ type: "final", answer, answerFormat, files, touchedFiles });
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
  const models = resolveRunModels(modelSettings);
  await logRunStarted(requestId, ownerSub, input, modelSettings, budget);

  const connections = await listDriveConnections(ownerSub);
  const selectedDriveIds = selectDriveIds(connections, input.driveIds);
  // Who "my"/"I" in the query refers to — anchored into the system prompt so the
  // model can tell documents *about* the owner from ones merely authored by /
  // mentioning them (see describeSubjectIdentity / basePrompt).
  const subjectIdentity = describeSubjectIdentity(connections, selectedDriveIds);
  await logConnectionsSelected(requestId, connections, selectedDriveIds, subjectIdentity);

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

  const state = createRunState();
  const context = buildRunContext(
    { ownerSub, input, budget, selectedDriveIds, requestId, emit },
    models,
    state
  );
  const systemPromptText = systemPrompt(input, selectedDriveIds, subjectIdentity);
  const userText = `Query: ${input.query}\nMode: ${input.mode}\nCurate list: ${input.curateList}`;
  const tools = buildAgentTools(context, state);
  const stopReason = `Agent stopped after reaching the ${budget.maxToolSteps}-step tool-use budget.`;

  await emit({
    type: "progress",
    message: `Agent started with ${selectedDriveIds.length} Drive connection(s).`
  });

  try {
    const result = await runMainModelLoop({
      resolved: models.main,
      logSettings: models.mainLog,
      systemPromptText,
      userText,
      tools,
      budget,
      state,
      requestId,
      listMode: input.mode === "list"
    });

    // List mode answers are always empty (results come from state). For synthesis,
    // use the model's text; if the loop hit the step cap mid-tool-use (no text),
    // force one tool-free turn so we still synthesize instead of returning blank.
    let finalText: string | null = result.text;
    let forcedFinalAnswer = false;
    if (input.mode === "synthesis" && !result.text.trim()) {
      finalText = await forceSynthesis(
        models.main,
        systemPromptText,
        userText,
        result.response.messages,
        stopReason,
        requestId,
        models.mainLog
      );
      forcedFinalAnswer = finalText !== null;
    }

    await finalizeRun({
      emit,
      requestId,
      startedAt,
      input,
      state,
      parsed:
        finalText !== null && finalText.trim()
          ? parseFinalAnswer(finalText, input.mode)
          : partialAnswer(stopReason, input.mode),
      reason: result.finishReason,
      steps: result.steps.length,
      forcedFinalAnswer,
      withStopReasons: true
    });
  } catch (error) {
    // Never discard gathered work: a throw (model error after retries, an
    // unrepairable/hallucinated tool call, a timeout) finalizes with whatever the
    // in-place state already collected — mirroring the old empty-response path.
    await writeDebugLog({
      event: "agent.run.error",
      level: "error",
      requestId,
      durationMs: Date.now() - startedAt,
      error: debugError(error)
    });
    await finalizeRun({
      emit,
      requestId,
      startedAt,
      input,
      state,
      parsed: partialAnswer("The agent run ended early due to an error.", input.mode),
      reason: "run_error",
      withStopReasons: false
    });
  }
}
