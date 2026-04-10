/**
 * Shared model-registry loader and selector utilities.
 *
 * This module is the single control-plane source for curated model routing.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { z } from "zod";

const MODEL_REGISTRY_FILE_NAME = "models.jsonc";
const MODEL_REGISTRY_DIRECTORY_NAME = "config";
const CAPABILITY_TIER_VALUES = ["tiny", "fast", "standard", "strong", "frontier"] as const;
const COST_TIER_VALUES = ["free", "cheap", "medium", "expensive"] as const;
const BILLING_MODE_VALUES = ["free", "subscription", "quota", "paid_api"] as const;
const QUOTA_VISIBILITY_VALUES = ["system-observed", "manual"] as const;
const OPENROUTER_PROVIDER_NAME = "openrouter";
const OPENROUTER_FREE_MODEL_SUFFIX = ":free";
const OPENROUTER_AUTO_MODEL = "openrouter/auto";
const OPENROUTER_BODYBUILDER_PREFIX = "openrouter/bodybuilder";
const OPENROUTER_FREE_META_MODEL = "openrouter/openrouter/free";
const OPENCODE_PROVIDER_NAME = "opencode";
const FREE_SUBSTRING = "free";
const CLOUDFLARE_AI_GATEWAY_PROVIDER_NAME = "cloudflare-ai-gateway";
const TOGETHER_AI_PROVIDER_NAME = "togetherai";
const CEREBRAS_PROVIDER_NAME = "cerebras";
const XAI_PROVIDER_NAME = "xai";
const XAI_ALLOWED_MODEL_PREFIX = "xai/grok-4.20";
const DEEPSEEK_PROVIDER_NAME = "deepseek";
const GITHUB_COPILOT_PROVIDER_NAME = "github-copilot";
const MINIMAX_CN_PROVIDER_NAME = "minimax-cn";
const MINIMAX_CN_CODING_PLAN_PROVIDER_NAME = "minimax-cn-coding-plan";

const providerRouteSchema = z.object({
  provider: z.string(),
  model: z.string(),
  priority: z.number().int().positive(),
  status: z.string().optional(),
});

const modelRegistryEntrySchema = z.object({
  id: z.string(),
  enabled: z.boolean().default(true),
  description: z.string(),
  capability_tier: z.enum(CAPABILITY_TIER_VALUES),
  cost_tier: z.enum(COST_TIER_VALUES),
  billing_mode: z.enum(BILLING_MODE_VALUES),
  latency_tier: z.string(),
  concurrency: z.number().int().positive(),
  quota_visibility: z.enum(QUOTA_VISIBILITY_VALUES),
  best_for: z.array(z.string()),
  not_for: z.array(z.string()),
  default_roles: z.array(z.string()),
  provider_order: z.array(providerRouteSchema),
  notes: z.array(z.string()),
});

const modelRegistrySchema = z.object({
  version: z.number().int().positive(),
  defaults: z.object({
    fields: z.array(z.string()),
  }),
  models: z.array(modelRegistryEntrySchema),
});

export type ProviderRoute = z.infer<typeof providerRouteSchema>;
export type ModelRegistryEntry = z.infer<typeof modelRegistryEntrySchema>;
export type ModelRegistry = z.infer<typeof modelRegistrySchema>;
export type CapabilityTier = (typeof CAPABILITY_TIER_VALUES)[number];
export type CostTier = (typeof COST_TIER_VALUES)[number];
export type BillingMode = (typeof BILLING_MODE_VALUES)[number];
export type QuotaVisibility = (typeof QUOTA_VISIBILITY_VALUES)[number];

export type ModelSelectionOptions = {
  freeOnly: boolean;
  roleFilter: string | null;
  providerFilter: string | null;
  enabledOnly: boolean;
};

/**
 * Check whether a string is one of the allowed capability tiers.
 */
export function isCapabilityTier(value: string): value is CapabilityTier {
  return listCapabilityTierValues().includes(value as CapabilityTier);
}

