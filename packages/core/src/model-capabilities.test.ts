import { describe, expect, it } from "vitest";
import { capabilityFromModel } from "./model-capabilities";

describe("capabilityFromModel", () => {
  it("names a model by its id when Pi reports a blank name", () => {
    expect(capabilityFromModel({ provider: "openai", id: "gpt-x", name: "  " }).name).toBe("gpt-x");
    expect(capabilityFromModel({ provider: "openai", id: "gpt-x" }).name).toBe("gpt-x");
  });

  it("offers xhigh and max only when the model maps them, and drops levels mapped to null", () => {
    const base = { provider: "openai", id: "gpt-x", name: "GPT X", reasoning: true };

    expect(capabilityFromModel(base).thinkingLevels).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(
      capabilityFromModel({ ...base, thinkingLevelMap: { minimal: null, xhigh: "xhigh" } })
        .thinkingLevels,
    ).toEqual(["off", "low", "medium", "high", "xhigh"]);
    expect(capabilityFromModel({ ...base, reasoning: false }).thinkingLevels).toEqual(["off"]);
  });
});
