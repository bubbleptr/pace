import { describe, expect, it } from "vitest";
import type { RuntimeModelCapability } from "@pace/core";
import {
  baseModelOf,
  fastSiblingOf,
  isListedByAnotherProvider,
  formatContextWindow,
  isInsideTriangle,
  isModelVisible,
  matchesModelQuery,
  nearestThinkingLevel,
  visibleModelsOf,
} from "./model-selector-logic";

const grok: RuntimeModelCapability = {
  provider: "xai",
  modelId: "grok-4",
  name: "Grok 4",
  thinkingLevels: ["off", "medium", "high", "xhigh"],
  contextWindow: 256_000,
  maxTokens: 32_000,
  input: ["text", "image"],
};

const grokFast: RuntimeModelCapability = {
  provider: "xai",
  modelId: "grok-4-fast",
  name: "Grok 4 Fast",
  thinkingLevels: ["off", "medium", "high"],
  contextWindow: 256_000,
  maxTokens: 32_000,
  input: ["text", "image"],
};

const sonnet: RuntimeModelCapability = {
  provider: "anthropic",
  modelId: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  thinkingLevels: ["off", "low", "medium", "high"],
};

const models = [grok, grokFast, sonnet];

describe("fast sibling grouping", () => {
  it("pairs a base model with its -fast sibling within the same provider", () => {
    expect(fastSiblingOf(grok, models)).toBe(grokFast);
    expect(fastSiblingOf(grokFast, models)).toBe(grok);
  });

  it("returns undefined when no sibling exists", () => {
    expect(fastSiblingOf(sonnet, models)).toBeUndefined();
  });

  it("never pairs across providers", () => {
    const foreignFast: RuntimeModelCapability = {
      ...grokFast,
      provider: "other",
    };

    expect(fastSiblingOf(grok, [grok, foreignFast])).toBeUndefined();
  });

  it("resolves the family base from either member", () => {
    expect(baseModelOf(grokFast, models)).toBe(grok);
    expect(baseModelOf(grok, models)).toBe(grok);
    expect(baseModelOf(sonnet, models)).toBe(sonnet);
  });
});

describe("matchesModelQuery", () => {
  it("matches by name, id, and provider, tokenized", () => {
    expect(matchesModelQuery(grok, "grok")).toBe(true);
    expect(matchesModelQuery(grok, "xai grok")).toBe(true);
    expect(matchesModelQuery(grok, "grok-4")).toBe(true);
    expect(matchesModelQuery(grok, "sonnet")).toBe(false);
  });

  it("treats an empty query as match-all", () => {
    expect(matchesModelQuery(grok, "")).toBe(true);
    expect(matchesModelQuery(grok, "   ")).toBe(true);
  });
});

describe("model visibility", () => {
  const onlySonnet = [{ provider: "anthropic", modelId: "claude-sonnet-4" }];

  it("shows the whole catalog while nothing is configured", () => {
    expect(visibleModelsOf(models, null, null)).toEqual(models);
  });

  it("shows nothing once the user cleared every model, except the current selection", () => {
    expect(visibleModelsOf(models, [], null)).toEqual([]);
    expect(visibleModelsOf(models, [], grok)).toEqual([grok]);
  });

  it("keeps only the models the user made visible", () => {
    expect(visibleModelsOf(models, onlySonnet, null)).toEqual([sonnet]);
  });

  it("keeps the current selection listed even when it was hidden", () => {
    expect(visibleModelsOf(models, onlySonnet, grok)).toEqual([grok, sonnet]);
    expect(isModelVisible(grok, onlySonnet)).toBe(false);
    expect(isModelVisible(sonnet, onlySonnet)).toBe(true);
  });
});

describe("nearestThinkingLevel", () => {
  it("keeps the level when available", () => {
    expect(nearestThinkingLevel("high", ["off", "medium", "high"])).toBe("high");
  });

  it("snaps to the numerically nearest available level", () => {
    expect(nearestThinkingLevel("xhigh", ["off", "medium", "high"])).toBe("high");
    expect(nearestThinkingLevel("minimal", ["off", "high"])).toBe("off");
  });
});

describe("formatContextWindow", () => {
  it("renders round K and M values", () => {
    expect(formatContextWindow(200_000)).toBe("200K");
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(2_000_000)).toBe("2M");
  });
});

describe("isInsideTriangle", () => {
  const apex = { x: 100, y: 300 };
  const top = { x: 400, y: 92 };
  const bottom = { x: 400, y: 508 };

  it("accepts points inside the cone toward the flyout", () => {
    expect(isInsideTriangle({ x: 250, y: 300 }, apex, top, bottom)).toBe(true);
    expect(isInsideTriangle({ x: 220, y: 230 }, apex, top, bottom)).toBe(true);
  });

  it("rejects points outside the cone", () => {
    expect(isInsideTriangle({ x: 102, y: 380 }, apex, top, bottom)).toBe(false);
    expect(isInsideTriangle({ x: 60, y: 300 }, apex, top, bottom)).toBe(false);
    expect(isInsideTriangle({ x: 220, y: 210 }, apex, top, bottom)).toBe(false);
  });
});

describe("isListedByAnotherProvider", () => {
  const codex: RuntimeModelCapability = { ...grok, provider: "openai-codex", modelId: "gpt-5.5", name: "GPT-5.5" };
  const api: RuntimeModelCapability = { ...codex, provider: "openai" };
  const onlyApi: RuntimeModelCapability = { ...api, modelId: "gpt-4.1", name: "GPT-4.1" };

  it("flags a model that more than one provider serves, so rows can name their channel", () => {
    const models = [codex, api, onlyApi];

    expect(isListedByAnotherProvider(codex, models)).toBe(true);
    expect(isListedByAnotherProvider(api, models)).toBe(true);
    expect(isListedByAnotherProvider(onlyApi, models)).toBe(false);
  });

  it("does not count a fast sibling from the same provider", () => {
    expect(isListedByAnotherProvider(grok, [grok, grokFast])).toBe(false);
  });
});
