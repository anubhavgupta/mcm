import { z } from 'zod';
import catalogJson from './catalog.json' with { type: 'json' };
import type { Catalog, ModelConfig, ModelPricing, SettingField, Values, Workspace } from './types';

const fieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  label: z.string(),
  section: z.string(),
  control: z.enum(['number', 'select', 'toggle', 'text', 'json']),
  flag: z.string().regex(/^--?[a-zA-Z0-9-]+$/).optional(),
  aliases: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  integer: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  omitValues: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  dependsOn: z.object({ key: z.string(), equals: z.union([z.string(), z.number(), z.boolean()]) }).optional(),
  description: z.string().optional(),
}).strict();

export const catalog: Catalog = z.object({
  version: z.number(),
  sections: z.array(z.object({ id: z.string(), title: z.string(), description: z.string() })),
  fields: z.array(fieldSchema),
}).parse(catalogJson);

export const defaults: Values = Object.fromEntries(catalog.fields.map(field => [field.key, field.default]));

export function fieldError(field: SettingField, value: unknown): string | undefined {
  if (field.control === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a finite number.';
    if (field.integer && !Number.isInteger(value)) return 'Enter a whole number.';
    if (field.min !== undefined && value < field.min) return `Minimum is ${field.min}.`;
    if (field.max !== undefined && value > field.max) return `Maximum is ${field.max}.`;
  } else if (field.control === 'toggle') {
    if (typeof value !== 'boolean') return 'Choose on or off.';
  } else {
    if (typeof value !== 'string') return 'Enter text.';
    if (value.length > 8192 || value.includes('\0')) return 'Text is too long or contains a null character.';
    if (field.control === 'select' && !field.options?.includes(value)) return 'Choose a supported option.';
    if (field.control === 'json' && value !== '') {
      try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'Enter a JSON object.';
      } catch {
        return 'Enter valid JSON.';
      }
    }
  }
}

export const valuesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).superRefine((values, ctx) => {
  for (const [key, value] of Object.entries(values)) {
    const field = catalog.fields.find(item => item.key === key);
    const message = field ? fieldError(field, value) : `Unknown setting: ${key}`;
    if (message) ctx.addIssue({ code: 'custom', path: [key], message });
  }
});

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const pricingSchema = z.object({
  inputUsdPerMillion: z.number().finite().min(0).max(1_000_000),
  outputUsdPerMillion: z.number().finite().min(0).max(1_000_000),
}).strict();
export const defaultPricing: ModelPricing = pricingSchema.parse({
  inputUsdPerMillion: defaults.inputUsdPerMillion,
  outputUsdPerMillion: defaults.outputUsdPerMillion,
});
export const repoSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Use owner/repository.');
const modelSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(120),
  model: z.object({
    filename: z.string().min(1).max(255).regex(/^[^/\\:\x00-\x1f]+\.gguf$/i, 'Use a GGUF filename, not a machine-specific path.'),
    repo: repoSchema.optional(),
  }).strict(),
  groupId: idSchema.optional(),
  values: valuesSchema,
  pricing: pricingSchema.optional(),
}).strict();

export const workspaceSchema = z.object({
  version: z.literal(1),
  base: valuesSchema,
  basePricing: pricingSchema.optional(),
  groups: z.array(z.object({ id: idSchema, name: z.string().trim().min(1).max(120), values: valuesSchema }).strict()).max(100),
  models: z.array(modelSchema).max(500),
}).strict().superRefine((workspace, ctx) => {
  for (const collection of ['models', 'groups'] as const) {
    const ids = workspace[collection].map(item => item.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: [collection], message: 'IDs must be unique.' });
  }
  for (const model of workspace.models) {
    if (model.groupId && !workspace.groups.some(group => group.id === model.groupId)) {
      ctx.addIssue({ code: 'custom', path: ['models'], message: `Missing group for ${model.name}.` });
    }
  }
}).transform(({ basePricing, ...workspace }) => ({
  ...workspace,
  base: { ...basePricing, ...workspace.base },
  models: workspace.models.map(({ pricing, ...model }) => ({
    ...model, values: { ...pricing, ...model.values },
  })),
}));

export function emptyWorkspace(): Workspace {
  return { version: 1, base: {}, groups: [], models: [] };
}

export function resolveConfig(workspace: Workspace, model?: ModelConfig): Values {
  const group = model?.groupId ? workspace.groups.find(item => item.id === model.groupId) : undefined;
  return { ...defaults, ...workspace.basePricing, ...workspace.base, ...group?.values, ...model?.pricing, ...model?.values };
}

export function resolvePricing(workspace: Workspace, model?: ModelConfig): ModelPricing {
  const values = resolveConfig(workspace, model);
  return pricingSchema.parse({
    inputUsdPerMillion: values.inputUsdPerMillion,
    outputUsdPerMillion: values.outputUsdPerMillion,
  });
}

export function isFieldEnabled(field: SettingField, values: Values): boolean {
  return !field.dependsOn || values[field.dependsOn.key] === field.dependsOn.equals;
}

export function fieldSupported(field: SettingField, flags: string[]): boolean {
  return !field.flag || [field.flag, ...(field.aliases ?? [])].some(flag => flags.includes(flag));
}

export function parseHelp(help: string): string[] {
  return [...new Set(help.match(/(?<![\w-])--?[a-zA-Z][a-zA-Z0-9-]*/g) ?? [])].sort();
}

export function buildArgs(values: Values, supportedFlags?: string[]): string[] {
  valuesSchema.parse(values);
  const args: string[] = [];
  for (const field of catalog.fields) {
    const value = values[field.key];
    if (!field.flag || value === undefined || !isFieldEnabled(field, values) || value === false || value === '' || field.omitValues?.includes(value)) continue;
    if (supportedFlags && !fieldSupported(field, supportedFlags)) {
      throw new Error(`${field.label} (${field.flag}) is not supported by this executable.`);
    }
    const flag = supportedFlags
      ? [field.flag, ...(field.aliases ?? [])].find(item => supportedFlags.includes(item))!
      : field.flag;
    args.push(flag);
    if (value !== true) args.push(String(value));
  }
  return args;
}
