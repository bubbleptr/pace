#!/usr/bin/env node
// The headless host: owns the Harness, its SQLite store, and the lock; every UI
// is a gateway client. Run on Node, not Bun (node:sqlite, pi-durable's engines).
//
//   node host/main.ts [--data-dir DIR] [--port 7420] [--cwd DIR]
//   node host/main.ts --faux "scripted answer" [--faux-tps 40]   # no real model, for tests
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type OpenHostOptions, openHost } from "./host.ts";
import { configureHarnessHttp, createHarnessSettings, defaultModel, modelSummaries } from "./pi-setup.ts";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    port: { type: "string", default: "7420" },
    cwd: { type: "string" },
    faux: { type: "string" },
    "faux-tps": { type: "string", default: "40" },
    "lock-stale-ms": { type: "string" },
  },
});

const cwd = resolve(values.cwd ?? process.cwd());
const dataDir = resolve(values["data-dir"] ?? join(getAgentDir(), "experimental", "durable-multiview", "default"));
const common = {
  dataDir,
  cwd,
  port: Number(values.port),
  ...(values["lock-stale-ms"] === undefined ? {} : { lockStaleMs: Number(values["lock-stale-ms"]) }),
};

function fauxOptions(answer: string): OpenHostOptions {
  const faux = fauxProvider({ tokensPerSecond: Number(values["faux-tps"]), tokenSize: { min: 1, max: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  // Every request gets the same answer, so a request rerun after a crash streams it again.
  faux.setResponses(Array.from({ length: 100 }, () => () => fauxAssistantMessage(answer)));
  const model = faux.getModel();
  const summary = { provider: model.provider, modelId: model.id, name: model.name, contextWindow: model.contextWindow };
  return { ...common, models, modelSummaries: () => [summary], initialModel: { provider: model.provider, modelId: model.id } };
}

async function piOptions(): Promise<OpenHostOptions> {
  const modelRuntime = await ModelRuntime.create();
  const settingsManager = SettingsManager.create(cwd);
  configureHarnessHttp(settingsManager);
  const initialModel = defaultModel(settingsManager, modelRuntime);
  return {
    ...common,
    models: modelRuntime,
    modelSummaries: () => modelSummaries(modelRuntime),
    settings: createHarnessSettings(settingsManager),
    ...(initialModel === undefined ? {} : { initialModel }),
  };
}

const options = values.faux === undefined ? await piOptions() : fauxOptions(values.faux);
const host = await openHost(options);
const model = options.initialModel === undefined ? null : `${options.initialModel.provider}/${options.initialModel.modelId}`;
console.log(JSON.stringify({ event: "ready", url: host.url, token: host.token, dataDir, model }));

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void host.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
