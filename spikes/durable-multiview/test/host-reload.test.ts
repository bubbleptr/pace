import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { connectRemoteDurable } from "../protocol/remote-durable.ts";
import { isBusy } from "../protocol/transcript.ts";
import { tempDir, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const spikeDir = fileURLToPath(new URL("..", import.meta.url));

it("reloads the investigation tools after consecutive atomic editor saves", async () => {
  const data = await tempDir();
  defer(data.remove);
  await mkdir(join(spikeDir, ".tmp"), { recursive: true });
  const modules = await mkdtemp(join(spikeDir, ".tmp", "host-reload-"));
  defer(() => rm(modules, { recursive: true, force: true }));
  const module = join(modules, "investigation.ts");
  const original = await readFile(join(spikeDir, "host", "demo", "investigation.ts"), "utf8");
  await writeFile(module, original);
  const child = spawn(
    process.execPath,
    [
      "host/main.ts", "--faux-demo", "--data-dir", data.path, "--cwd", data.path,
      "--port", "0", "--faux-tps", "1000", "--pace-ms", "0", "--investigation-module", module,
    ],
    { cwd: spikeDir, stdio: ["ignore", "pipe", "inherit"] },
  );
  defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  });
  let address: { url: string; token: string } | undefined;
  for await (const line of createInterface({ input: child.stdout! })) {
    const event = JSON.parse(line) as { event: string; url: string; tokenFile: string };
    if (event.event !== "ready") continue;
    address = { url: event.url, token: (await readFile(event.tokenFile, "utf8")).trim() };
    break;
  }
  if (address === undefined) throw new Error("host exited before it was ready");
  const client = await connectRemoteDurable(address);
  defer(() => client.close());
  const root = client.view.current().conversation.conversation.id;

  for (const format of ["table", "plain"]) {
    const notices = client.view.current().notices.length;
    await writeFile(`${module}.tmp`, original.replace(`const FORMAT = "plain"`, `const FORMAT = "${format}"`));
    await rename(`${module}.tmp`, module);
    await waitForView(
      client.view,
      (view) => view.notices.slice(notices).some((notice) => /Reloaded the investigation tools/.test(notice.message)),
      5000,
    );
    await client.controller.switchConversation(root);
    const count = client.view.current().conversations.filter((summary) => summary.label.startsWith("subagent")).length;
    await client.controller.submit("check the metrics again", "followUp");
    await waitForView(
      client.view,
      (view) => !isBusy(view.conversation) && view.conversations.filter((summary) => summary.label.startsWith("subagent")).length === count + 1,
    );
    const subagent = client.view.current().conversations.filter((summary) => summary.label.startsWith("subagent")).at(-1)!;
    await client.controller.switchConversation(subagent.id);
    const output = client.view.current().conversation.entries.filter((entry) => entry.kind === "pi.tool-result");
    expect(JSON.stringify(output).includes("| metric | change | where |")).toBe(format === "table");
  }
});
