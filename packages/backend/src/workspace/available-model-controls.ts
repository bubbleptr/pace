// List RuntimeModelControls from Pi ModelRuntime + ModelRegistry without an
// open Agent Session (draft create / DF-011).

import { join } from "node:path";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { compareModelCapabilities } from "@pace/core";
import type {
  ModelCatalogRefreshResult,
  RuntimeModelCapability,
  RuntimeModelControls,
  RuntimeModelSelection,
  RuntimeThinkingLevel,
} from "@pace/core";
import { createPaceModelRuntime } from "./account-models";

const thinkingLevelOrder: RuntimeThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function thinkingLevelsForModel(model: {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<RuntimeThinkingLevel, string | null>>;
}): RuntimeThinkingLevel[] {
  if (!model.reasoning) {
    return ["off"];
  }

  return thinkingLevelOrder.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];

    if (mapped === null) {
      return false;
    }

    // xhigh/max are opt-in per model: only offered when explicitly mapped.
    return (level !== "xhigh" && level !== "max") || mapped !== undefined;
  });
}

function capabilityFromRegistryModel(model: {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<RuntimeThinkingLevel, string | null>>;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
}): RuntimeModelCapability {
  const capability: RuntimeModelCapability = {
    provider: model.provider,
    modelId: model.id,
    name: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
    thinkingLevels: thinkingLevelsForModel(model),
  };

  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    capability.contextWindow = model.contextWindow;
  }

  if (typeof model.maxTokens === "number" && model.maxTokens > 0) {
    capability.maxTokens = model.maxTokens;
  }

  if (Array.isArray(model.input)) {
    const modalities = model.input.filter(
      (modality): modality is "text" | "image" =>
        modality === "text" || modality === "image",
    );

    if (modalities.length > 0) {
      capability.input = modalities;
    }
  }

  return capability;
}

function defaultSelection(
  models: RuntimeModelCapability[],
  preferred?: { provider?: string; modelId?: string; thinkingLevel?: string },
): RuntimeModelSelection | null {
  if (!models.length) {
    return null;
  }

  const preferredModel =
    preferred?.provider && preferred.modelId
      ? models.find(
          (model) =>
            model.provider === preferred.provider && model.modelId === preferred.modelId,
        )
      : undefined;
  const model = preferredModel ?? models[0]!;
  const thinkingLevel =
    preferred?.thinkingLevel &&
    model.thinkingLevels.includes(preferred.thinkingLevel as RuntimeThinkingLevel)
      ? (preferred.thinkingLevel as RuntimeThinkingLevel)
      : (model.thinkingLevels[model.thinkingLevels.length - 1] ?? "off");

  return {
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel,
  };
}

async function readSettingsPreferredModel(agentDir: string) {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as unknown;
    if (!isRecord(raw)) {
      return undefined;
    }

    const provider =
      (typeof raw.defaultProvider === "string" && raw.defaultProvider) ||
      (typeof raw.default_provider === "string" && raw.default_provider) ||
      (typeof raw.provider === "string" && raw.provider) ||
      undefined;
    const modelId =
      (typeof raw.defaultModel === "string" && raw.defaultModel) ||
      (typeof raw.default_model === "string" && raw.default_model) ||
      (typeof raw.model === "string" && raw.model) ||
      undefined;
    const thinkingLevel =
      (typeof raw.defaultThinkingLevel === "string" && raw.defaultThinkingLevel) ||
      (typeof raw.thinkingLevel === "string" && raw.thinkingLevel) ||
      undefined;

    return { provider, modelId, thinkingLevel };
  } catch {
    return undefined;
  }
}

export async function refreshAvailableModelCatalog(input: {
  agentDir: string;
  dataDir: string;
  force?: boolean;
  /** Limit the refresh to these providers; omitted refreshes every provider. */
  providers?: readonly string[];
}): Promise<ModelCatalogRefreshResult> {
  // ModelRuntime treats any set PI_OFFLINE as network-disabled, but an
  // explicit allowNetwork: true would still fetch. Refuse before create.
  if (process.env.PI_OFFLINE !== undefined) {
    return { offline: true };
  }

  // Create stays offline so opening the catalog never fetches. Network
  // access is this explicit refresh(), and PI_OFFLINE still blocks it.
  const runtime = await createPaceModelRuntime(input);
  const result = await runtime.refresh({
    allowNetwork: true,
    force: input.force === true,
    ...(input.providers ? { providers: input.providers } : {}),
  });
  const errors: Record<string, string> = {};

  for (const [providerId, error] of result.errors) {
    errors[providerId] = error instanceof Error ? error.message : String(error);
  }

  return {
    refreshedAt: new Date().toISOString(),
    errors,
  };
}

export async function listAvailableModelControls(input: {
  agentDir: string;
  dataDir: string;
}): Promise<RuntimeModelControls> {
  const runtime = await createPaceModelRuntime(input);
  const registry = new ModelRegistry(runtime);

  const models = registry
    .getAvailable()
    .map((model) =>
      capabilityFromRegistryModel({
        id: model.id,
        name: model.name,
        provider: model.provider,
        reasoning: Boolean((model as { reasoning?: boolean }).reasoning),
        thinkingLevelMap: (model as {
          thinkingLevelMap?: Partial<Record<RuntimeThinkingLevel, string | null>>;
        }).thinkingLevelMap,
        contextWindow: (model as { contextWindow?: number }).contextWindow,
        maxTokens: (model as { maxTokens?: number }).maxTokens,
        input: (model as { input?: string[] }).input,
      }),
    )
    .sort(compareModelCapabilities);

  const preferred = await readSettingsPreferredModel(input.agentDir);

  return {
    models,
    selected: defaultSelection(models, preferred),
  };
}
