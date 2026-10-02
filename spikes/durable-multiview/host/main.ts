#!/usr/bin/env node
// The headless host: owns the Harness, its SQLite store, and the lock; every UI
// is a gateway client. Run on Node, not Bun (node:sqlite, pi-durable's engines).
//
//   node host/main.ts [--data-dir DIR] [--port 7420] [--cwd DIR]
//   node host/main.ts --demo                  # the on-call demo on the real model; edits to host/demo/investigation.ts reload live
//   node host/main.ts --faux-demo             # the same demo driven by a scripted model, for tests and rehearsals
//   node host/main.ts --faux "scripted answer" [--faux-tps 40]   # no real model, for tests
import { watch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { oncallScript } from "./demo/faux-script.ts";
import { createDemo, type Demo } from "./demo/index.ts";
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
    demo: { type: "boolean", default: false },
    "faux-demo": { type: "boolean", default: false },
    "pace-ms": { type: "string" },
    "step-ms": { type: "string" },
    "reminder-seconds": { type: "string" },
    "investigation-module": { type: "string" },
  },
});

const number = (value: string | undefined): number | undefined => (value === undefined ? undefined : Number(value));
const cwd = resolve(values.cwd ?? process.cwd());
const dataDir = resolve(values["data-dir"] ?? join(getAgentDir(), "experimental", "durable-multiview", "default"));
const demo: Demo | undefined =
  values.demo || values["faux-demo"]
    ? await createDemo({
        ...(values["pace-ms"] === undefined ? {} : { paceMs: Number(values["pace-ms"]) }),
        ...(values["step-ms"] === undefined ? {} : { stepMs: Number(values["step-ms"]) }),
        ...(values["investigation-module"] === undefined ? {} : { investigationModule: resolve(values["investigation-module"]) }),
      })
    : undefined;
const common = {
  dataDir,
  cwd,
  port: Number(values.port),
  ...(values["lock-stale-ms"] === undefined ? {} : { lockStaleMs: Number(values["lock-stale-ms"]) }),
  ...demo?.hostOptions,
};

function fauxOptions(responses: () => FauxResponseStep): OpenHostOptions {
  const faux = fauxProvider({ tokensPerSecond: Number(values["faux-tps"]), tokenSize: { min: 1, max: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  // Every request gets a fresh step, so a request rerun after a crash streams it again.
  faux.setResponses(Array.from({ length: 1000 }, responses));
  const model = faux.getModel();
  const summary = { provider: model.provider, modelId: model.id, name: model.name, contextWindow: model.contextWindow };
  return {
    ...common,
    models,
    modelSummaries: () => [summary],
    initialModel: { provider: model.provider, modelId: model.id },
    ...(demo === undefined ? {} : { settings: demo.settings() }),
  };
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
    settings: demo === undefined ? createHarnessSettings(settingsManager) : demo.settings(createHarnessSettings(settingsManager)),
    ...(initialModel === undefined ? {} : { initialModel }),
  };
}

const reminderSeconds = number(values["reminder-seconds"]);
const options =
  values["faux-demo"]
    ? fauxOptions(() => oncallScript(reminderSeconds === undefined ? {} : { reminderSeconds }))
    : values.faux !== undefined
      ? fauxOptions(() => () => fauxAssistantMessage(values.faux!))
      : await piOptions();
const host = await openHost(options);
const model = options.initialModel === undefined ? null : `${options.initialModel.provider}/${options.initialModel.modelId}`;
// The web client (`bun run web`) reads the host from the fragment, which never leaves the browser.
const web = `http://127.0.0.1:5199/#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`;
console.log(JSON.stringify({ event: "ready", url: host.url, token: host.token, dataDir, model, web, demo: demo !== undefined }));

if (demo !== undefined) {
  // Editors save in bursts; reload once the burst settles.
  let timer: NodeJS.Timeout | undefined;
  // Watch the directory because an editor's atomic save replaces the file's inode.
  const watcher = watch(dirname(demo.investigationModule), (_event, filename) => {
    if (filename !== null && filename !== basename(demo.investigationModule)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      demo.reload().then(
        (loads) => host.notify("info", `Reloaded the investigation tools (load ${loads}).`),
        (error: unknown) => host.notify("error", `Reload failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }, 200);
  });
  process.once("exit", () => watcher.close());
}

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void host.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
