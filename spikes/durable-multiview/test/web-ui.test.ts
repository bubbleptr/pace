import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { expect, it } from "vitest";
import type { OpenedHost } from "../host/host.ts";
import { freePort, startFauxHost, useCleanups } from "./support.ts";

const defer = useCleanups();
const webConfig = fileURLToPath(new URL("../web/vite.config.ts", import.meta.url));

async function openPage(host: OpenedHost, width: number) {
  const vite = await createServer({ configFile: webConfig, server: { port: await freePort() }, logLevel: "error" });
  await vite.listen();
  defer(() => vite.close());
  const browser = await chromium.launch();
  defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.goto(`${vite.resolvedUrls!.local[0]}#token=${encodeURIComponent(host.token)}&url=${encodeURIComponent(host.url)}`);
  await page.getByRole("textbox").waitFor();
  return page;
}

it("keeps the chat usable on a phone with navigation and live state still reachable", async () => {
  const host = await startFauxHost(defer);
  const page = await openPage(host, 390);

  const composer = page.getByRole("textbox");
  expect((await composer.boundingBox())!.width).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByRole("button", { name: "main", exact: true }).click();
  await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
  await page.getByRole("button", { name: "Live state", exact: true }).click();
  await page.getByRole("dialog").getByText("No live tasks").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Controls", exact: true }).click();
  await page.getByRole("menuitem", { name: "Compact", exact: true }).waitFor();
});

it("preserves an unsent follow-up and disables write controls while reconnecting", async () => {
  const host = await startFauxHost(defer, { answers: ["An answer to fork."] });
  const page = await openPage(host, 1280);
  const composer = page.getByRole("textbox");
  await composer.fill("hello");
  await composer.press("Enter");
  await page.getByRole("button", { name: "Fork", exact: true }).waitFor();
  await composer.fill("keep this draft");

  await host.close();
  await page.getByText("Host connection lost", { exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "Follow-up", exact: true }).isDisabled()).toBe(true);
  expect(await page.getByRole("button", { name: "Compact", exact: true }).isDisabled()).toBe(true);
  expect(await page.getByRole("button", { name: "Fork", exact: true }).isDisabled()).toBe(true);
  expect(await composer.textContent()).toBe("keep this draft");
});
