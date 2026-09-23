import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPaceModelRuntime } from "./account-models";

const accountId = "acct_1";

async function setup(options: { cache?: unknown; auth?: Record<string, unknown> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pace-account-models-"));
  const agentDir = join(root, "agent");
  const dataDir = join(root, "data");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(agentDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify(options.auth ?? {
      "openai-codex": {
        type: "oauth",
        access: "codex-access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60 * 60_000,
        accountId,
      },
    }),
    "utf8",
  );
  // A fresh, empty pi.dev overlay so network refreshes in these tests never
  // reach the real remote catalog.
  await writeFile(
    join(agentDir, "models-store.json"),
    JSON.stringify(Object.fromEntries(
      ["openai-codex", "openai", "anthropic"].map((id) => [id, { models: [], checkedAt: Date.now(), lastModified: 0 }]),
    )),
    "utf8",
  );
  if (options.cache !== undefined) {
    await writeFile(join(dataDir, "account-models.json"), JSON.stringify(options.cache), "utf8");
  }
  return { agentDir, dataDir };
}

type SnapshotRuntime = { getAvailableSnapshot(): readonly { provider: string; id: string }[] };

function providerIds(runtime: SnapshotRuntime, provider: string) {
  return runtime
    .getAvailableSnapshot()
    .filter((model) => model.provider === provider)
    .map((model) => model.id);
}

function codexIds(runtime: SnapshotRuntime) {
  return providerIds(runtime, "openai-codex");
}

function cacheFor(models: unknown[], checkedAt = Date.now()) {
  return { "openai-codex": { accountId, checkedAt, models } };
}

function codexModelsResponse(models: unknown[]) {
  return new Response(JSON.stringify({ models }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("createPaceModelRuntime", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("unexpected network access");
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the Pi catalog when the account list has never been fetched", async () => {
    const { agentDir, dataDir } = await setup();

    const runtime = await createPaceModelRuntime({ agentDir, dataDir });

    expect(codexIds(runtime)).toContain("gpt-5.3-codex-spark");
  });

  it("limits the subscription to models the account lists", async () => {
    const { agentDir, dataDir } = await setup({
      cache: cacheFor([{ id: "gpt-5.5", name: "GPT-5.5" }]),
    });

    const runtime = await createPaceModelRuntime({ agentDir, dataDir });

    expect(codexIds(runtime)).toEqual(["gpt-5.5"]);
  });

  it("shows account models the Pi catalog does not know yet", async () => {
    const { agentDir, dataDir } = await setup({
      cache: cacheFor([
        { id: "gpt-99-unreleased", name: "GPT-99-Unreleased", contextWindow: 400_000 },
      ]),
    });

    const runtime = await createPaceModelRuntime({ agentDir, dataDir });
    const model = runtime.getModel("openai-codex", "gpt-99-unreleased");

    expect(codexIds(runtime)).toEqual(["gpt-99-unreleased"]);
    expect(model).toMatchObject({ name: "GPT-99-Unreleased", contextWindow: 400_000 });
    // Borrowed from a catalog sibling so the model can actually stream.
    expect(model?.api).toBe(runtime.getModel("openai-codex", "gpt-5.5")?.api ?? model?.api);
    expect(model?.baseUrl).toBeTruthy();
  });

  it("ignores a cached list it cannot read instead of hiding every model", async () => {
    const { agentDir, dataDir } = await setup({
      cache: cacheFor([{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" }]),
    });

    const runtime = await createPaceModelRuntime({ agentDir, dataDir });

    expect(codexIds(runtime)).toContain("gpt-5.3-codex-spark");
  });

  it("ignores a cached list that belongs to another account", async () => {
    const { agentDir, dataDir } = await setup({
      cache: { "openai-codex": { accountId: "acct_other", checkedAt: Date.now(), models: [
        { id: "gpt-5.5", name: "GPT-5.5" },
      ] } },
    });

    const runtime = await createPaceModelRuntime({ agentDir, dataDir });

    expect(codexIds(runtime)).toContain("gpt-5.3-codex-spark");
  });

  it("fetches the account list on a network refresh and persists it for later runtimes", async () => {
    const { agentDir, dataDir } = await setup();
    const fetch = vi.fn(async () =>
      codexModelsResponse([
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
        { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
      ]),
    );

    const runtime = await createPaceModelRuntime({ agentDir, dataDir, fetch });
    const result = await runtime.refresh({ allowNetwork: true, providers: ["openai-codex"] });

    expect(result.errors.size).toBe(0);
    expect(codexIds(runtime)).toEqual(["gpt-5.5"]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/chatgpt\.com\/backend-api\/codex\/models\?client_version=/);
    expect(new Headers(init.headers).get("chatgpt-account-id")).toBe(accountId);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer codex-access-token");

    const offline = await createPaceModelRuntime({ agentDir, dataDir });
    expect(codexIds(offline)).toEqual(["gpt-5.5"]);
    expect(JSON.parse(await readFile(join(dataDir, "account-models.json"), "utf8"))["openai-codex"].accountId).toBe(accountId);
  });

  it("does not refetch a fresh account list unless forced", async () => {
    const { agentDir, dataDir } = await setup({
      cache: cacheFor([{ id: "gpt-5.5", name: "GPT-5.5" }]),
    });
    const fetch = vi.fn(async () =>
      codexModelsResponse([{ slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" }]),
    );
    const runtime = await createPaceModelRuntime({ agentDir, dataDir, fetch });

    await runtime.refresh({ allowNetwork: true, providers: ["openai-codex"] });
    expect(fetch).not.toHaveBeenCalled();

    await runtime.refresh({ allowNetwork: true, force: true, providers: ["openai-codex"] });
    expect(codexIds(runtime)).toEqual(["gpt-5.6-sol"]);
  });

  it.each([
    ["a failed request", () => new Response("nope", { status: 500 })],
    ["an empty list", () => codexModelsResponse([])],
    ["only hidden models", () => codexModelsResponse([{ slug: "codex-auto-review", visibility: "hide" }])],
  ])("keeps the previous list after %s", async (_label, respond) => {
    const { agentDir, dataDir } = await setup({
      cache: cacheFor([{ id: "gpt-5.5", name: "GPT-5.5" }], 0),
    });
    const runtime = await createPaceModelRuntime({ agentDir, dataDir, fetch: vi.fn(async () => respond()) });

    const result = await runtime.refresh({ allowNetwork: true, providers: ["openai-codex"] });

    expect(result.errors.has("openai-codex")).toBe(true);
    expect(codexIds(runtime)).toEqual(["gpt-5.5"]);
  });

  describe("API key providers", () => {
    it("limits OpenAI to catalog models the key can list, without adding raw API models", async () => {
      const { agentDir, dataDir } = await setup({ auth: { openai: { type: "api_key", key: "sk-openai-test" } } });
      const fetch = vi.fn(async () =>
        Response.json({ data: [{ id: "gpt-4.1" }, { id: "text-embedding-3-large" }] }),
      );
      const runtime = await createPaceModelRuntime({ agentDir, dataDir, fetch });

      expect(providerIds(runtime, "openai").length).toBeGreaterThan(1);
      await runtime.refresh({ allowNetwork: true, providers: ["openai"] });

      expect(providerIds(runtime, "openai")).toEqual(["gpt-4.1"]);
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.openai.com/v1/models");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-openai-test");
    });

    it("lists Anthropic models with the Anthropic headers", async () => {
      const { agentDir, dataDir } = await setup({ auth: { anthropic: { type: "api_key", key: "sk-ant-test" } } });
      const fetch = vi.fn(async () => Response.json({ data: [{ id: "claude-fable-5" }], has_more: false }));
      const runtime = await createPaceModelRuntime({ agentDir, dataDir, fetch });

      await runtime.refresh({ allowNetwork: true, providers: ["anthropic"] });

      expect(providerIds(runtime, "anthropic")).toEqual(["claude-fable-5"]);
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
      expect(new Headers(init.headers).get("x-api-key")).toBe("sk-ant-test");
      expect(new Headers(init.headers).get("anthropic-version")).toBeTruthy();
    });

    it("never writes the key to the cache and drops the list when the key changes", async () => {
      const { agentDir, dataDir } = await setup({ auth: { openai: { type: "api_key", key: "sk-openai-test" } } });
      const fetch = vi.fn(async () => Response.json({ data: [{ id: "gpt-4.1" }] }));
      const runtime = await createPaceModelRuntime({ agentDir, dataDir, fetch });
      await runtime.refresh({ allowNetwork: true, providers: ["openai"] });

      expect(await readFile(join(dataDir, "account-models.json"), "utf8")).not.toContain("sk-openai-test");

      await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "sk-openai-other" } }), "utf8");
      const next = await createPaceModelRuntime({ agentDir, dataDir });
      expect(providerIds(next, "openai").length).toBeGreaterThan(1);
    });
  });
});
