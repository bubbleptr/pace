// Per-account model availability on top of Pi's catalog (model-availability S4).
//
// Pi's catalog (bundled JSON + pi.dev overlay) only ever adds models, so a
// model a ChatGPT plan retires stays listed until the SDK ships a new build.
// The subscription backend does list what an account may use; we cache that
// list per account and intersect it with the catalog inside the runtime, so
// Settings, the composer and live sessions all read the same filtered list.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";

type PaceModelRuntime = Awaited<ReturnType<typeof ModelRuntime.create>>;
type Provider = NonNullable<ReturnType<PaceModelRuntime["getProvider"]>>;
type CatalogModel = ReturnType<Provider["getModels"]>[number];
type RefreshContext = Parameters<NonNullable<Provider["refreshModels"]>>[0];

const codexProviderId = "openai-codex";
/** Providers whose model list Pace narrows to what the signed-in account can use. */
export const accountModelProviderIds: readonly string[] = [codexProviderId];
// The endpoint answers an empty list below some client version, so pin a
// recent Codex CLI release and bump it with Pace releases.
const codexClientVersion = "0.155.0";
const codexModelsUrl = `https://chatgpt.com/backend-api/codex/models?client_version=${codexClientVersion}`;
// Same cadence as Pi's pi.dev overlay; force bypasses it.
const accountModelsFreshMs = 4 * 60 * 60 * 1000;

type AccountModel = {
  slug: string;
  display_name?: string;
  context_window?: number;
  visibility?: string;
};

type AccountModelsEntry = {
  accountId: string;
  checkedAt: number;
  models: AccountModel[];
};

type AccountModelsCache = Record<string, AccountModelsEntry>;

export function accountModelsCachePath(dataDir: string) {
  return join(dataDir, "account-models.json");
}

async function readCache(cachePath: string): Promise<AccountModelsCache> {
  try {
    const raw = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as AccountModelsCache)
      : {};
  } catch {
    return {};
  }
}

async function writeCacheEntry(cachePath: string, providerId: string, entry: AccountModelsEntry) {
  const cache = await readCache(cachePath);
  cache[providerId] = entry;
  await mkdir(dirname(cachePath), { recursive: true });
  // Session processes read this file concurrently; never expose a partial write.
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(cache, null, 2), "utf8");
  await rename(tempPath, cachePath);
}

function accountIdOf(credential: unknown): string | undefined {
  if ((credential as { type?: unknown } | undefined)?.type !== "oauth") return undefined;
  const accountId = (credential as { accountId?: unknown }).accountId;
  return typeof accountId === "string" && accountId ? accountId : undefined;
}

function isAccountModel(value: unknown): value is AccountModel {
  return typeof value === "object" && value !== null && typeof (value as AccountModel).slug === "string";
}

async function fetchCodexAccountModels(input: {
  access: string;
  accountId: string;
  fetch: typeof fetch;
  signal: AbortSignal;
}): Promise<AccountModel[]> {
  const response = await input.fetch(codexModelsUrl, {
    headers: {
      authorization: `Bearer ${input.access}`,
      "chatgpt-account-id": input.accountId,
      accept: "application/json",
    },
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`ChatGPT model list request failed (HTTP ${response.status}).`);
  }
  const body = (await response.json()) as { models?: unknown };
  const models = Array.isArray(body.models) ? body.models.filter(isAccountModel) : [];
  // An empty answer is indistinguishable from a broken endpoint; hiding every
  // model would be worse than showing a stale catalog.
  if (!models.some((model) => model.visibility !== "hide")) {
    throw new Error("ChatGPT returned no models for this account.");
  }
  return models;
}

