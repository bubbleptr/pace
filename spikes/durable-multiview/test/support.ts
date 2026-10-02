import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableViewSource } from "../protocol/view.ts";

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
