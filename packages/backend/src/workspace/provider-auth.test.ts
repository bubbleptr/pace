import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  createProviderAuthService,
  type ProviderAuthRuntime,
} from "./provider-auth";
import { createPaceModelRuntime } from "./account-models";

async function tempAgentDir() {
  return mkdtemp(join(tmpdir(), "pigui-provider-auth-"));
}

/** Production wiring: one lazily created Pace runtime for the service's life. */
function realRuntimeService(agentDir: string) {
  let runtime: ReturnType<typeof createPaceModelRuntime> | undefined;
  return createProviderAuthService({
    agentDir,
    runtime: () => (runtime ??= createPaceModelRuntime({ agentDir, dataDir: agentDir })),
  });
}

// Pi counts a provider as configured when the ambient environment carries its
// credentials (API-key env vars, the AWS chain, gcloud ADC under $HOME), and it
// reads process.env live. Strip the host environment so these tests only see
// auth.json; production still counts env-configured providers.
const HERMETIC_ENV_KEEP = new Set(["PATH", "TMPDIR", "TMP", "TEMP", "NODE_ENV"]);

async function isolateFromHostEnvironment() {
  for (const name of Object.keys(process.env)) {
    if (HERMETIC_ENV_KEEP.has(name) || name.startsWith("VITEST")) continue;
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("HOME", await mkdtemp(join(tmpdir(), "pigui-provider-auth-home-")));
}

describe("provider auth service", () => {
  beforeEach(isolateFromHostEnvironment);
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists every runtime provider including Radius and Codex auth shapes", async () => {
    const agentDir = await tempAgentDir();
    const service = realRuntimeService(agentDir);
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
    });

    const report = await service.listStatus();

    expect(report.providers).toHaveLength(runtime.getProviders().length);
    expect(report.providers.find((provider) => provider.id === "radius")).toMatchObject({
      supportsApiKey: true,
      supportsOAuth: true,
    });
    expect(report.providers.find((provider) => provider.id === "openai-codex")).toMatchObject({
      supportsApiKey: false,
      supportsOAuth: true,
    });
  });

  it("reuses openai-codex OAuth already stored in Pi auth.json", async () => {
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
    const service = realRuntimeService(agentDir);

    const report = await service.listStatus();
    const codex = report.providers.find((provider) => provider.id === "openai-codex");

    expect(codex).toMatchObject({
      mode: "oauth",
      configured: true,
      supportsOAuth: true,
      supportsApiKey: false,
      keyHint: "…ae1d",
    });
    expect(report.configuredCount).toBe(1);
    expect(JSON.stringify(report)).not.toContain("sk-codex-access-ae1d");
  });

  it("sets an API key and returns a masked hint without the full secret", async () => {
    const agentDir = await tempAgentDir();
    const service = realRuntimeService(agentDir);

    const report = await service.setApiKey("deepseek", "sk-secret-key-ae1d");

    const deepseek = report.providers.find((provider) => provider.id === "deepseek");
    expect(deepseek).toMatchObject({
      mode: "api_key",
      configured: true,
      keyHint: "…ae1d",
    });
    expect(JSON.stringify(report)).not.toContain("sk-secret-key-ae1d");

    const onDisk = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as {
      deepseek: { type: string; key: string };
    };
    expect(onDisk.deepseek).toEqual({ type: "api_key", key: "sk-secret-key-ae1d" });
  });

  it("removes a provider credential", async () => {
    const agentDir = await tempAgentDir();
    const service = realRuntimeService(agentDir);
    await service.setApiKey("openai", "sk-openai-1234");

    const report = await service.remove("openai");

    expect(report.configuredCount).toBe(0);
    expect(report.providers.find((provider) => provider.id === "openai")?.mode).toBe(
      "none",
    );
  });

  it("rejects empty API keys", async () => {
    const agentDir = await tempAgentDir();
    const service = realRuntimeService(agentDir);

    await expect(service.setApiKey("openai", "   ")).rejects.toThrow(/empty/i);
  });

  it("rejects API keys when Pi reports the provider as oauth-only", async () => {
    const agentDir = await tempAgentDir();
    const service = realRuntimeService(agentDir);

    await expect(service.setApiKey("openai-codex", "sk-not-a-key")).rejects.toThrow(
      /does not support API keys/i,
    );
  });

  it("defaults Codex subscription login to the browser OAuth method", async () => {
    const agentDir = await tempAgentDir();
    let selected: string | undefined;
    const runtime: ProviderAuthRuntime = {
      getProviderAuthStatus: () => ({ configured: false }),
      getProviders: () => [
        { id: "openai-codex", name: "OpenAI Codex", auth: { oauth: {} } },
      ],
      async login(_providerId, _type, interaction) {
        selected = await interaction.prompt({
          type: "select",
          message: "Select OpenAI Codex login method:",
          options: [
            { id: "browser", label: "Browser login (default)" },
            { id: "device_code", label: "Device code login (headless)" },
          ],
        });
        return { type: "oauth", access: "a", refresh: "r", expires: 0 };
      },
      getAvailableSnapshot: () => [],
      getModel: () => undefined,
      async completeSimple() {
        throw new Error("not used");
      },
      async logout() {},
      async refresh() {
        return { aborted: false, errors: new Map() };
      },
    };
    const service = createProviderAuthService({
      agentDir,
      runtime: async () => runtime,
    });

    await service.loginOAuth("openai-codex");

    expect(selected).toBe("browser");
  });

  it("reuses xai OAuth already stored in Pi auth.json", async () => {
    const agentDir = await tempAgentDir();
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({
        xai: {
          type: "oauth",
          access: "xai-access-ae1d",
          refresh: "xai-refresh",
          expires: Date.now() + 60_000,
        },
      }),
      "utf8",
    );
    const service = realRuntimeService(agentDir);

    const report = await service.listStatus();
    const xai = report.providers.find((provider) => provider.id === "xai");

    expect(xai).toMatchObject({
      mode: "oauth",
      configured: true,
      supportsOAuth: true,
      supportsApiKey: true,
      keyHint: "…ae1d",
    });
    expect(JSON.stringify(report)).not.toContain("xai-access-ae1d");
  });

  it("opens the xAI device-code verification URI on subscription login", async () => {
    const agentDir = await tempAgentDir();
    const opened: string[] = [];
    const runtime: ProviderAuthRuntime = {
      getProviderAuthStatus: () => ({ configured: false }),
      getProviders: () => [
        { id: "xai", name: "xAI", auth: { apiKey: {}, oauth: {} } },
      ],
      async login(_providerId, _type, interaction) {
        interaction.notify({
          type: "device_code",
          userCode: "ABCD-1234",
          verificationUri: "https://auth.x.ai/activate",
          intervalSeconds: 5,
          expiresInSeconds: 600,
        });
        return { type: "oauth", access: "a", refresh: "r", expires: 0 };
      },
      getAvailableSnapshot: () => [],
      getModel: () => undefined,
      async completeSimple() {
        throw new Error("not used");
      },
      async logout() {},
      async refresh() {
        return { aborted: false, errors: new Map() };
      },
    };
    const service = createProviderAuthService({
      agentDir,
      openExternalUrl: (url) => {
        opened.push(url);
      },
      runtime: async () => runtime,
    });

    await service.loginOAuth("xai");

    expect(opened).toEqual(["https://auth.x.ai/activate"]);
  });
});

