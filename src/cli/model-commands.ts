import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

import {
  clearTerminalViewport,
  filterModelRegistryEntries,
  filterVisibleProviderRoutes,
  getPreferredVisibleProviderRoute,
  isBillingMode,
  isCapabilityTier,
  isCostTier,
  isQuotaVisibility,
  listBillingModeValues,
  listCapabilityTierValues,
  listCostTierValues,
  loadModelRegistry,
  parseInteractiveRowIndex,
  parsePositiveInteger,
  parseProviderRouteList,
  parseRoleList,
  renderInteractiveModelRow,
  renderModelRecommendation,
  renderModelRegistryJsonc,
  resolveModelRegistryPath,
} from "../model-registry.js";

export const DEFAULT_OPENCODE_EXECUTABLE_PATH = "/home/mhugo/.npm-global/bin/opencode";

type RuntimeModelFilterValues = {
  freeOnly: boolean;
  providerFilter: string | null;
};

type RuntimeModelFamily = {
  familyId: string;
  preferredModelId: string;
  providerNames: string[];
  routes: string[];
  capabilityTier?: string;
  costTier?: string;
  defaultRoles?: string[];
};

type InteractiveFilters = {
  providerFilter: string | null;
  roleFilter: string | null;
  freeOnly: boolean;
  enabledOnly: boolean;
};

type EditorCommandResult = {
  shouldExit: boolean;
  statusMessage: string;
};

type EditorModelEntry = Awaited<ReturnType<typeof loadModelRegistry>>["models"][number];

/**
 * Load the live runtime model catalog from the local OpenCode binary.
 *
 * Args:
 *   controlPlaneRootDirectory: Root of this repository.
 *   optionValues: CLI filter flags for the visible model list.
 *   opencodeExecutablePath: Command used to invoke `opencode models`.
 *
 * Returns:
 *   Filtered live model ids from `opencode models`.
 *
 * Raises:
 *   Error: When the runtime catalog command fails.
 */
