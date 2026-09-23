import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicPiSdkRuntimeFactory } from "../drivers/pi-sdk-runtime-adapter";
import { createModelCatalog, type ModelCatalogRuntime } from "./model-catalog";

type FakeModel = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow?: number;
  input?: string[];
};

function fakeRuntime(initial: FakeModel[] = []) {
  let snapshot = initial;
  const calls: string[] = [];
  const refresh = vi.fn(async (_options?: unknown) => {
    calls.push("runtime.refresh");
    return { aborted: false, errors: new Map<string, unknown>() };
  });
  const runtime = {
    getAvailableSnapshot: () => snapshot,
    refresh,
  } as unknown as ModelCatalogRuntime;
  const create = vi.fn(async () => runtime);
  return {
    create,
    refresh,
    calls,
    setSnapshot(next: FakeModel[]) {
      snapshot = next;
    },
  };
}

function catalogFor(
  runtime: ReturnType<typeof fakeRuntime>,
  options: Partial<Parameters<typeof createModelCatalog>[0]> = {},
) {
  const log = vi.fn();
  const catalog = createModelCatalog({
    runtime: runtime.create,
    readPreferredModel: async () => undefined,
    providers: ["openai-codex"],
    log,
    ...options,
  });
  return { catalog, log };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("model catalog", () => {
  it("lists the same capabilities, in the same order, as a live session's snapshot", async () => {
    // Composition order differs from display order, and one model has a blank
    // name: the draft list and a live session once disagreed on both.
    const available: FakeModel[] = [
      { provider: "xai", id: "grok-4", name: "Grok 4", reasoning: false, input: ["text", "image"] },
      { provider: "openai", id: "gpt-x", name: "", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
      { provider: "anthropic", id: "claude-opus", name: "Claude Opus", reasoning: true, contextWindow: 200_000 },
    ];
    const runtime = fakeRuntime(available);
    const { catalog } = catalogFor(runtime);
    const session = {
      sessionId: "sdk-session-parity",
      isStreaming: false,
      messages: [],
      model: available[0],
      thinkingLevel: "off",
      modelRuntime: {
        getModel: (provider: string, modelId: string) =>
          available.find((model) => model.provider === provider && model.id === modelId),
        getAvailableSnapshot: () => available,
      },
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const live = await createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession: async () => ({ session }) },
    })({ sessionId: "app-session-parity", projectId: "pig", cwd: "/repo" });

    const draft = await catalog.list();

    expect(draft.models.map((model) => model.name)).toEqual(["Claude Opus", "gpt-x", "Grok 4"]);
    expect(live.modelControls?.models).toEqual(draft.models);
    await live.dispose?.();
  });

  it("selects the Pi settings default, else the first model at its deepest thinking level", async () => {
    const runtime = fakeRuntime([
      { provider: "openai", id: "gpt-x", name: "GPT X", reasoning: true },
      { provider: "anthropic", id: "claude", name: "Claude", reasoning: false },
    ]);

    await expect(catalogFor(runtime).catalog.list()).resolves.toMatchObject({
      selected: { provider: "anthropic", modelId: "claude", thinkingLevel: "off" },
    });
    await expect(
      catalogFor(runtime, {
        readPreferredModel: async () => ({ provider: "openai", modelId: "gpt-x", thinkingLevel: "low" }),
      }).catalog.list(),
    ).resolves.toMatchObject({
      selected: { provider: "openai", modelId: "gpt-x", thinkingLevel: "low" },
    });
    await expect(catalogFor(fakeRuntime([])).catalog.list()).resolves.toEqual({
      models: [],
      selected: null,
    });
  });

  it("keeps one runtime for its lifetime and lists without touching the network", async () => {
    const runtime = fakeRuntime([{ provider: "openai", id: "gpt-x", name: "GPT X", reasoning: false }]);
    const { catalog } = catalogFor(runtime);

    await catalog.list();
    await catalog.refresh({ allowNetwork: true });
    runtime.setSnapshot([
      { provider: "openai", id: "gpt-x", name: "GPT X", reasoning: false },
      { provider: "xai", id: "grok-4", name: "Grok 4", reasoning: false },
    ]);
    const after = await catalog.list();

    expect(runtime.create).toHaveBeenCalledOnce();
    expect(runtime.refresh).toHaveBeenCalledOnce();
    expect(after.models.map((model) => model.modelId)).toEqual(["gpt-x", "grok-4"]);
  });

  it("refreshes every provider over the network, fans out, and reports per-provider errors", async () => {
    const runtime = fakeRuntime();
    runtime.refresh.mockResolvedValueOnce({
      aborted: false,
      errors: new Map([["xai", new Error("catalog unavailable")]]),
    });
    const refreshModelCatalog = vi.fn(async () => {});
    const { catalog } = catalogFor(runtime, { liveSessions: { refreshModelCatalog } });

    await expect(catalog.refresh({ allowNetwork: true, force: true })).resolves.toEqual({
      refreshedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      errors: { xai: "catalog unavailable" },
    });
    expect(runtime.refresh).toHaveBeenCalledWith({ allowNetwork: true, force: true });
    expect(refreshModelCatalog).toHaveBeenCalledOnce();
  });

  it.each([
    ["allowNetwork is false", false, undefined],
    ["PI_OFFLINE is set", true, "1"],
  ])("returns offline without refreshing or fanning out when %s", async (_label, allowNetwork, offline) => {
    if (offline) vi.stubEnv("PI_OFFLINE", offline);
    const runtime = fakeRuntime();
    const refreshModelCatalog = vi.fn(async () => {});
    const listener = vi.fn();
    const { catalog } = catalogFor(runtime, { liveSessions: { refreshModelCatalog } });
    catalog.subscribe(listener);

    await expect(catalog.refresh({ allowNetwork, force: true })).resolves.toEqual({ offline: true });
    expect(runtime.create).not.toHaveBeenCalled();
    expect(refreshModelCatalog).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("refreshes account models before fanning out on every credential change", async () => {
    const runtime = fakeRuntime();
    const refreshModelCatalog = vi.fn(async () => {
      runtime.calls.push("liveSessions.refreshModelCatalog");
    });
    const { catalog } = catalogFor(runtime, { liveSessions: { refreshModelCatalog } });

    // One policy for set key, OAuth login, remove and logout alike.
    for (let change = 0; change < 4; change++) {
      await catalog.onCredentialChanged();
    }

    expect(runtime.calls).toEqual(
      Array.from({ length: 4 }, () => ["runtime.refresh", "liveSessions.refreshModelCatalog"]).flat(),
    );
    expect(runtime.refresh).toHaveBeenCalledWith({ allowNetwork: true, providers: ["openai-codex"] });
  });

  it("still fans out a credential change when the account refresh or live sessions fail", async () => {
    const runtime = fakeRuntime();
    runtime.refresh.mockRejectedValueOnce(new Error("chatgpt.com is down"));
    const refreshModelCatalog = vi.fn(async () => {});
    refreshModelCatalog.mockRejectedValueOnce(new Error("session process is gone"));
    const { catalog, log } = catalogFor(runtime, { liveSessions: { refreshModelCatalog } });

    await expect(catalog.onCredentialChanged()).resolves.toBeUndefined();
    expect(refreshModelCatalog).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("stops waiting for a live session that never answers after the fan-out timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const runtime = fakeRuntime();
    const { catalog, log } = catalogFor(runtime, {
      liveSessions: { refreshModelCatalog: () => new Promise<void>(() => {}) },
      fanOutTimeoutMs: 50,
    });
    let settled = false;

    const pending = catalog.refresh({ allowNetwork: true }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({
      refreshedAt: expect.any(String),
      errors: {},
    });
    expect(log).toHaveBeenCalledWith(
      "Pace could not refresh live session model catalogs.",
      expect.objectContaining({ message: expect.stringContaining("timed out") }),
    );
  });

  it("notifies subscribers once per completed refresh until they unsubscribe", async () => {
    const runtime = fakeRuntime();
    const { catalog } = catalogFor(runtime);
    const listener = vi.fn();
    const unsubscribe = catalog.subscribe(listener);

    await catalog.refresh({ allowNetwork: true });
    expect(listener).toHaveBeenCalledOnce();
    await catalog.onCredentialChanged();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await catalog.refresh({ allowNetwork: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("refreshes account models once in the background when asked to at startup", async () => {
    const runtime = fakeRuntime();
    const refreshModelCatalog = vi.fn(async () => {});
    const { catalog } = catalogFor(runtime, {
      liveSessions: { refreshModelCatalog },
      refreshOnStart: true,
    });
    const listener = vi.fn();
    catalog.subscribe(listener);

    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(runtime.refresh).toHaveBeenCalledWith({ allowNetwork: true, providers: ["openai-codex"] });
    expect(refreshModelCatalog).toHaveBeenCalledOnce();
  });
});
