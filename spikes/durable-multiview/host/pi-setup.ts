// After createHarnessSettings / configureHarnessHttp / findInitialAgentModel in pi's
// packages/coding-agent/src/experimental/durable/harness-setup.ts (MIT, Earendil Works).
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef, HarnessSettings } from "@earendil-works/pi-durable";
import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelSummary } from "../protocol/view.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./http-dispatcher.ts";

export function configureHarnessHttp(settingsManager: SettingsManager): void {
  applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
  configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
}

/** Harness settings read at every use from pi's settings as loaded at startup. */
export function createHarnessSettings(settingsManager: SettingsManager): HarnessSettings {
  return {
    get stream() {
      const provider = settingsManager.getProviderRetrySettings();
      const idle = settingsManager.getHttpIdleTimeoutMs();
      return {
        timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
        maxRetryDelayMs: provider.maxRetryDelayMs,
        ...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
      };
    },
    get compaction() {
      return settingsManager.getCompactionSettings();
    },
    get retry() {
      return settingsManager.getRetrySettings();
    },
    get steeringMode() {
      return settingsManager.getSteeringMode();
    },
    get followUpMode() {
      return settingsManager.getFollowUpMode();
    },
  };
}

/**
 * pi's default model from settings.json when it is available. Simpler than pi's
 * findInitialModel, which is not exported: no scoped models, no provider fallback.
 */
export function defaultModel(
  settingsManager: SettingsManager,
  modelRuntime: ModelRuntime,
): (ModelRef & { readonly thinkingLevel?: ModelThinkingLevel }) | undefined {
  const provider = settingsManager.getDefaultProvider();
  const modelId = settingsManager.getDefaultModel();
  if (provider === undefined || modelId === undefined) return undefined;
  if (modelRuntime.getModel(provider, modelId) === undefined) return undefined;
  const thinkingLevel = settingsManager.getDefaultThinkingLevel();
  return { provider, modelId, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) };
}

export function modelSummaries(modelRuntime: ModelRuntime): ModelSummary[] {
  return modelRuntime.getAvailableSnapshot().map((model) => ({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
  }));
}
