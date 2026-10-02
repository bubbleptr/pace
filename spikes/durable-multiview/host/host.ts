import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  type HarnessSettings,
  type ModelRef,
  type Registry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import lockfile from "proper-lockfile";
import type { ModelSummary } from "../protocol/view.ts";
import { startGateway } from "./gateway.ts";

const context = BACKGROUND_CONTEXT;

export interface OpenHostOptions {
  /** Holds `session.sqlite`, the token, and the lock; one host process at a time. */
  readonly dataDir: string;
  readonly cwd: string;
  readonly models: Models;
  readonly modelSummaries: () => readonly ModelSummary[];
  readonly registry?: Registry;
  readonly settings?: HarnessSettings;
  /** Applied only when the root conversation is created. */
  readonly initialModel?: ModelRef & { readonly thinkingLevel?: ModelThinkingLevel };
  /** 0 picks a free port. A fixed port lets clients reconnect to a restarted host. */
  readonly port: number;
  /** How long a lock left by a killed host blocks the next one. proper-lockfile's minimum is 2000. */
  readonly lockStaleMs?: number;
}

export interface OpenedHost {
  readonly url: string;
  readonly token: string;
  readonly harness: Harness;
  close(): Promise<void>;
}

/** Persisted so a restarted host accepts the clients that were connected before it died. */
async function hostToken(dataDir: string): Promise<string> {
  const path = join(dataDir, "token");
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    const token = randomBytes(24).toString("base64url");
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    return token;
  }
}

export async function openHost(options: OpenHostOptions): Promise<OpenedHost> {
  await mkdir(options.dataDir, { recursive: true });
  // Durable has no cross-process lock of its own; a second opener would corrupt the store.
  const stale = Math.max(2000, options.lockStaleMs ?? 10_000);
  const release = await lockfile
    .lock(options.dataDir, {
      realpath: false,
      stale,
      retries: { retries: Math.ceil(stale / 1000) + 2, minTimeout: 1000, maxTimeout: 1000 },
    })
    .catch((error: unknown) => {
      throw new Error(`Session is already open in another process: ${options.dataDir}`, { cause: error });
    });

  let harness: Harness | undefined;
  try {
    const token = await hostToken(options.dataDir);
    const reports: unknown[] = [];
    let report = (error: unknown): void => void reports.push(error);
    harness = await Harness.open(
      await openNodeSqliteStorage(join(options.dataDir, "session.sqlite")),
      {
        models: options.models,
        registry: options.registry ?? createRegistry(),
        ...(options.settings === undefined ? {} : { settings: options.settings }),
        onReport: (error) => report(error),
      },
      context,
    );
    const { initialModel } = options;
    await harness.root(context, {
      agent: {
        cwd: options.cwd,
        ...(initialModel === undefined ? {} : { model: { provider: initialModel.provider, modelId: initialModel.modelId } }),
        ...(initialModel?.thinkingLevel === undefined ? {} : { thinkingLevel: initialModel.thinkingLevel }),
      },
    });
    const gateway = await startGateway({
      harness,
      models: options.models,
      modelSummaries: options.modelSummaries,
      session: { id: basename(options.dataDir), directory: options.dataDir, cwd: options.cwd },
      token,
      port: options.port,
    });
    report = (error) => gateway.broadcast("warning", error instanceof Error ? error.message : String(error));
    for (const error of reports.splice(0)) report(error);
    // Recovered work from an interrupted turn continues now.
    harness.resume();

    const opened = harness;
    let closing: Promise<void> | undefined;
    return {
      url: gateway.url,
      token,
      harness,
      close() {
        closing ??= (async () => {
          try {
            await gateway.close();
            // Close writes no outcome: a running turn resumes at the next open.
            await opened.close(context);
          } finally {
            await release();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    await harness?.close(context).catch(() => {});
    await release().catch(() => {});
    throw error;
  }
}