function projectAccountModels(catalog: readonly CatalogModel[], account: readonly AccountModel[]) {
  const template = catalog[0];
  const projected: CatalogModel[] = [];
  for (const entry of account) {
    if (entry.visibility === "hide") continue;
    const known = catalog.find((model) => model.id === entry.slug);
    if (known) {
      projected.push(known);
    } else if (template) {
      // New to the account but not yet in Pi's catalog: borrow transport
      // fields from a sibling so it streams, and take what the account says.
      projected.push({
        ...template,
        id: entry.slug,
        name: entry.display_name?.trim() || entry.slug,
        contextWindow:
          typeof entry.context_window === "number" && entry.context_window > 0
            ? entry.context_window
            : template.contextWindow,
      });
    }
  }
  return projected;
}

async function cachedAccountModels(cachePath: string, providerId: string, accountId: string | undefined) {
  if (!accountId) return undefined;
  const entry = (await readCache(cachePath))[providerId];
  return entry?.accountId === accountId ? entry : undefined;
}

function withAccountModels(
  base: Provider,
  options: { cachePath: string; fetch: typeof fetch; initial: AccountModel[] | undefined },
) {
  let account = options.initial;
  let settleFirstRefresh!: () => void;
  const firstRefresh = new Promise<void>((resolve) => {
    settleFirstRefresh = resolve;
  });

  const refreshAccount = async (context: RefreshContext) => {
    const accountId = accountIdOf(context.credential);
    const entry = await cachedAccountModels(options.cachePath, base.id, accountId);
    if (!(await context.publish({ update: () => { account = entry?.models; } }))) return;

    if (!context.allowNetwork || context.signal.aborted || !accountId) return;
    if (!context.force && entry && Date.now() - entry.checkedAt < accountModelsFreshMs) return;

    const access = (context.credential as { access?: unknown }).access;
    if (typeof access !== "string" || !access) return;
    const models = await fetchCodexAccountModels({
      access,
      accountId,
      fetch: options.fetch,
      signal: context.signal,
    });
    if (context.signal.aborted) return;
    await writeCacheEntry(options.cachePath, base.id, { accountId, checkedAt: Date.now(), models });
    await context.publish({ update: () => { account = models; } });
  };

  const provider: Provider = {
    ...base,
    getModels: () => {
      const catalog = base.getModels();
      return account ? projectAccountModels(catalog, account) : catalog;
    },
    refreshModels: async (context) => {
      // A pi.dev outage must not block the account list, and vice versa.
      let catalogError: unknown;
      try {
        await base.refreshModels?.(context);
      } catch (error) {
        catalogError = error;
      }
      try {
        await refreshAccount(context);
      } finally {
        settleFirstRefresh();
      }
      if (catalogError !== undefined) throw catalogError;
    },
  };
  return { provider, firstRefresh };
}

function firstRefreshTimeout() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 2_000).unref?.();
  });
}

/**
 * Every Pace-owned ModelRuntime goes through here so Settings, the composer
 * and session processes agree on which models an account can use. Creation
 * stays offline; network access is an explicit refresh({ allowNetwork }).
 */
export async function createPaceModelRuntime(input: {
  agentDir: string;
  dataDir: string;
  fetch?: typeof fetch;
}): Promise<PaceModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: join(input.agentDir, "auth.json"),
    modelsPath: join(input.agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const base = runtime.getProvider(codexProviderId);
  if (base) {
    const cachePath = accountModelsCachePath(input.dataDir);
    // Seed from the cache so the very first snapshot is already filtered.
    const credential = readStoredCredential(codexProviderId, join(input.agentDir, "auth.json"));
    const initial = await cachedAccountModels(cachePath, codexProviderId, accountIdOf(credential));
    const wrapped = withAccountModels(base, {
      cachePath,
      fetch: input.fetch ?? ((...args) => globalThis.fetch(...args)),
      initial: initial?.models,
    });
    runtime.registerNativeProvider(wrapped.provider);
    // registerNativeProvider fires an unawaited refresh. Pi supersedes an
    // older refresh of the same provider, so a caller's network refresh
    // started now could be cancelled by it; let its provider phase finish.
    // The timeout only guards against a refresh that never reaches providers.
    await Promise.race([firstRefreshTimeout(), wrapped.firstRefresh]);
  }
  return runtime;
}
