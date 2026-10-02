import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskGraph } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { PlanState, RolloutState } from "../protocol/demo.ts";
import { isBusy, transcript } from "../protocol/transcript.ts";
import type { DurableView } from "../protocol/view.ts";
import { connectTo, freePort, startDemoHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;
const spikeDir = fileURLToPath(new URL("..", import.meta.url));

const idle = (view: DurableView): boolean => !isBusy(view.conversation) && view.conversation.entries.length > 0;
const lastText = (view: DurableView): string | undefined => transcript(view.conversation).at(-1)?.text;
const subagents = (view: DurableView) => view.conversations.filter((summary) => summary.label.startsWith("subagent"));
const rollout = (view: DurableView) => view.docs["demo.rollout"] as RolloutState | null | undefined;
const plan = (view: DurableView) => view.docs["demo.plan"] as PlanState | null | undefined;
const queueItemsOf = (view: DurableView) => ((view.conversation.docs["pi.inbox"] ?? { items: [] }) as { items: { mode: string }[] }).items;

describe("on-call demo", () => {
  it("plans, then delegates to three subagents in parallel; each child is a listed conversation", async () => {
    const { host } = await startDemoHost(defer);
    const client = await connectTo(defer, host);
    await client.controller.toggleTasks();
    let parallelCalls = 0;
    client.view.subscribe(() => {
      const graph: TaskGraph | undefined = client.view.current().tasks;
      const calls = Object.values(graph?.tasks ?? {}).filter((node) => node.kind === "pi.tool" && node.conversations.length > 0);
      parallelCalls = Math.max(parallelCalls, calls.length);
    });

    await client.controller.submit("v2.3 release failed, find out why", "followUp");
    await waitForView(client.view, (view) => idle(view) && /recommend rolling back/i.test(lastText(view) ?? ""));

    const view = client.view.current();
    expect(plan(view)!.items.map((item) => item.text)).toEqual([
      "Search the deploy logs",
      "Compare error metrics",
      "Review the commits in v2.3",
    ]);
    // Created in parallel, so in no particular order.
    expect(subagents(view).map((summary) => summary.title?.split(":")[0]).sort()).toEqual(["commits", "logs", "metrics"]);
    expect(parallelCalls).toBe(3);
    // A child is offered only its own investigation tool.
    const logs = subagents(view).find((summary) => summary.title?.startsWith("logs"))!;
    const child = (await host.harness.conversation(logs.id, context))!;
    const childAgent = await child.agent(context);
    expect(childAgent.tools.map((tool) => tool.name)).toEqual(["search_logs"]);
  });

  it("asks every client to approve a rollback; the first decision wins and the later click is told", async () => {
    const { host } = await startDemoHost(defer);
    const a = await connectTo(defer, host, host.token, "web");
    const b = await connectTo(defer, host, host.token, "tui");

    await a.controller.submit("roll back to v2.2", "followUp");
    await Promise.all([a, b].map((client) => waitForView(client.view, (view) => view.approvals.length === 1)));
    const [approval] = b.view.current().approvals;
    expect(approval).toMatchObject({ tool: "rollback", conversationId: a.view.current().conversation.conversation.id });

    await a.controller.approve(approval!, true);
    await b.controller.approve(approval!, false);
    expect(b.view.current().notices.at(-1)?.message).toMatch(/already approved by web/i);
    await waitForView(b.view, (view) => view.approvals.length === 0);

    await waitForView(a.view, (view) => idle(view) && /check scheduled/i.test(lastText(view) ?? ""));
    const regions = Object.values(rollout(a.view.current())!.runs)[0]!;
    expect(regions).toEqual({
      "us-east": "compensated: traffic restored",
      "eu-west": "failed: health check",
      "ap-south": "compensated: traffic restored",
    });
  });

  it("does not ask again after a restart once the rollback was approved", async () => {
    const port = await freePort();
    const first = await startDemoHost(defer, { port, stepMs: 600 });
    const client = await connectTo(defer, first.host, first.host.token, "web");
    await client.controller.submit("roll back to v2.2", "followUp");
    await waitForView(client.view, (view) => view.approvals.length === 1);
    await client.controller.approve(client.view.current().approvals[0]!, true);
    await waitForView(client.view, (view) => Object.keys(Object.values(rollout(view)?.runs ?? {})[0] ?? {}).length === 3);

    const dataDir = client.view.current().session.directory;
    await first.host.close();
    await waitForView(client.view, (view) => view.connection === "reconnecting");
    let askedAgain = false;
    client.view.subscribe(() => {
      if (client.view.current().approvals.length > 0) askedAgain = true;
    });
    await startDemoHost(defer, { port, dataDir, stepMs: 600 });

    await waitForView(client.view, (view) => view.connection === "connected" && idle(view) && /check scheduled/i.test(lastText(view) ?? ""), 30_000);
    expect(askedAgain).toBe(false);
    // The replay-safe tool found the rollback it had started instead of starting a second one.
    expect(Object.keys(rollout(client.view.current())!.runs)).toHaveLength(1);
  });

  it("delivers a scheduled check as a follow-up after Esc and across a restart", async () => {
    const port = await freePort();
    const first = await startDemoHost(defer, { port });
    const client = await connectTo(defer, first.host);
    await client.controller.submit("check again in 2 seconds", "followUp");
    await waitForView(client.view, (view) => idle(view) && /check scheduled/i.test(lastText(view) ?? ""));
    await client.controller.abort();

    const dataDir = client.view.current().session.directory;
    await first.host.close();
    await startDemoHost(defer, { port, dataDir });

    await waitForView(client.view, (view) => idle(view) && /back to baseline/i.test(lastText(view) ?? ""), 30_000);
    const reminders = transcript(client.view.current().conversation).filter((line) => line.text.startsWith("Reminder:"));
    expect(reminders).toHaveLength(1);
  });

  it("forks at an answer into a conversation without the rollback tool", async () => {
    const { host } = await startDemoHost(defer);
    const client = await connectTo(defer, host);
    await client.controller.submit("v2.3 release failed, find out why", "followUp");
    await waitForView(client.view, (view) => idle(view) && /recommend rolling back/i.test(lastText(view) ?? ""));
    const answer = client.view.current().conversation.entries.findLast((entry) => entry.kind === "pi.assistant")!;
    const parent = client.view.current().conversation.conversation.id;

    await client.controller.fork(String(answer.id), "write the postmortem", ["rollback"]);

    await waitForView(client.view, (view) => view.conversation.conversation.id !== parent && idle(view) && /postmortem/i.test(lastText(view) ?? ""));
    const view = client.view.current();
    expect(view.conversations.find((summary) => summary.id === view.conversation.conversation.id)).toMatchObject({ label: expect.stringMatching(/^fork/) });
    expect(plan(view)!.items).toHaveLength(3);
    const fork = (await host.harness.conversation(view.conversation.conversation.id as ConversationId, context))!;
    expect((await fork.agent(context)).tools.map((tool) => tool.name)).not.toContain("rollback");
    expect(transcript(view.conversation).at(-2)).toEqual({ role: "user", text: "write the postmortem" });
  });

  it("takes a steer sent while the rollback waits without losing its place", async () => {
    const { host } = await startDemoHost(defer);
    const web = await connectTo(defer, host, host.token, "web");
    const tui = await connectTo(defer, host, host.token, "tui");
    await web.controller.submit("roll back to v2.2", "followUp");
    await waitForView(tui.view, (view) => view.approvals.length === 1);
    await tui.controller.submit("keep eu-west drained until the fix ships", "steer");
    await waitForView(web.view, (view) => queueItemsOf(view).some((item) => item.mode === "steer"));
    await web.controller.approve(web.view.current().approvals[0]!, true);

    await waitForView(web.view, (view) => idle(view) && /check scheduled/i.test(lastText(view) ?? ""));
    expect(transcript(web.view.current().conversation).map((line) => line.text)).toContain("keep eu-west drained until the fix ships");
  });

  it("compacts on request; every client sees the summary marker", async () => {
    const { host } = await startDemoHost(defer);
    const pace = await connectTo(defer, host, host.token, "pace");
    const web = await connectTo(defer, host, host.token, "web");
    await pace.controller.submit("v2.3 release failed, find out why", "followUp");
    await waitForView(pace.view, (view) => idle(view) && /recommend rolling back/i.test(lastText(view) ?? ""));

    await pace.controller.compact(undefined);
    await waitForView(web.view, (view) => view.conversation.entries.some((entry) => entry.kind === "pi.compaction"));
    await waitForView(pace.view, (view) => view.notices.some((notice) => /compaction completed/i.test(notice.message)));
  });

  it("hot-reloads the investigation tools; the next call uses the new code", async () => {
    const dir = join(spikeDir, ".tmp", `reload-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    defer(() => rm(dir, { recursive: true, force: true }));
    const module = join(dir, "investigation.ts");
    await copyFile(join(spikeDir, "host", "demo", "investigation.ts"), module);
    const { host, demo } = await startDemoHost(defer, { investigationModule: module });
    const client = await connectTo(defer, host);

    await writeFile(module, (await readFile(module, "utf8")).replace(`const FORMAT = "plain"`, `const FORMAT = "table"`));
    expect(await demo.reload()).toBe(2);

    await client.controller.submit("check the metrics again", "followUp");
    await waitForView(client.view, (view) => idle(view) && subagents(view).length === 1);
    const child = await host.harness.conversation(subagents(client.view.current())[0]!.id, context);
    const { messages } = await child!.context(context);
    const output = messages.flatMap((message) => (message.role === "toolResult" ? message.content : []));
    expect(output.map((block) => (block.type === "text" ? block.text : "")).join("")).toMatch(/^\| /m);
  });
});