function probeModel(provider: string, id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    maxTokens: 1024,
  };
}

type ProbeReply = Awaited<ReturnType<ProviderAuthRuntime["completeSimple"]>>;

async function connectionRuntime(
  probe: ProviderAuthRuntime["completeSimple"],
  options?: {
    models?: Model<"openai-completions">[];
    getModel?: ProviderAuthRuntime["getModel"];
    timeoutMs?: number;
    settings?: Record<string, unknown>;
  },
) {
  const runtime: ProviderAuthRuntime = {
    getProviderAuthStatus: () => ({ configured: true }),
    getProviders: () => [{ id: "anthropic", name: "Anthropic", auth: { apiKey: {} } }],
    getAvailableSnapshot: () => options?.models ?? [probeModel("anthropic", "claude-sonnet-4")],
    getModel: options?.getModel ?? (() => undefined),
    completeSimple: probe,
    async login() {
      return { type: "api_key", key: "k" };
    },
    async logout() {},
    async refresh() {
      return { aborted: false, errors: new Map() };
    },
  };

  const agentDir = await tempAgentDir();
  if (options?.settings) {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(options.settings));
  }
  return createProviderAuthService({
    agentDir,
    connectionTestTimeoutMs: options?.timeoutMs,
    runtime: async () => runtime,
  });
}

