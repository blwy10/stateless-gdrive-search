// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

// Public API barrel for model settings. The implementation is split into focused
// modules under lib/model-settings/* (constants/coercion, types + input schemas,
// env defaults, pure resolution, and DB access); this file preserves the original
// `@/lib/model-settings` import surface so callers are unaffected.

export {
  coerceModelProvider,
  coerceReasoningEffort,
  MODEL_PROVIDERS,
  MODEL_ROLES,
  REASONING_EFFORTS,
  type ModelProvider,
  type ModelRole,
  type ReasoningEffort
} from "./constants";
export {
  parseModelRole,
  parseModelSettingsInput,
  type EffectiveModelSettings,
  type EffectiveModelSettingsBundle,
  type ModelSettingsInput,
  type ModelSettingsSummary,
  type RoleSettingsInput,
  type RoleSettingsSummary
} from "./types";
export { resolveRoleSettings } from "./resolve";
export {
  deleteModelSettings,
  getEffectiveModelSettings,
  getModelSettingsSummary,
  upsertModelSettings
} from "./repository";
