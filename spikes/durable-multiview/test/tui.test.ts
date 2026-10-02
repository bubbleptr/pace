import { expect, it } from "vitest";
import { transcript } from "../protocol/transcript.ts";
import { connectTo, startFauxHost, useCleanups, waitForView } from "./support.ts";
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