/**
 * Check whether a string is one of the allowed cost tiers.
 */
export function isCostTier(value: string): value is CostTier {
  return listCostTierValues().includes(value as CostTier);
}

/**
 * Check whether a string is one of the allowed billing modes.
 */
export function isBillingMode(value: string): value is BillingMode {
  return listBillingModeValues().includes(value as BillingMode);
}

/**
 * Return the allowed local policy values for capability tiers.
 */
export function listCapabilityTierValues(): readonly CapabilityTier[] {
  return CAPABILITY_TIER_VALUES;
}

/**
 * Return the allowed local policy values for cost tiers.
 */
export function listCostTierValues(): readonly CostTier[] {
  return COST_TIER_VALUES;
}

/**
 * Return the allowed local policy values for billing modes.
 */
export function listBillingModeValues(): readonly BillingMode[] {
  return BILLING_MODE_VALUES;
}

/**
 * Check whether a string is one of the allowed quota visibility values.
 */
export function isQuotaVisibility(value: string): value is QuotaVisibility {
  return listQuotaVisibilityValues().includes(value as QuotaVisibility);
}

/**
 * Return the allowed local policy values for quota visibility.
 */
export function listQuotaVisibilityValues(): readonly QuotaVisibility[] {
  return QUOTA_VISIBILITY_VALUES;
}

/**
 * Return the absolute path to the curated model registry.
 */
export function resolveModelRegistryPath(controlPlaneRootDirectory: string): string {
  return path.join(
    controlPlaneRootDirectory,
    MODEL_REGISTRY_DIRECTORY_NAME,
    MODEL_REGISTRY_FILE_NAME,
  );
}

/**
 * Remove JSONC comments before strict JSON parsing.
 */