describe("test provider connection", () => {
  it("probes the first available model with a one-token ping and reports latency", async () => {
    let seen:
      | {
          modelId: string;
          messages: { role?: string; content?: unknown }[];
          maxTokens?: number;
          sessionId?: string;
        }
      | undefined;
    const service = await connectionRuntime(
      async (model, context, options) => {
        seen = {
          modelId: model.id,
          messages: context.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          maxTokens: options?.maxTokens,
          sessionId: options?.sessionId,
        };
        return { stopReason: "length" } as ProbeReply;
      },
      {
        models: [
          probeModel("openai", "gpt-4.1"),
          probeModel("anthropic", "claude-sonnet-4"),
          probeModel("anthropic", "claude-haiku"),
        ],
      },
    );

    const result = await service.testConnection("anthropic");

    expect(result).toMatchObject({ ok: true, modelId: "claude-sonnet-4" });
    expect(result.ok && result.latencyMs).toEqual(expect.any(Number));
    expect(seen?.modelId).toBe("claude-sonnet-4");
    expect(seen?.maxTokens).toBe(1);
    expect(seen?.messages).toHaveLength(1);
    expect(seen?.messages[0]?.role).toBe("user");
    expect(typeof seen?.messages[0]?.content === "string" && seen.messages[0].content.trim()).toBeTruthy();
    expect(seen?.sessionId).toBeUndefined();
  });

  it("probes the requested model even when it is outside the available snapshot", async () => {
    let modelId: string | undefined;
    const requested = probeModel("anthropic", "claude-opus");
    const service = await connectionRuntime(
      async (model) => {
        modelId = model.id;
        return { stopReason: "stop" } as ProbeReply;
      },
      {
        models: [probeModel("anthropic", "claude-sonnet-4")],
        getModel: (providerId, id) =>
          providerId === "anthropic" && id === "claude-opus" ? requested : undefined,
      },
    );

    await expect(service.testConnection("anthropic", "claude-opus")).resolves.toMatchObject({
      ok: true,
      modelId: "claude-opus",
    });
    expect(modelId).toBe("claude-opus");
  });

  it("moves past a model the account cannot use to the next available model", async () => {
    const probed: string[] = [];
    const service = await connectionRuntime(
      async (model) => {
        probed.push(model.id);
        return model.id === "gpt-5.3-codex-spark"
          ? ({
              stopReason: "error",
              errorMessage:
                "Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
            } as ProbeReply)
          : ({ stopReason: "length" } as ProbeReply);
      },
      {
        models: [
          probeModel("anthropic", "gpt-5.3-codex-spark"),
          probeModel("anthropic", "gpt-5.5"),
        ],
      },
    );

    await expect(service.testConnection("anthropic")).resolves.toMatchObject({
      ok: true,
      modelId: "gpt-5.5",
    });
    expect(probed).toEqual(["gpt-5.3-codex-spark", "gpt-5.5"]);
  });

  it("probes the Pi settings default model first when it belongs to the provider", async () => {
    const probed: string[] = [];
    const service = await connectionRuntime(
      async (model) => {
        probed.push(model.id);
        return { stopReason: "length" } as ProbeReply;
      },
      {
        models: [probeModel("anthropic", "claude-sonnet-4"), probeModel("anthropic", "claude-haiku")],
        settings: { defaultProvider: "anthropic", defaultModel: "claude-haiku" },
      },
    );

    await expect(service.testConnection("anthropic")).resolves.toMatchObject({
      ok: true,
      modelId: "claude-haiku",
    });
    expect(probed).toEqual(["claude-haiku"]);
  });

  it("falls back to snapshot order when the settings default is another provider's or unavailable", async () => {
    const probed: string[] = [];
    const models = [probeModel("anthropic", "claude-sonnet-4"), probeModel("anthropic", "claude-haiku")];
    const probe: ProviderAuthRuntime["completeSimple"] = async (model) => {
      probed.push(model.id);
      return { stopReason: "length" } as ProbeReply;
    };

    for (const settings of [
      { defaultProvider: "openai", defaultModel: "claude-haiku" },
      { defaultProvider: "anthropic", defaultModel: "claude-retired" },
    ]) {
      const service = await connectionRuntime(probe, { models, settings });
      await expect(service.testConnection("anthropic")).resolves.toMatchObject({
        ok: true,
        modelId: "claude-sonnet-4",
      });
    }
    expect(probed).toEqual(["claude-sonnet-4", "claude-sonnet-4"]);
  });

  it("stops at a provider-wide failure instead of trying other models", async () => {
    const probed: string[] = [];
    const service = await connectionRuntime(
      async (model) => {
        probed.push(model.id);
        return { stopReason: "error", errorMessage: "401: Invalid API key" } as ProbeReply;
      },
      {
        models: [probeModel("anthropic", "claude-sonnet-4"), probeModel("anthropic", "claude-haiku")],
      },
    );

    await expect(service.testConnection("anthropic")).resolves.toMatchObject({
      ok: false,
      kind: "auth",
    });
    expect(probed).toEqual(["claude-sonnet-4"]);
  });

  it("reports auth and entitlement failures from the probe response", async () => {
    const responses = ["401: Invalid API key", "403 status code (no body)"];
    const service = await connectionRuntime(async () => {
      return { stopReason: "error", errorMessage: responses.shift() ?? "unknown" } as ProbeReply;
    });

    await expect(service.testConnection("anthropic")).resolves.toMatchObject({
      ok: false,
      kind: "auth",
      modelId: "claude-sonnet-4",
      message: expect.stringMatching(/authentication failed/i),
      detail: "401: Invalid API key",
    });
    await expect(service.testConnection("anthropic")).resolves.toMatchObject({
      ok: false,
      kind: "entitlement",
      modelId: "claude-sonnet-4",
      message: expect.stringMatching(/subscription plan/i),
      detail: "403 status code (no body)",
    });
  });

  it("classifies a resolved connection error from completeSimple as network and keeps the raw text", async () => {
    const responses = ["Connection error.", "Request timed out."];
    const service = await connectionRuntime(async () => {
      return { stopReason: "error", errorMessage: responses.shift() } as ProbeReply;
    });

    await expect(service.testConnection("anthropic")).resolves.toMatchObject({
      ok: false,
      kind: "network",
      modelId: "claude-sonnet-4",
      message: "Network error",
      detail: "Connection error.",
    });
    await expect(service.testConnection("anthropic")).resolves.toMatchObject({
      ok: false,
      kind: "network",
      detail: "Request timed out.",
    });
  });

  it("reports a thrown network error with the socket code and the raw message", async () => {
    const service = await connectionRuntime(() =>
      Promise.reject(Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" })),
    );

    await expect(service.testConnection("anthropic")).resolves.toMatchObject({
      ok: false,
      kind: "network",
      modelId: "claude-sonnet-4",
      message: expect.stringMatching(/ECONNREFUSED/),
      detail: expect.stringMatching(/fetch failed/),
    });
  });

  it("aborts the probe when the deadline fires", async () => {
    let signal: AbortSignal | undefined;
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const service = await connectionRuntime((_model, _context, options) => {
      signal = options?.signal;
      probeStarted();
      return new Promise<ProbeReply>(() => {});
    });

    vi.useFakeTimers();
    try {
      const pending = service.testConnection("anthropic");
      // Candidate selection reads settings.json first; the deadline is armed
      // only once the probe is about to run.
      await started;
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        kind: "network",
        modelId: "claude-sonnet-4",
        message: "Timed out after 15 seconds",
        detail: "",
      });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