export async function loadVisibleRuntimeModelIds(
  controlPlaneRootDirectory: string,
  optionValues: RuntimeModelFilterValues,
  opencodeExecutablePath = DEFAULT_OPENCODE_EXECUTABLE_PATH,
): Promise<string[]> {
  const listProcess = spawn(
    opencodeExecutablePath,
    ["models"],
    {
      cwd: controlPlaneRootDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdoutText = "";
  let stderrText = "";
  listProcess.stdout.on("data", (chunk) => {
    stdoutText += String(chunk);
  });
  listProcess.stderr.on("data", (chunk) => {
    stderrText += String(chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    listProcess.on("error", reject);
    listProcess.on("close", (closeCode) => {
      resolve(closeCode ?? 1);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`opencode models failed: ${stderrText.trim() || `exit ${exitCode}`}`);
  }

  const runtimeModelIds = stdoutText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return runtimeModelIds.filter((modelId) => {
    const providerSeparatorIndex = modelId.indexOf("/");
    const providerName = providerSeparatorIndex > 0 ? modelId.slice(0, providerSeparatorIndex) : "";
    const visibleRoutes = filterVisibleProviderRoutes([
      {
        provider: providerName,
        model: modelId,
        priority: 1,
      },
    ]);

    if (visibleRoutes.length === 0) {
      return false;
    }
    if (optionValues.providerFilter && providerName !== optionValues.providerFilter) {
      return false;
    }
    if (optionValues.freeOnly && !modelId.endsWith(":free")) {
      return false;
    }
    return true;
  });
}

/**
 * Build a stable family identifier from one runtime model id.
 *
 * Args:
 *   runtimeModelId: Raw `provider/model` id from `opencode models`.
 *
 * Returns:
 *   The route-independent family id used for grouped operator views.
 */
function buildRuntimeModelFamilyId(runtimeModelId: string): string {
  const modelPathSegments = runtimeModelId.split("/");
  if (modelPathSegments.length < 2) {
    return runtimeModelId;
  }

  return modelPathSegments.at(-1) ?? runtimeModelId;
}

/**
 * Group visible runtime model ids into route families.
 *
 * Args:
 *   runtimeModelIds: Visible live model ids from `opencode models`.
 *
 * Returns:
 *   Stable family rows with first-seen preferred routes and all visible routes.
 */
export function groupVisibleRuntimeModelFamilies(
  runtimeModelIds: string[],
): RuntimeModelFamily[] {
  const modelFamiliesById = new Map<string, RuntimeModelFamily>();

  for (const runtimeModelId of runtimeModelIds) {
    const familyId = buildRuntimeModelFamilyId(runtimeModelId);
    const providerSeparatorIndex = runtimeModelId.indexOf("/");
    const providerName = providerSeparatorIndex === -1
      ? runtimeModelId
      : runtimeModelId.slice(0, providerSeparatorIndex);
    const existingFamily = modelFamiliesById.get(familyId);

    if (existingFamily) {
      existingFamily.routes.push(runtimeModelId);
      if (!existingFamily.providerNames.includes(providerName)) {
        existingFamily.providerNames.push(providerName);
      }
      continue;
    }

    modelFamiliesById.set(familyId, {
      familyId,
      preferredModelId: runtimeModelId,
      providerNames: [providerName],
      routes: [runtimeModelId],
    });
  }

  return [...modelFamiliesById.values()].sort(
    (leftFamily, rightFamily) => leftFamily.familyId.localeCompare(rightFamily.familyId),
  );
}

/**
 * Enrich grouped runtime families with registry-defined metadata when available.
 *
 * Args:
 *   families: Runtime model families grouped from live runtime model ids.
 *   registry: Loaded model registry document.
 *
 * Returns:
 *   Families with optional capability/cost tiers and default roles populated from registry.
 */
export function enrichRuntimeModelFamiliesFromRegistry(
  families: RuntimeModelFamily[],
  registry: Awaited<ReturnType<typeof loadModelRegistry>>,
): RuntimeModelFamily[] {
  const modelsById = new Map<string, (typeof registry.models)[number]>();
  for (const modelEntry of registry.models) {
    modelsById.set(modelEntry.id, modelEntry);
  }

  return families.map((runtimeFamily) => {
    const registryModel = modelsById.get(runtimeFamily.familyId);
    if (!registryModel) {
      return runtimeFamily;
    }

    return {
      ...runtimeFamily,
      capabilityTier: registryModel.capability_tier,
      costTier: registryModel.cost_tier,
      defaultRoles: registryModel.default_roles,
    };
  });
}

/**
 * Load grouped runtime model families from the live OpenCode catalog.
 *
 * Args:
 *   controlPlaneRootDirectory: Root of this repository.
 *   optionValues: CLI filter flags for the visible model list.
 *   opencodeExecutablePath: Command used to invoke `opencode models`.
 *
 * Returns:
 *   Grouped visible model families for operator-facing inspection.
 */
export async function loadVisibleRuntimeModelFamilies(
  controlPlaneRootDirectory: string,
  optionValues: RuntimeModelFilterValues,
  opencodeExecutablePath = DEFAULT_OPENCODE_EXECUTABLE_PATH,
): Promise<RuntimeModelFamily[]> {
  const visibleRuntimeModelIds = await loadVisibleRuntimeModelIds(
    controlPlaneRootDirectory,
    optionValues,
    opencodeExecutablePath,
  );
  const groupedRuntimeModelFamilies = groupVisibleRuntimeModelFamilies(visibleRuntimeModelIds);
  const modelRegistry = await loadModelRegistry(resolveModelRegistryPath(controlPlaneRootDirectory));
  return enrichRuntimeModelFamiliesFromRegistry(groupedRuntimeModelFamilies, modelRegistry);
}

/**
 * Render one runtime model family in a compact operator-facing format.
 *
 * Args:
 *   runtimeModelFamily: Grouped family row to render.
 *
 * Returns:
 *   Tab-separated summary containing family, preferred route, providers, and routes.
 */
export function renderRuntimeModelFamily(runtimeModelFamily: RuntimeModelFamily): string {
  const parts = [
    runtimeModelFamily.familyId,
    `preferred=${runtimeModelFamily.preferredModelId}`,
    `providers=${runtimeModelFamily.providerNames.join(",")}`,
    `routes=${runtimeModelFamily.routes.join(" | ")}`,
  ];

  const tierParts = [
    runtimeModelFamily.capabilityTier,
    runtimeModelFamily.costTier,
  ].filter((value): value is string => value !== undefined);
  if (tierParts.length > 0) {
    parts.push(`tier=${tierParts.join("/")}`);
  }
  if (runtimeModelFamily.defaultRoles && runtimeModelFamily.defaultRoles.length > 0) {
    parts.push(`roles=${runtimeModelFamily.defaultRoles.join(",")}`);
  }

  return parts.join("\t");
}

function buildInteractiveModelScreen(
  renderedModelRows: string[],
  interactiveFilters: InteractiveFilters,
  statusMessage: string,
): string {
  const activeFilterParts: string[] = [];
  if (interactiveFilters.providerFilter) {
    activeFilterParts.push(`provider=${interactiveFilters.providerFilter}`);
  }
  if (interactiveFilters.roleFilter) {
    activeFilterParts.push(`role=${interactiveFilters.roleFilter}`);
  }
  if (interactiveFilters.freeOnly) {
    activeFilterParts.push("free-only");
  }
  if (interactiveFilters.enabledOnly) {
    activeFilterParts.push("enabled-only");
  }

  return [
    "Model Registry Editor",
    `Filters: ${activeFilterParts.length > 0 ? activeFilterParts.join(", ") : "none"}`,
    `Status: ${statusMessage}`,
    "",
    ...renderedModelRows,
    "",
    "Commands:",
    "  toggle <row>",
    "  description <row> <text...>",
    `  capability <row> <${listCapabilityTierValues().join("|")}>`,
    `  cost <row> <${listCostTierValues().join("|")}>`,
    `  billing <row> <${listBillingModeValues().join("|")}>`,
    "  quota <row> <system-observed|manual>",
    "  concurrency <row> <positive-integer>",
    "  roles <row> <comma,separated,roles>",
    "  routes <row> <comma,separated,provider/model,...>",
    "  test-model <row>",
    "  provider <name|clear>",
    "  role <name|clear>",
    "  free <on|off>",
    "  enabled <on|off>",
    "  save",
    "  quit",
    "",
  ].join("\n");
}

function updateProviderFilter(interactiveFilters: InteractiveFilters, providerValue: string | null): string {
  interactiveFilters.providerFilter = providerValue === "clear" ? null : providerValue;
  return `provider filter=${interactiveFilters.providerFilter ?? "none"}`;
}

function updateRoleFilter(interactiveFilters: InteractiveFilters, roleValue: string | null): string {
  interactiveFilters.roleFilter = roleValue === "clear" ? null : roleValue;
  return `role filter=${interactiveFilters.roleFilter ?? "none"}`;
}

function updateBooleanFilter(currentLabel: string, nextValue: string | undefined): boolean {
  if (nextValue === "on") {
    return true;
  }
  if (nextValue === "off") {
    return false;
  }
  throw new Error(`invalid ${currentLabel} filter value: ${nextValue ?? ""}`);
}

function requireSelectedEntry(
  rowValue: string | undefined,
  filteredEntries: EditorModelEntry[],
): EditorModelEntry {
  const rowIndex = parseInteractiveRowIndex(rowValue ?? "", filteredEntries.length);
  if (rowIndex === null) {
    throw new Error(`invalid row: ${rowValue ?? ""}`);
  }

  const selectedEntry = filteredEntries[rowIndex];
  if (!selectedEntry) {
    throw new Error(`missing model for row: ${rowValue ?? ""}`);
  }

  return selectedEntry;
}

/**
 * Probe the top-priority provider route for a selected registry entry.
 *
 * Args:
 *   selectedEntry: Registry entry whose top route should be exercised.
 *   opencodeExecutablePath: Command used to invoke model probing.
 *
 * Returns:
 *   A short success message including the resolved route and normalized output.
 *
 * Raises:
 *   Error: When no provider route exists or the probe command fails.
 */
async function probeTopProviderRoute(
  selectedEntry: EditorModelEntry,
  controlPlaneRootDirectory: string,
  opencodeExecutablePath: string,
): Promise<string> {
  const topProviderRoute = getPreferredVisibleProviderRoute(selectedEntry.provider_order);

  if (!topProviderRoute) {
    throw new Error(`no provider routes configured for ${selectedEntry.id}`);
  }

  const probePrompt = "Reply with exactly OK.";
  const probeProcess = spawn(
    opencodeExecutablePath,
    ["run", "-m", topProviderRoute.model, probePrompt],
    {
      cwd: controlPlaneRootDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdoutText = "";
  let stderrText = "";
  probeProcess.stdout.on("data", (chunk) => {
    stdoutText += String(chunk);
  });
  probeProcess.stderr.on("data", (chunk) => {
    stderrText += String(chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    probeProcess.on("error", reject);
    probeProcess.on("close", (closeCode) => {
      resolve(closeCode ?? 1);
    });
  });

  if (exitCode !== 0) {
    throw new Error(
      `${selectedEntry.id} probe failed via ${topProviderRoute.model}: ${stderrText.trim() || `exit ${exitCode}`}`,
    );
  }

  const normalizedOutput = stdoutText.trim().replace(/\s+/g, " ");
  return `${selectedEntry.id} probe ok via ${topProviderRoute.model}: ${normalizedOutput || "no output"}`;
}

/**
 * Apply one interactive model-registry editor command.
 *
 * Args:
 *   controlPlaneRootDirectory: Control-plane root path.
 *   modelRegistry: Mutable in-memory registry document.
 *   interactiveFilters: Current editor filter state.
 *   filteredEntries: Visible row subset for row-based commands.
 *   rawCommand: Raw user command line.
 *   opencodeExecutablePath: Command used for model probing.
 *
 * Returns:
 *   Exit signal and status text for the next screen render.
 *
 * Raises:
 *   Error: When the command is invalid or a model probe fails.
 */
async function executeModelRegistryEditorCommand(
  controlPlaneRootDirectory: string,
  modelRegistry: Awaited<ReturnType<typeof loadModelRegistry>>,
  interactiveFilters: InteractiveFilters,
  filteredEntries: EditorModelEntry[],
  rawCommand: string,
  opencodeExecutablePath: string,
): Promise<EditorCommandResult> {
  const commandParts = rawCommand.split(/\s+/);
  const commandName = commandParts[0];

  if (commandName === "quit") {
    return { shouldExit: true, statusMessage: "quit without saving" };
  }

  if (commandName === "save") {
    const modelRegistryPath = resolveModelRegistryPath(controlPlaneRootDirectory);
    await writeFile(modelRegistryPath, renderModelRegistryJsonc(modelRegistry), "utf8");
    return { shouldExit: false, statusMessage: `saved ${modelRegistryPath}` };
  }

  if (commandName === "provider") {
    return {
      shouldExit: false,
      statusMessage: updateProviderFilter(interactiveFilters, commandParts[1] ?? null),
    };
  }

  if (commandName === "role") {
    return {
      shouldExit: false,
      statusMessage: updateRoleFilter(interactiveFilters, commandParts[1] ?? null),
    };
  }

  if (commandName === "free") {
    interactiveFilters.freeOnly = updateBooleanFilter("free", commandParts[1]);
    return {
      shouldExit: false,
      statusMessage: `free filter=${interactiveFilters.freeOnly ? "on" : "off"}`,
    };
  }

  if (commandName === "enabled") {
    interactiveFilters.enabledOnly = updateBooleanFilter("enabled", commandParts[1]);
    return {
      shouldExit: false,
      statusMessage: `enabled filter=${interactiveFilters.enabledOnly ? "on" : "off"}`,
    };
  }

  const selectedEntry = requireSelectedEntry(commandParts[1], filteredEntries);

  if (commandName === "toggle") {
    selectedEntry.enabled = !selectedEntry.enabled;
    return {
      shouldExit: false,
      statusMessage: `${selectedEntry.id} ${selectedEntry.enabled ? "enabled" : "disabled"}`,
    };
  }

  if (commandName === "description") {
    const nextDescription = rawCommand.split(/\s+/).slice(2).join(" ").trim();
    if (nextDescription === "") {
      throw new Error(`invalid description for ${selectedEntry.id}`);
    }
    selectedEntry.description = nextDescription;
    return {
      shouldExit: false,
      statusMessage: `${selectedEntry.id} description updated`,
    };
  }

  if (commandName === "capability") {
    const nextCapabilityTier = commandParts[2] ?? "";
    if (!isCapabilityTier(nextCapabilityTier)) {
      throw new Error(`invalid capability tier: ${nextCapabilityTier}`);
    }
    selectedEntry.capability_tier = nextCapabilityTier;
    return {
      shouldExit: false,
      statusMessage: `${selectedEntry.id} capability_tier=${nextCapabilityTier}`,
    };
  }

  if (commandName === "cost") {
    const nextCostTier = commandParts[2] ?? "";
    if (!isCostTier(nextCostTier)) {
      throw new Error(`invalid cost tier: ${nextCostTier}`);
    }
    selectedEntry.cost_tier = nextCostTier;
    return {
      shouldExit: false,
      statusMessage: `${selectedEntry.id} cost_tier=${nextCostTier}`,
    };
  }

  if (commandName === "billing") {
    const nextBillingMode = commandParts[2] ?? "";
    if (!isBillingMode(nextBillingMode)) {
      throw new Error(`invalid billing mode: ${nextBillingMode}`);
    }
    selectedEntry.billing_mode = nextBillingMode;
    return {
      shouldExit: false,
      statusMessage: `${selectedEntry.id} billing_mode=${nextBillingMode}`,
    };
  }

  if (commandName === "quota") {
    const nextQuotaVisibility = commandParts[2] ?? "";
    if (!isQuotaVisibility(nextQuotaVisibility)) {
      throw new Error(`invalid quota visibility: ${nextQuotaVisibility}`);
    }
    selectedEntry.quota_visibility = nextQuotaVisibility;
    return {
      shouldExit: false,
      statusMessage: `${selectedEntry.id} quota_visibility=${nextQuotaVisibility}`,
    };
  }

  if (commandName === "concurrency") {
    const nextConcurrency = parsePositiveInteger(commandParts[2] ?? "");
    if (nextConcurrency === null) {
      throw new Error(`invalid concurrency: ${commandParts[2] ?? ""}`);
    }
    selectedEntry.concurrency = nextConcurrency;
    return {
      shouldExit: false,
      statusMessage: `${selectedEntry.id} concurrency=${nextConcurrency}`,
    };
  }

  if (commandName === "roles") {
    const nextRoles = parseRoleList(rawCommand.split(/\s+/).slice(2).join(" "));
    if (nextRoles.length === 0) {
      throw new Error(`invalid roles for ${selectedEntry.id}`);
    }
    selectedEntry.default_roles = nextRoles;
    return {
      shouldExit: false,
      statusMessage: `${selectedEntry.id} roles=${nextRoles.join(",")}`,
    };
  }

  if (commandName === "routes") {
    const nextRoutes = parseProviderRouteList(rawCommand.split(/\s+/).slice(2).join(" "));
    if (nextRoutes.length === 0) {
      throw new Error(`invalid provider routes for ${selectedEntry.id}`);
    }
    selectedEntry.provider_order = nextRoutes;
    return {
      shouldExit: false,
      statusMessage: `${selectedEntry.id} routes=${nextRoutes.map((route) => route.model).join(",")}`,
    };
  }

  if (commandName === "test-model") {
    return {
      shouldExit: false,
      statusMessage: await probeTopProviderRoute(
        selectedEntry,
        controlPlaneRootDirectory,
        opencodeExecutablePath,
      ),
    };
  }

  throw new Error(`unknown command: ${commandName}`);
}

/**
 * Run the interactive model-registry editor in a real terminal.
 *
 * Returns:
 *   Nothing.
 *
 * Raises:
 *   Error: When standard input/output are not interactive TTYs.
 */
export async function runModelRegistryEditor(
  controlPlaneRootDirectory: string,
  opencodeExecutablePath = DEFAULT_OPENCODE_EXECUTABLE_PATH,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("manage-models requires an interactive TTY");
  }

  const modelRegistry = await loadModelRegistry(controlPlaneRootDirectory);
  const interactiveFilters: InteractiveFilters = {
    providerFilter: null,
    roleFilter: null,
    freeOnly: false,
    enabledOnly: false,
  };
  let statusMessage = "ready";
  const terminalInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const filteredEntries = filterModelRegistryEntries(modelRegistry.models, {
        freeOnly: interactiveFilters.freeOnly,
        roleFilter: interactiveFilters.roleFilter,
        providerFilter: interactiveFilters.providerFilter,
        enabledOnly: interactiveFilters.enabledOnly,
      });

      clearTerminalViewport();
      process.stdout.write(
        `${buildInteractiveModelScreen(
          filteredEntries.map(renderInteractiveModelRow),
          interactiveFilters,
          statusMessage,
        )}\n`,
      );

      const rawCommand = (await terminalInterface.question("> ")).trim();
      if (rawCommand === "") {
        continue;
      }

      try {
        const commandResult = await executeModelRegistryEditorCommand(
          controlPlaneRootDirectory,
          modelRegistry,
          interactiveFilters,
          filteredEntries,
          rawCommand,
          opencodeExecutablePath,
        );
        statusMessage = commandResult.statusMessage;
        if (commandResult.shouldExit) {
          return;
        }
      } catch (error) {
        statusMessage = error instanceof Error ? error.message : "unknown editor error";
      }
    }
  } finally {
    terminalInterface.close();
  }
}

/**
 * Render recommendations for a specific role from the curated registry.
 *
 * Args:
 *   controlPlaneRootDirectory: Root of this repository.
 *   roleName: Role name to filter on.
 *   optionValues: CLI filter flags.
 *
 * Returns:
 *   Sorted recommendations using registry-defined primary routes.
 */
export async function buildRoleRecommendations(
  controlPlaneRootDirectory: string,
  roleName: string,
  optionValues: RuntimeModelFilterValues,
): Promise<string[]> {
  const modelRegistry = await loadModelRegistry(controlPlaneRootDirectory);
  const filteredEntries = filterModelRegistryEntries(modelRegistry.models, {
    ...optionValues,
    roleFilter: roleName,
    enabledOnly: false,
  });
  return filteredEntries.map(renderModelRecommendation);
}
