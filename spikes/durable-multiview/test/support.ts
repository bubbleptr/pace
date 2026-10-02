import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach } from "vitest";
import { createDemo, type Demo } from "../host/demo/index.ts";
import { oncallScript } from "../host/demo/faux-script.ts";
import { openHost, type OpenedHost } from "../host/host.ts";
import { connectRemoteDurable, type RemoteDurable } from "../protocol/remote-durable.ts";
import type { DurableViewSource } from "../protocol/view.ts";

/** Cleanups registered during a test, run in reverse after it. */
export function useCleanups(): (cleanup: () => Promise<void> | void) => void {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  return (cleanup) => void cleanups.push(cleanup);
}

/** An in-process host on a temporary store whose faux model gives `answers` in order. */
export async function startFauxHost(
  defer: (cleanup: () => Promise<void> | void) => void,
  {
    answers = [LONG_ANSWER],
    tokensPerSecond = 200,
    dataDir,
    port = 0,
  }: {
    answers?: string[];
    tokensPerSecond?: number;
    /** Reopen an earlier host's store. */
    dataDir?: string;
    /** Fixed, so clients reconnect to a restarted host. */
    port?: number;
  } = {},
): Promise<OpenedHost> {
  const dir = dataDir === undefined ? await tempDir() : { path: dataDir, remove: () => {} };
  defer(dir.remove);
  const faux = fauxProvider({ tokensPerSecond, tokenSize: { min: 1, max: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(answers.map((answer) => fauxAssistantMessage(answer)));
  const model = faux.getModel();
  const host = await openHost({
    dataDir: dir.path,
    cwd: dir.path,
    models,
    modelSummaries: () => [{ provider: model.provider, modelId: model.id, name: model.name, contextWindow: model.contextWindow }],
    initialModel: { provider: model.provider, modelId: model.id },
    port,
  });
  defer(() => host.close());
  return host;
}

/** An in-process host with the on-call demo installed, driven by the scripted faux model. */
export async function startDemoHost(
  defer: (cleanup: () => Promise<void> | void) => void,
  {
    dataDir,
    port = 0,
    stepMs = 150,
    investigationModule,
  }: { dataDir?: string; port?: number; stepMs?: number; investigationModule?: string } = {},
): Promise<{ host: OpenedHost; demo: Demo }> {
  const dir = dataDir === undefined ? await tempDir() : { path: dataDir, remove: () => {} };
  defer(dir.remove);
  const faux = fauxProvider({ tokensPerSecond: 400, tokenSize: { min: 2, max: 4 } });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 200 }, () => oncallScript()));
  const model = faux.getModel();
  const demo = await createDemo({ paceMs: 10, stepMs, ...(investigationModule === undefined ? {} : { investigationModule }) });
  const host = await openHost({
    dataDir: dir.path,
    cwd: dir.path,
    models,
    modelSummaries: () => [{ provider: model.provider, modelId: model.id, name: model.name, contextWindow: model.contextWindow }],
    initialModel: { provider: model.provider, modelId: model.id },
    port,
    ...demo.hostOptions,
    settings: demo.settings(),
  });
  defer(() => host.close());
  return { host, demo };
}

export async function connectTo(
  defer: (cleanup: () => Promise<void> | void) => void,
  host: OpenedHost,
  token = host.token,
  clientName?: string,
): Promise<RemoteDurable> {
  const client = await connectRemoteDurable({
    url: host.url,
    token,
    reconnectDelayMs: { min: 100, max: 500 },
    ...(clientName === undefined ? {} : { clientName }),
  });
  defer(() => client.close());
  return client;
}

export async function tempDir(): Promise<{ path: string; remove(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "durable-multiview-"));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}

/** Resolve once `predicate` holds for the source's view, checked on every update. */
export function waitForView(
  source: DurableViewSource,
  predicate: (view: ReturnType<DurableViewSource["current"]>) => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      if (!predicate(source.current())) return false;
      clearTimeout(timer);
      unsubscribe();
      resolve();
      return true;
    };
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`view condition not met within ${timeoutMs} ms`));
    }, timeoutMs);
    const unsubscribe = source.subscribe(() => void check());
    check();
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** A reply long enough at the faux provider's pace to leave a window mid-stream. */
export const LONG_ANSWER = Array.from({ length: 40 }, (_, i) => `step-${i}`).join(" ");
