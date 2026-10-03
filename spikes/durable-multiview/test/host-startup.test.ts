import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { connectRemoteDurable } from "../protocol/remote-durable.ts";
import { tempDir, useCleanups } from "./support.ts";

const defer = useCleanups();

it("keeps the host credential out of startup logs while local clients can connect", async () => {
  const data = await tempDir();
  defer(data.remove);
  const child = spawn(process.execPath, ["host/main.ts", "--faux", "ready", "--data-dir", data.path, "--port", "0"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  let ready: { url: string; tokenFile: string; web: string } | undefined;
  for await (const line of createInterface({ input: child.stdout })) {
    const event = JSON.parse(line);
    if (event.event === "ready") { ready = event; break; }
  }
  if (ready === undefined) throw new Error("host exited before ready");
  const token = (await readFile(join(data.path, "token"), "utf8")).trim();
  // A boolean assertion keeps the credential out of failed-test diagnostics too.
  expect(output.includes(token), "startup logs contain the host credential").toBe(false);
  expect(ready.tokenFile).toBe(join(data.path, "token"));
  expect(new URL(ready.web).hash).toBe("");
  const client = await connectRemoteDurable({ url: ready.url, token });
  defer(() => client.close());
  expect(client.view.current().connection).toBe("connected");
});
