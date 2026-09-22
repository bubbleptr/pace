import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPaceModelRuntime } from "./account-models";

const accountId = "acct_1";

async function setup(options: { cache?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pace-account-models-"));
  const agentDir = join(root, "agent");
  const dataDir = join(root, "data");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(agentDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
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
    JSON.stringify({ "openai-codex": { models: [], checkedAt: Date.now(), lastModified: 0 } }),
    "utf8",
  );
  if (options.cache !== undefined) {
    await writeFile(join(dataDir, "account-models.json"), JSON.stringify(options.cache), "utf8");
  }
  return { agentDir, dataDir };
}

function codexIds(runtime: { getAvailableSnapshot(): readonly { provider: string; id: string }[] }) {
  return runtime
    .getAvailableSnapshot()
    .filter((model) => model.provider === "openai-codex")
    .map((model) => model.id);
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
      cache: cacheFor([
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
        { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
      ]),
    });

    const runtime = await createPaceModelRuntime({ agentDir, dataDir });

    expect(codexIds(runtime)).toEqual(["gpt-5.5"]);
  });

  it("shows account models the Pi catalog does not know yet", async () => {
    const { agentDir, dataDir } = await setup({
      cache: cacheFor([
        { slug: "gpt-6-sol", display_name: "GPT-6-Sol", context_window: 400_000, visibility: "list" },
      ]),
    });

    const runtime = await createPaceModelRuntime({ agentDir, dataDir });
    const model = runtime.getModel("openai-codex", "gpt-6-sol");

    expect(codexIds(runtime)).toEqual(["gpt-6-sol"]);
    expect(model).toMatchObject({ name: "GPT-6-Sol", contextWindow: 400_000 });
    // Borrowed from a catalog sibling so the model can actually stream.
    expect(model?.api).toBe(runtime.getModel("openai-codex", "gpt-5.5")?.api ?? model?.api);
    expect(model?.baseUrl).toBeTruthy();
  });

  it("ignores a cached list that belongs to another account", async () => {
    const { agentDir, dataDir } = await setup({
      cache: { "openai-codex": { accountId: "acct_other", checkedAt: Date.now(), models: [
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
      ] } },
    });

    const runtime = await createPaceModelRuntime({ agentDir, dataDir });

    expect(codexIds(runtime)).toContain("gpt-5.3-codex-spark");
  });

  it("fetches the account list on a network refresh and persists it for later runtimes", async () => {
    const { agentDir, dataDir } = await setup();
    const fetch = vi.fn(async () =>
      codexModelsResponse([{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" }]),
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
      cache: cacheFor([{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" }]),
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
  ])("keeps the previous list after %s", async (_label, respond) => {
    const { agentDir, dataDir } = await setup({
      cache: cacheFor([{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" }], 0),
    });
    const runtime = await createPaceModelRuntime({ agentDir, dataDir, fetch: vi.fn(async () => respond()) });

    const result = await runtime.refresh({ allowNetwork: true, providers: ["openai-codex"] });

    expect(result.errors.has("openai-codex")).toBe(true);
    expect(codexIds(runtime)).toEqual(["gpt-5.5"]);
  });
});
