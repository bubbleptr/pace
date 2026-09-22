// Per-account model availability on top of Pi's catalog (model-availability S4).
//
// Pi's catalog (bundled JSON + pi.dev overlay) only ever adds models, so a
// model a plan retires or a key cannot reach stays listed until the SDK ships
// a new build. Providers do list what an account may use; we cache that list
// per account and intersect it with the catalog inside the runtime, so
// Settings, the composer and live sessions all read the same filtered list.
// Each channel (Pi provider) is filtered on its own; channels are never
// intersected with each other.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";

type PaceModelRuntime = Awaited<ReturnType<typeof ModelRuntime.create>>;
type Provider = NonNullable<ReturnType<PaceModelRuntime["getProvider"]>>;
type CatalogModel = ReturnType<Provider["getModels"]>[number];
type RefreshContext = Parameters<NonNullable<Provider["refreshModels"]>>[0];

// Same cadence as Pi's pi.dev overlay; force bypasses it.
const accountModelsFreshMs = 4 * 60 * 60 * 1000;

type AccountModel = {
  id: string;
  name?: string;
  contextWindow?: number;
};

type AccountModelsEntry = {
  /** Account identity the list belongs to; never a secret. */
  accountId: string;
  checkedAt: number;
  models: AccountModel[];
};

type AccountModelsCache = Record<string, AccountModelsEntry>;

type FetchInput = {
  credential: NonNullable<RefreshContext["credential"]>;
  catalog: readonly CatalogModel[];
  fetch: typeof fetch;
  signal: AbortSignal;
};

type AccountModelSource = {
  providerId: string;
  /** Stable, non-secret id of the stored credential's account; undefined skips filtering. */
  identity(stored: unknown): string | undefined;
  list(input: FetchInput): Promise<AccountModel[]>;
  /**
   * Show listed models Pi's catalog lacks. Only for curated lists: raw API
   * lists include embeddings, audio and snapshots that are not chat models.
   */
  includeUnknown: boolean;
};

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function oauthAccountId(stored: unknown) {
  return field(stored, "type") === "oauth" ? nonEmptyString(field(stored, "accountId")) : undefined;
}

function apiKeyIdentity(stored: unknown) {
  if (field(stored, "type") !== "api_key") return undefined;
  const key = nonEmptyString(field(stored, "key"));
  // Hash the stored form so the cache follows key changes without holding the key.
  return key ? `key:${createHash("sha256").update(key).digest("hex").slice(0, 16)}` : undefined;
}

async function getJson(input: FetchInput, url: string, headers: Record<string, string>) {
  const response = await input.fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`Model list request failed (HTTP ${response.status}).`);
  }
  return (await response.json()) as unknown;
}

function catalogBaseUrl(catalog: readonly CatalogModel[], fallback: string) {
  // Follow a models.json baseUrl override so proxies list their own models.
  return (catalog[0]?.baseUrl ?? fallback).replace(/\/+$/u, "");
}

function listedIds(body: unknown): AccountModel[] {
  const data = field(body, "data");
  return Array.isArray(data)
    ? data.flatMap((entry) => {
        const id = nonEmptyString(field(entry, "id"));
        return id ? [{ id }] : [];
      })
    : [];
}

// The endpoint answers an empty list below some client version, so pin a
// recent Codex CLI release and bump it with Pace releases.
const codexClientVersion = "0.155.0";

const sources: readonly AccountModelSource[] = [
  {
    providerId: "openai-codex",
    identity: oauthAccountId,
    includeUnknown: true,
    async list(input) {
      const access = nonEmptyString(field(input.credential, "access"));
      const accountId = oauthAccountId(input.credential);
      if (!access || !accountId) throw new Error("ChatGPT credential is missing its account.");
      const body = await getJson(
        input,
        `https://chatgpt.com/backend-api/codex/models?client_version=${codexClientVersion}`,
        { authorization: `Bearer ${access}`, "chatgpt-account-id": accountId },
      );
      const models = field(body, "models");
      return Array.isArray(models)
        ? models.flatMap((entry) => {
            const id = nonEmptyString(field(entry, "slug"));
            if (!id || field(entry, "visibility") === "hide") return [];
            const contextWindow = field(entry, "context_window");
            return [{
              id,
              name: nonEmptyString(field(entry, "display_name")),
              contextWindow: typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : undefined,
            }];
          })
        : [];
    },
  },
  {
    providerId: "openai",
    identity: apiKeyIdentity,
    includeUnknown: false,
    async list(input) {
      const key = nonEmptyString(field(input.credential, "key"));
      if (!key) throw new Error("OpenAI API key is missing.");
      const baseUrl = catalogBaseUrl(input.catalog, "https://api.openai.com/v1");
      return listedIds(await getJson(input, `${baseUrl}/models`, { authorization: `Bearer ${key}` }));
    },
  },
  {
    providerId: "anthropic",
    identity: apiKeyIdentity,
    includeUnknown: false,
    async list(input) {
      const key = nonEmptyString(field(input.credential, "key"));
      if (!key) throw new Error("Anthropic API key is missing.");
      const baseUrl = catalogBaseUrl(input.catalog, "https://api.anthropic.com");
      // 1000 is the page maximum and far above the model count, so one page is the list.
      return listedIds(await getJson(input, `${baseUrl}/v1/models?limit=1000`, {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      }));
    },
  },
];

