// The one model → capability mapping. The main process catalog and every
// Session process adapter both map Pi models through here, so Settings, the
// draft composer and a live selector cannot drift apart (ADR-0043 §3).

import type {
  RuntimeModelCapability,
  RuntimeModelSelection,
  RuntimeThinkingLevel,
} from "./runtime-gateway";

export const thinkingLevelOrder: readonly RuntimeThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** The Pi model fields Pace reads. Structural, so core never imports the Pi SDK. */
export type CatalogModel = {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<RuntimeThinkingLevel, string | null>>;
  contextWindow?: number;
  maxTokens?: number;
  input?: readonly string[];
};

export function thinkingLevelsForModel(
  model: Pick<CatalogModel, "reasoning" | "thinkingLevelMap">,
): RuntimeThinkingLevel[] {
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

export function capabilityFromModel(model: CatalogModel): RuntimeModelCapability {
  const capability: RuntimeModelCapability = {
    provider: model.provider,
    modelId: model.id,
    name: model.name?.trim() || model.id,
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

/**
 * Selection for a surface without a Session (the draft composer): the Pi
 * settings default when it is still available, else the first model at its
 * deepest thinking level.
 */
export function defaultSelection(
  models: readonly RuntimeModelCapability[],
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
