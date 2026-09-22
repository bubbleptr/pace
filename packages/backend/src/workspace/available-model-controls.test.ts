import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  listAvailableModelControls,
  refreshAvailableModelCatalog,
} from "./available-model-controls";

async function tempAgentDir() {
  return mkdtemp(join(tmpdir(), "pigui-model-controls-"));
}

describe("listAvailableModelControls", () => {
  it("returns empty models when no auth is configured", async () => {
    const agentDir = await tempAgentDir();
    const controls = await listAvailableModelControls({ agentDir });

    expect(controls.models).toEqual([]);
    expect(controls.selected).toBeNull();
  });

  it("lists models for a configured provider", async () => {
    const agentDir = await tempAgentDir();
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "sk-test-openai" } }),
      "utf8",
    );

    const controls = await listAvailableModelControls({ agentDir });

    expect(controls.models.length).toBeGreaterThan(0);
    expect(controls.models.every((model) => model.provider && model.modelId)).toBe(true);
    expect(controls.selected).not.toBeNull();
    expect(controls.models.some((model) => model.provider === "openai")).toBe(true);
  });

  it("lists Codex subscription models from openai-codex OAuth in auth.json", async () => {
    const agentDir = await tempAgentDir();
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "sk-codex-access-ae1d",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          accountId: "acct_1",
        },
      }),
      "utf8",
    );

    const controls = await listAvailableModelControls({ agentDir });

    expect(controls.models.some((model) => model.provider === "openai-codex")).toBe(
      true,
    );
    expect(controls.selected).not.toBeNull();
  });

  it("passes catalog metadata (context window, max tokens, modalities) through", async () => {
    const agentDir = await tempAgentDir();
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "sk-test-openai" } }),
      "utf8",
    );

    const controls = await listAvailableModelControls({ agentDir });

    // Every catalog model ships these fields; the mapping must not drop them.
    expect(
      controls.models.every(
        (model) =>
          typeof model.contextWindow === "number" && model.contextWindow > 0,
      ),
    ).toBe(true);
    expect(
      controls.models.every(
        (model) => typeof model.maxTokens === "number" && model.maxTokens > 0,
      ),
    ).toBe(true);
    expect(
      controls.models.every(
        (model) =>
          Array.isArray(model.input) && model.input.includes("text"),
      ),
    ).toBe(true);
  });
});

function catalogModel(provider: string, id: string, name: string) {
  return {
    provider,
    id,
    name,
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
    input: ["text"],
  };
}

describe("refresh_model_catalog", () => {
  const offlineBefore = process.env.PI_OFFLINE;

  afterEach(() => {
    vi.restoreAllMocks();
    if (offlineBefore === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offlineBefore;
  });

  it("publishes models a network refresh adds to the runtime snapshot", async () => {
    const agentDir = await tempAgentDir();
    let snapshot = [catalogModel("openai", "gpt-4.1", "GPT-4.1")];
    const refresh = vi.fn(async () => {
      snapshot = [
        ...snapshot,
        catalogModel("xai", "grok-4.7", "Grok 4.7"),
      ];
      return { aborted: false, errors: new Map() };
    });
    const create = vi.spyOn(ModelRuntime, "create").mockImplementation(async () => ({
      refresh,
      getAvailableSnapshot: () => snapshot,
    }) as unknown as ModelRuntime);

    const before = await listAvailableModelControls({ agentDir });
    expect(before.models.map((model) => model.modelId)).toEqual(["gpt-4.1"]);

    const result = await refreshAvailableModelCatalog({ agentDir, force: true });

    expect(result).toEqual({
      refreshedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      errors: {},
    });
    expect(create).toHaveBeenCalledWith({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: true, force: true });
    const after = await listAvailableModelControls({ agentDir });
    expect(after.models.map((model) => model.modelId)).toEqual([
      "gpt-4.1",
      "grok-4.7",
    ]);
  });

  it("returns one provider's refresh error and keeps the models other providers published", async () => {
    const agentDir = await tempAgentDir();
    let snapshot = [catalogModel("openai", "gpt-4.1", "GPT-4.1")];
    const refresh = vi.fn(async () => {
      snapshot = [
        catalogModel("anthropic", "claude-sonnet", "Claude Sonnet"),
        ...snapshot,
      ];
      return {
        aborted: false,
        errors: new Map([["xai", new Error("catalog unavailable")]]),
      };
    });
    vi.spyOn(ModelRuntime, "create").mockImplementation(async () => ({
      refresh,
      getAvailableSnapshot: () => snapshot,
    }) as unknown as ModelRuntime);

    const result = await refreshAvailableModelCatalog({ agentDir });

    expect(result).toEqual({
      refreshedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      errors: { xai: "catalog unavailable" },
    });
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: true, force: false });
    const after = await listAvailableModelControls({ agentDir });
    expect(after.models.map((model) => model.modelId)).toEqual([
      "claude-sonnet",
      "gpt-4.1",
    ]);
  });

  it("does not refresh over the network when PI_OFFLINE is set", async () => {
    const agentDir = await tempAgentDir();
    process.env.PI_OFFLINE = "1";
    const create = vi.spyOn(ModelRuntime, "create");

    await expect(refreshAvailableModelCatalog({ agentDir, force: true })).resolves.toEqual({
      offline: true,
    });
    expect(create).not.toHaveBeenCalled();
  });
});
