import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { transcript } from "../protocol/transcript.ts";
import { connectTo, freePort, startFauxHost, useCleanups, waitForView } from "./support.ts";
import { startTui } from "./tui-harness.ts";

const defer = useCleanups();
const webConfig = fileURLToPath(new URL("../web/vite.config.ts", import.meta.url));

it("shows the same conversation in the web page and the TUI, driven from either", async () => {
  const host = await startFauxHost(defer, { answers: ["answer-for-the-web", "answer-for-the-tui"] });
  const observer = await connectTo(defer, host);

  const vite = await createServer({ configFile: webConfig, server: { port: await freePort() }, logLevel: "error" });
  await vite.listen();
  defer(() => vite.close());
  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${vite.resolvedUrls!.local[0]}#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);

  const tui = await startTui(defer, host.url, host.token);
  await tui.until((text) => text.includes("faux/faux-1"), "the footer");

  const composer = page.getByRole("textbox");
  await composer.fill("question-from-the-web");
  await composer.press("Enter");
  await tui.until((text) => text.includes("question-from-the-web") && text.includes("answer-for-the-web"), "the web's turn");
  await expect.poll(() => page.getByText("answer-for-the-web").count()).toBeGreaterThan(0);

  tui.pty.write("question-from-the-tui");
  tui.pty.write("\r");
  await expect.poll(() => page.getByText("answer-for-the-tui").count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => page.getByText("question-from-the-tui").count()).toBeGreaterThan(0);

  await waitForView(observer.view, (view) => transcript(view.conversation).length === 4);
  expect(transcript(observer.view.current().conversation).map((line) => line.text)).toEqual([
    "question-from-the-web",
    "answer-for-the-web",
    "question-from-the-tui",
    "answer-for-the-tui",
  ]);

  await host.close();
  await expect.poll(() => page.getByText(/reconnecting/i).count(), { timeout: 10_000 }).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});
