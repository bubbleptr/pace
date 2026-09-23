// Model Catalog — the one owner of "which models are available" in the main
// backend process (ADR-0043). It holds the process's single Pace ModelRuntime,
// maps models through the shared core capability mapping, decides what a
// credential change refreshes, and fans refreshes out to live Sessions.

import {
  capabilityFromModel,
  compareModelCapabilities,
  defaultSelection,
  type ModelCatalogRefreshResult,
  type RuntimeModelControls,
} from "@pace/core";
import type { createPaceModelRuntime } from "./account-models";
import type { PreferredModel } from "./pi-settings";

type PaceModelRuntime = Awaited<ReturnType<typeof createPaceModelRuntime>>;

/** Minimal runtime surface so tests can substitute a stub. */
export type ModelCatalogRuntime = Pick<PaceModelRuntime, "getAvailableSnapshot" | "refresh">;

export type ModelCatalog = {
  /** Cache-first: reads the runtime snapshot, never the network. */
  list(): Promise<RuntimeModelControls>;
  refresh(input: { allowNetwork: boolean; force?: boolean }): Promise<ModelCatalogRefreshResult>;
  /** The one refresh policy for every credential write (ADR-0043 §2). */
  onCredentialChanged(): Promise<void>;
  subscribe(listener: () => void): () => void;
};

export type ModelCatalogOptions = {
  /** Called at most once, lazily; the result is shared with provider auth. */
  runtime: () => Promise<ModelCatalogRuntime>;
  /** Satisfied by PiRuntimeDriver. */
  liveSessions?: { refreshModelCatalog?(): Promise<void> };
  readPreferredModel: () => Promise<PreferredModel>;
  /** Providers whose account model list a credential change refetches. */
  providers: readonly string[];
  fanOutTimeoutMs?: number;
  refreshOnStart?: boolean;
  log?: (message: string, error?: unknown) => void;
};

const defaultFanOutTimeoutMs = 5_000;

function isOffline() {
  // ModelRuntime treats any set PI_OFFLINE as network-disabled, but an
  // explicit allowNetwork: true would still fetch.
  return process.env.PI_OFFLINE !== undefined;
}

export function createModelCatalog(options: ModelCatalogOptions): ModelCatalog {
  const log = options.log ?? ((message, error) => console.error(message, error));
  const fanOutTimeoutMs = options.fanOutTimeoutMs ?? defaultFanOutTimeoutMs;
  const listeners = new Set<() => void>();
  let runtimePromise: Promise<ModelCatalogRuntime> | undefined;
  const getRuntime = () => (runtimePromise ??= options.runtime());

  const notify = () => {
    for (const listener of listeners) listener();
  };

  async function refreshLiveSessions() {
    if (!options.liveSessions?.refreshModelCatalog) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // One unresponsive session process must not hold the caller. Healthy
      // roots still finish; this only stops waiting.
      await Promise.race([
        options.liveSessions.refreshModelCatalog(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Live session model catalog refresh timed out."));
          }, fanOutTimeoutMs);
        }),
      ]);
    } catch (error) {
      // The catalog itself is already refreshed; a live session that cannot
      // re-read it must not fail the request, and is not a provider error.
      log("Pace could not refresh live session model catalogs.", error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function refreshAccountModels() {
    try {
      const runtime = await getRuntime();
      // A new account or key has no cached model list yet; fetch it before
      // the caller re-reads the catalog so an unusable model never flashes in.
      // Offline still re-reads auth.json and the cached lists.
      const result = await runtime.refresh({
        allowNetwork: !isOffline(),
        providers: options.providers,
      });
      for (const [providerId, error] of result.errors) {
        log(`Pace could not refresh the ${providerId} account model list.`, error);
      }
    } catch (error) {
      // The Pi catalog stays usable; the next refresh tries again.
      log("Pace could not refresh account model lists.", error);
    }
    await refreshLiveSessions();
    notify();
  }

  if (options.refreshOnStart) {
    // Background: startup must not wait on chatgpt.com. Freshness is cached,
    // so frequent restarts do not refetch.
    void refreshAccountModels();
  }

  return {
    async list() {
      const runtime = await getRuntime();
      const models = runtime
        .getAvailableSnapshot()
        .map((model) => capabilityFromModel(model))
        .sort(compareModelCapabilities);

      return {
        models,
        selected: defaultSelection(models, await options.readPreferredModel()),
      };
    },

    async refresh(input) {
      // Offline skipped the network, so live sessions already have this catalog.
      if (!input.allowNetwork || isOffline()) {
        return { offline: true };
      }

      const runtime = await getRuntime();
      const result = await runtime.refresh({ allowNetwork: true, force: input.force === true });
      const errors: Record<string, string> = {};
      for (const [providerId, error] of result.errors) {
        errors[providerId] = error instanceof Error ? error.message : String(error);
      }

      await refreshLiveSessions();
      notify();
      return { refreshedAt: new Date().toISOString(), errors };
    },

    onCredentialChanged: refreshAccountModels,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