/** Providers whose model list Pace narrows to what the signed-in account can use. */
export const accountModelProviderIds: readonly string[] = sources.map((source) => source.providerId);

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

async function cachedAccountModels(cachePath: string, providerId: string, accountId: string | undefined) {
  if (!accountId) return undefined;
  const entry = (await readCache(cachePath))[providerId];
  if (entry?.accountId !== accountId || !Array.isArray(entry.models)) return undefined;
  // A list with no readable model (e.g. an older cache shape) would hide
  // everything; treat it as absent and let the next refresh rewrite it.
  const models = entry.models.filter((model) => typeof nonEmptyString(field(model, "id")) === "string");
  return models.length > 0 ? { ...entry, models } : undefined;
}

function projectAccountModels(
  catalog: readonly CatalogModel[],
  account: readonly AccountModel[],
  includeUnknown: boolean,
) {
  const template = catalog[0];
  const projected: CatalogModel[] = [];
  for (const entry of account) {
    const known = catalog.find((model) => model.id === entry.id);
    if (known) {
      projected.push(known);
    } else if (includeUnknown && template) {
      // New to the account but not yet in Pi's catalog: borrow transport
      // fields from a sibling so it streams, and take what the account says.
      projected.push({
        ...template,
        id: entry.id,
        name: entry.name?.trim() || entry.id,
        contextWindow: entry.contextWindow ?? template.contextWindow,
      });
    }
  }
  return projected;
}

function withAccountModels(
  base: Provider,
  options: {
    source: AccountModelSource;
    authPath: string;
    cachePath: string;
    fetch: typeof fetch;
    initial: AccountModel[] | undefined;
  },
) {
  const { source } = options;
  let account = options.initial;
  let settleFirstRefresh!: () => void;
  const firstRefresh = new Promise<void>((resolve) => {
    settleFirstRefresh = resolve;
  });

  const refreshAccount = async (context: RefreshContext) => {
    // Identity comes from the stored credential in both phases: the network
    // phase sees a resolved key, which would not match what offline reads see.
    const accountId = source.identity(readStoredCredential(base.id, options.authPath));
    const entry = await cachedAccountModels(options.cachePath, base.id, accountId);
    if (!(await context.publish({ update: () => { account = entry?.models; } }))) return;

    if (!context.allowNetwork || context.signal.aborted || !accountId || !context.credential) return;
    if (!context.force && entry && Date.now() - entry.checkedAt < accountModelsFreshMs) return;

    const models = await source.list({
      credential: context.credential,
      catalog: base.getModels(),
      fetch: options.fetch,
      signal: context.signal,
    });
    // An empty answer is indistinguishable from a broken endpoint; hiding
    // every model would be worse than showing a stale catalog.
    if (models.length === 0) throw new Error(`${base.id} returned no models for this account.`);
    if (context.signal.aborted) return;
    await writeCacheEntry(options.cachePath, base.id, { accountId, checkedAt: Date.now(), models });
    await context.publish({ update: () => { account = models; } });
  };

  const provider: Provider = {
    ...base,
    getModels: () => {
      const catalog = base.getModels();
      return account ? projectAccountModels(catalog, account, source.includeUnknown) : catalog;
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
  const authPath = join(input.agentDir, "auth.json");
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: join(input.agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const cachePath = accountModelsCachePath(input.dataDir);
  const firstRefreshes: Promise<void>[] = [];

  for (const source of sources) {
    const base = runtime.getProvider(source.providerId);
    if (!base) continue;
    // Seed from the cache so the very first snapshot is already filtered.
    const accountId = source.identity(readStoredCredential(source.providerId, authPath));
    const initial = await cachedAccountModels(cachePath, source.providerId, accountId);
    const wrapped = withAccountModels(base, {
      source,
      authPath,
      cachePath,
      fetch: input.fetch ?? ((...args) => globalThis.fetch(...args)),
      initial: initial?.models,
    });
    runtime.registerNativeProvider(wrapped.provider);
    firstRefreshes.push(wrapped.firstRefresh);
  }

  if (firstRefreshes.length > 0) {
    // registerNativeProvider fires an unawaited refresh. Pi supersedes an
    // older refresh of the same provider, so a caller's network refresh
    // started now could be cancelled by it; let its provider phase finish.
    // The timeout only guards against a refresh that never reaches providers.
    await Promise.race([firstRefreshTimeout(), Promise.all(firstRefreshes)]);
  }
  return runtime;
}
