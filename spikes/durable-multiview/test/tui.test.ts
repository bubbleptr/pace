import { expect, it } from "vitest";
import { transcript } from "../protocol/transcript.ts";
import { connectTo, startDemoHost, startFauxHost, useCleanups, waitForView } from "./support.ts";
import { startTui } from "./tui-harness.ts";

const defer = useCleanups();

it("drives the host from the TUI and shows the answer, then the lost host", async () => {
  const host = await startFauxHost(defer, { answers: ["pong-from-the-host"] });
  const observer = await connectTo(defer, host);
  const tui = await startTui(defer, host.url, host.token);

  await tui.until((text) => text.includes("faux/faux-1"), "the footer");
  tui.pty.write("ping-from-the-tui");
  tui.pty.write("\r");

  await waitForView(observer.view, (view) => transcript(view.conversation)[0]?.text === "ping-from-the-tui");
  await tui.until((text) => text.includes("pong-from-the-host"), "the answer");

  await host.close();
  await tui.until((text) => text.includes("reconnecting"), "the reconnect notice");

  tui.pty.write("\u0004");
  await tui.until(() => tui.exited() !== undefined, "exit", 5000).catch(() => {});
  expect(tui.exited()).toBe(0);
});

it("shows the plan and a pending approval, and decides it with /approve", async () => {
  const { host } = await startDemoHost(defer);
  const web = await connectTo(defer, host, host.token, "web");
  const tui = await startTui(defer, host.url, host.token);
  await tui.until((text) => text.includes("faux/faux-1"), "the footer");

  await web.controller.submit("v2.3 release failed, find out why", "followUp");
  await tui.until((text) => text.includes("[x] Review the commits in v2.3"), "the finished plan");
  await web.controller.submit("roll back to v2.2", "followUp");
  await tui.until((text) => text.includes("Approve rollback? main: Roll back to v2.2"), "the approval");
  tui.pty.write("/approve");
  tui.pty.write("\r");

  await waitForView(web.view, (view) => view.approvals.length === 0);
  await tui.until((text) => text.includes("You approved the rollback."), "the decision");
});

it("remembers an approval shown on connection when another client decides first", async () => {
  const { host } = await startDemoHost(defer);
  const web = await connectTo(defer, host, host.token, "web");
  await web.controller.submit("roll back to v2.2", "followUp");
  await waitForView(web.view, (view) => view.approvals.length === 1);
  const approval = web.view.current().approvals[0]!;
  const tui = await startTui(defer, host.url, host.token);
  await tui.until((text) => text.includes("Approve rollback?"), "the approval already pending on connection");

  await web.controller.approve(approval, false);
  await waitForView(web.view, (view) => view.approvals.length === 0);
  tui.pty.write("/approve\r");

  await tui.until((text) => text.includes("Already denied by web."), "the earlier decision", 5000);
});
