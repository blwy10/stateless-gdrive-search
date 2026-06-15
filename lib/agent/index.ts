// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

// Public API barrel for the Drive agent. The implementation is split into
// focused modules under lib/agent/*; this file preserves the original
// `@/lib/agent` import surface (consumed by app/api/agent/route.ts and the unit
// tests) so callers are unaffected by the internal decomposition.

export {
  parseAgentRequest,
  type AgentBudget,
  type AgentOptions,
  type AgentProgress
} from "./types";
export {
  defaultAgentBudgets,
  diminishingReturnsNote,
  evaluateTokenBudget,
  noteDiminishingReturns,
  resolveAgentBudget,
  type BudgetTrip,
  type BudgetWindDownGuard
} from "./budget";
export { describeSubjectIdentity, systemPrompt } from "./prompts";
export { estimateMessagesChars, resolveUsageTokens } from "./tokens";
export { wrapUntrustedContent } from "./untrusted";
export { gradeFileRelevance, normalizeGradeVerdict, type GradeVerdict } from "./examiner";
export { summarizeOversizeContent } from "./summarizer";
export { applyRanking, buildRankerPrompt, rankKeptFiles, type RankItem } from "./ranker";
export {
  buildAgentResult,
  parseFinalAnswer,
  parseSources,
  resolveSources,
  type SourceCitation
} from "./answer";
export { createRunState, FileSet, type AgentRunContext, type AgentRunState } from "./state";
export { handleSearchTool } from "./handlers/search";
export { handleOpenFileTool } from "./handlers/open";
export { handleReviewFileTool } from "./handlers/review";
export { handleListFolderTool } from "./handlers/list-folder";
export { runDriveAgent } from "./run";