export function stripJsonComments(jsoncText: string): string {
  return jsoncText
    .replace(/^\s*\/\/.*$/mg, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Load and validate the curated model registry from disk.
 */
export async function loadModelRegistry(
  controlPlaneRootDirectory: string,
): Promise<ModelRegistry> {
  const rawModelRegistry = await readFile(
    resolveModelRegistryPath(controlPlaneRootDirectory),
    "utf8",
  );
  const parsedModelRegistry = JSON.parse(stripJsonComments(rawModelRegistry));
  return modelRegistrySchema.parse(parsedModelRegistry);
}

/**
 * Parse model-selection flags from CLI-style argument values.
 */
export function parseModelSelectionOptions(
  argumentValues: string[],
): ModelSelectionOptions {
  let freeOnly = false;
  let roleFilter: string | null = null;
  let providerFilter: string | null = null;
  let enabledOnly = false;

  for (let index = 0; index < argumentValues.length; index += 1) {
    const argumentValue = argumentValues[index];
    if (argumentValue === "--free") {
      freeOnly = true;
      continue;
    }
    if (argumentValue === "--role") {
      roleFilter = argumentValues[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argumentValue === "--provider") {
      providerFilter = argumentValues[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argumentValue === "--enabled") {
      enabledOnly = true;
    }
  }

  return { freeOnly, roleFilter, providerFilter, enabledOnly };
}

/**
 * Filter curated models by free tier, default role, and provider route.
 */
export function filterModelRegistryEntries(
  modelEntries: ModelRegistryEntry[],
  options: ModelSelectionOptions,
): ModelRegistryEntry[] {
  return modelEntries.filter((modelEntry) => {
    const visibleProviderRoutes = filterVisibleProviderRoutes(modelEntry.provider_order);
    if (visibleProviderRoutes.length === 0) {
      return false;
    }
    if (options.enabledOnly && !modelEntry.enabled) {
      return false;
    }
    if (options.freeOnly && modelEntry.cost_tier !== "free") {
      return false;
    }
    if (options.roleFilter && !modelEntry.default_roles.includes(options.roleFilter)) {
      return false;
    }
    if (
      options.providerFilter
      && !visibleProviderRoutes.some(
        (providerRoute) => providerRoute.provider === options.providerFilter,
      )
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Render one model entry in a compact tab-separated summary.
 */
export function renderModelSummary(modelEntry: ModelRegistryEntry): string {
  const providerSummary = filterVisibleProviderRoutes(modelEntry.provider_order)
    .map((providerRoute) => `${providerRoute.priority}:${providerRoute.model}`)
    .join(" | ");

  return [
    modelEntry.id,
    modelEntry.enabled ? "enabled" : "disabled",
    `${modelEntry.capability_tier}/${modelEntry.cost_tier}/${modelEntry.billing_mode}`,
    `c=${modelEntry.concurrency}`,
    `roles=${modelEntry.default_roles.join(",")}`,
    providerSummary,
  ].join("\t");
}

/**
 * Render one model entry as a top-route recommendation.
 */
export function renderModelRecommendation(modelEntry: ModelRegistryEntry): string {
  const topProviderRoute = getPreferredVisibleProviderRoute(modelEntry.provider_order);

  return [
    modelEntry.id,
    topProviderRoute?.model ?? "",
    `status=${modelEntry.enabled ? "enabled" : "disabled"}`,
    `roles=${modelEntry.default_roles.join(",")}`,
    `concurrency=${modelEntry.concurrency}`,
    modelEntry.description,
  ].join("\t");
}

/**
 * Convert a curated model entry into a plugin-friendly payload.
 */
export function buildModelRegistryPayload(modelEntry: ModelRegistryEntry): {
  id: string;
  enabled: boolean;
  description: string;
  capabilityTier: string;
  costTier: string;
  billingMode: string;
  latencyTier: string;
  concurrency: number;
  quotaVisibility: string;
  defaultRoles: string[];
    providerOrder: ProviderRoute[];
  notes: string[];
} {
  return {
    id: modelEntry.id,
    enabled: modelEntry.enabled,
    description: modelEntry.description,
    capabilityTier: modelEntry.capability_tier,
    costTier: modelEntry.cost_tier,
    billingMode: modelEntry.billing_mode,
    latencyTier: modelEntry.latency_tier,
    concurrency: modelEntry.concurrency,
    quotaVisibility: modelEntry.quota_visibility,
    defaultRoles: modelEntry.default_roles,
    providerOrder: filterVisibleProviderRoutes(modelEntry.provider_order),
    notes: modelEntry.notes,
  };
}

/**
 * Write the curated registry back to JSONC with a stable top-level comment.
 */
export function renderModelRegistryJsonc(modelRegistry: ModelRegistry): string {
  return [
    "{",
    "  // Canonical control-plane model registry.",
    "  // Keep provider order, tiers, quotas, and role intent here.",
    ...JSON.stringify(modelRegistry, null, 2)
      .split("\n")
      .slice(1, -1),
    "}",
    "",
  ].join("\n");
}

/**
 * Return a compact one-line summary for interactive selection UIs.
 */
export function renderInteractiveModelRow(
  modelEntry: ModelRegistryEntry,
  index: number,
): string {
  const topProviderRoute = getPreferredVisibleProviderRoute(modelEntry.provider_order);

  return [
    `${String(index + 1).padStart(2, "0")}.`,
    modelEntry.enabled ? "[on]" : "[off]",
    modelEntry.id,
    `${modelEntry.capability_tier}/${modelEntry.cost_tier}/${modelEntry.billing_mode}`,
    `quota=${modelEntry.quota_visibility}`,
    `c=${modelEntry.concurrency}`,
    `roles=${modelEntry.default_roles.join(",")}`,
    `top=${topProviderRoute?.model ?? "none"}`,
  ].join(" ");
}

/**
 * Hide OpenRouter paid routes from default model-list views.
 *
 * Args:
 *   providerRoutes: Ordered provider routes from the registry.
 *
 * Returns:
 *   Only routes that should appear in default views.
 */
export function filterVisibleProviderRoutes(providerRoutes: ProviderRoute[]): ProviderRoute[] {
  return providerRoutes.filter((providerRoute) => {
    if (providerRoute.provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_NAME) {
      return false;
    }

    if (providerRoute.provider === TOGETHER_AI_PROVIDER_NAME) {
      return false;
    }

    if (providerRoute.provider === CEREBRAS_PROVIDER_NAME) {
      return false;
    }

    if (providerRoute.provider === XAI_PROVIDER_NAME) {
      return providerRoute.model.startsWith(XAI_ALLOWED_MODEL_PREFIX);
    }

    if (providerRoute.provider === DEEPSEEK_PROVIDER_NAME) {
      return false;
    }

    if (providerRoute.provider === GITHUB_COPILOT_PROVIDER_NAME) {
      return false;
    }

    if (
      providerRoute.provider === MINIMAX_CN_PROVIDER_NAME
      || providerRoute.provider === MINIMAX_CN_CODING_PLAN_PROVIDER_NAME
    ) {
      return false;
    }

    if (providerRoute.provider !== OPENROUTER_PROVIDER_NAME) {
      if (providerRoute.provider !== OPENCODE_PROVIDER_NAME) {
        return true;
      }

      return providerRoute.model.includes(FREE_SUBSTRING);
    }

    if (providerRoute.model === OPENROUTER_AUTO_MODEL) {
      return false;
    }

    if (providerRoute.model === OPENROUTER_FREE_META_MODEL) {
      return false;
    }

    if (providerRoute.model.startsWith(OPENROUTER_BODYBUILDER_PREFIX)) {
      return false;
    }

    return providerRoute.model.endsWith(OPENROUTER_FREE_MODEL_SUFFIX);
  });
}

/**
 * Resolve the best currently visible route for display and probing.
 *
 * Args:
 *   providerRoutes: Ordered provider routes from the registry.
 *
 * Returns:
 *   The best visible route, or `undefined` when none remain after filtering.
 */
export function getPreferredVisibleProviderRoute(
  providerRoutes: ProviderRoute[],
): ProviderRoute | undefined {
  return [...filterVisibleProviderRoutes(providerRoutes)].sort(
    (leftRoute, rightRoute) => leftRoute.priority - rightRoute.priority,
  )[0];
}

/**
 * Parse a positive one-based row index for interactive editing.
 */
export function parseInteractiveRowIndex(
  rowValue: string,
  totalCount: number,
): number | null {
  const parsedRowNumber = Number(rowValue);
  if (!Number.isInteger(parsedRowNumber)) {
    return null;
  }
  const zeroBasedRowIndex = parsedRowNumber - 1;
  if (zeroBasedRowIndex < 0 || zeroBasedRowIndex >= totalCount) {
    return null;
  }
  return zeroBasedRowIndex;
}

/**
 * Parse a positive integer used for concurrency editing.
 */
export function parsePositiveInteger(value: string): number | null {
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    return null;
  }
  return parsedValue;
}

/**
 * Parse a comma-separated role list into canonical role names.
 */
export function parseRoleList(value: string): string[] {
  return value
    .split(",")
    .map((roleName) => roleName.trim())
    .filter((roleName) => roleName.length > 0);
}

/**
 * Parse a comma-separated provider/model route list into ordered route entries.
 */
export function parseProviderRouteList(value: string): ProviderRoute[] {
  const modelIds = value
    .split(",")
    .map((modelId) => modelId.trim())
    .filter((modelId) => modelId.length > 0);

  return modelIds.map((modelId, index) => {
    const providerSeparatorIndex = modelId.indexOf("/");
    if (providerSeparatorIndex < 1 || providerSeparatorIndex === modelId.length - 1) {
      throw new Error(`invalid provider/model route: ${modelId}`);
    }

    return {
      provider: modelId.slice(0, providerSeparatorIndex),
      model: modelId,
      priority: index + 1,
    };
  });
}

/**
 * Clear the active terminal viewport for a simple TUI-like redraw.
 */
export function clearTerminalViewport(): void {
  if (!process.stdout.isTTY) {
    return;
  }
  process.stdout.write("\u001Bc");
}
