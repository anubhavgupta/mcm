import type { ThemeId } from './themes';

export type SettingValue = string | number | boolean;
export type Values = Record<string, SettingValue>;

export interface SettingField {
  key: string;
  label: string;
  section: string;
  control: 'number' | 'select' | 'toggle' | 'text' | 'json' | 'multi-select' | 'model-file';
  flag?: string;
  aliases?: string[];
  default: SettingValue;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  options?: string[];
  omitValues?: SettingValue[];
  dependsOn?: { key: string; equals?: SettingValue; containsAny?: string[] };
  required?: boolean;
  hideWhenDisabled?: boolean;
  description?: string;
}
export interface Catalog {
  version: number;
  sections: { id: string; title: string; description: string }[];
  fields: SettingField[];
}
export interface ConfigGroup { id: string; name: string; values: Values; llamaVersion?: string }
export type ExecutableScope = { kind: 'base' } | { kind: 'group' | 'model'; id: string };
export interface ExecutableOverrides {
  base?: string;
  groups?: Record<string, string>;
  models?: Record<string, string>;
}
export interface ExecutableVersion { executablePath: string; version: string }
export interface ModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}
export interface ModelConfig {
  id: string;
  name: string;
  model: { filename: string; repo?: string };
  groupId?: string;
  llamaVersion?: string;
  values: Values;
  /** Legacy input; workspace validation migrates it to values. */
  pricing?: ModelPricing;
}
export interface Workspace {
  version: 1;
  base: Values;
  llamaVersion?: string;
  /** Legacy input; workspace validation migrates it to base. */
  basePricing?: ModelPricing;
  groups: ConfigGroup[];
  models: ModelConfig[];
}
export interface LocalSettings {
  theme?: ThemeId;
  executablePath: string;
  executableOverrides?: ExecutableOverrides;
  modelsDirectory: string;
  serverPort: number;
  upstreamUrl: string;
  anthropicMode?: 'passthrough' | 'openai';
  modelBindings: Record<string, string>;
  draftModelBindings?: Record<string, string>;
  hfRepo: string;
  hfToken?: string;
}
export type PublicSettings = Omit<LocalSettings, 'hfToken'> & { hfTokenConfigured: boolean };
export interface CustomInterceptorEntry {
  id: string;
  name: string;
  modulePath: string;
}
export type InterceptorEntry =
  | (CustomInterceptorEntry & { source: 'local'; locked: false })
  | { id: string; name: string; source: 'builtin' | 'environment'; locked: true };
export interface InterceptorPipeline { entries: InterceptorEntry[] }
export interface InterceptorPipelineUpdate {
  entries: CustomInterceptorEntry[];
  trustedCodeAcknowledged: true;
}
export interface ModelFile { filename: string; relativePath: string; size: number }
export interface Capabilities { flags: string[]; help: string; version?: string; compatibilityWarning?: string }
export type ProcessPhase = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';
export interface ServerStatus { phase: ProcessPhase; modelId?: string; pid?: number; error?: string; compatibilityWarning?: string }
export interface LogEntry { timestamp: string; stream: 'stdout' | 'stderr' | 'manager'; text: string }
export interface Throughput {
  requestId: string;
  protocol: 'openai' | 'anthropic';
  pp: number | null;
  tg: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  source: 'llama.cpp' | 'unavailable';
  measurement?: 'timings' | 'prometheus';
  active: boolean;
}
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  unpricedTokens: number;
  requestCount: number;
  missingUsageRequests: number;
}
export interface UsageSummary {
  allTime: UsageTotals;
  session: UsageTotals;
  sessionId: string;
  sessionStartedAt: string;
  trackingStartedAt: string;
  error?: string;
}
export type ManagerEvent =
  | { type: 'status'; data: ServerStatus }
  | { type: 'log'; data: LogEntry }
  | { type: 'throughput'; data: Throughput }
  | { type: 'usage'; data: UsageSummary };
export interface Bootstrap {
  workspace: Workspace;
  settings: PublicSettings;
  status: ServerStatus;
  usage: UsageSummary;
}
