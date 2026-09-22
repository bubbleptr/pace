import type { ChildProcess } from "node:child_process";

export async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`);
}

export function waitForSpikeReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error("Timed out waiting for chord fixture ready"));
    }, 8_000);
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      if ((message as { type?: unknown }).type !== "spike_ready") return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve();
    };
    child.on("message", onMessage);
  });
}

export function waitForDriverResult(child: ChildProcess, id: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error(`Timed out waiting for driver reply id=${id}`));
    }, 8_000);
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const record = message as { id?: unknown; kind?: unknown; result?: unknown; error?: unknown };
      // Driver replies have an id and no chord `kind`. Ignore the error
      // frames serveSessionProcess currently emits for chord_call traffic.
      if (record.id !== id || typeof record.kind === "string") return;
      if ("error" in record && record.error !== undefined) return;
      if (!("result" in record)) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve(record.result);
    };
    child.on("message", onMessage);
  });
}

export async function disposeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => {
    child.once("exit", () => resolve());
  });
  const killTimer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, 5_000);
  try {
    if (child.connected) child.send({ id: 99, method: "dispose", args: [] });
    else child.kill("SIGKILL");
    await exited;
  } finally {
    clearTimeout(killTimer);
  }
}
