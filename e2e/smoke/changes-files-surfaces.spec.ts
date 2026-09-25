import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { launchPace } from "../fixtures/electron-app";

/**
 * Changes + Files surface smoke (ADR-0035): the real backend reads the seeded
 * Git checkout, every diff is stacked in Changes, and the Files surface walks
 * the same checkout and previews a file through the renderer.
 */
test("Changes scrolls below its header and keeps the header controls usable", async ({}, testInfo) => {
  const testApp = await launchPace({ seedGitChanges: true, seedPreflightAuth: true });
  try {
    appendFileSync(`${testApp.project!.path}/src/app.ts`,
      Array.from({ length: 120 }, (_, i) => `export const row${i} = ${i};\n`).join(""));
    for (let i = 0; i < 35; i++) {
      appendFileSync(`${testApp.project!.path}/src/outline-${i}.ts`, `export const value = ${i};\n`);
    }
    await testApp.resizeWindow(1600, 900);
    const { window } = testApp;
    await openSeededSession(window, testApp.projection!.initialPrompt);
    const dock = window.getByTestId("session-dock");
    const handle = await window.getByRole("separator", { name: "Resize Session dock" }).boundingBox();
    await window.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await window.mouse.down();
    await window.mouse.move(handle!.x - 220, handle!.y + handle!.height / 2, { steps: 8 });
    await window.mouse.up();
    const bar = dock.getByTestId("session-surface-bar");
    const section = dock.getByTestId("session-change-section").first();
    await expect(dock.getByText("export const row0 = 0;", { exact: true })).toBeVisible();
    const headerBefore = await bar.boundingBox();
    const sectionBefore = await section.boundingBox();
    const dockBox = await dock.boundingBox();
    const outline = dock.getByRole("navigation", { name: "Changed files" });
    const outlineBox = await outline.boundingBox();
    expect(Math.abs(outlineBox!.y + outlineBox!.height - dockBox!.y - dockBox!.height)).toBeLessThanOrEqual(2);
    // Each column owns its scrollbar; the diff scroller must end before the outline.
    const diffScroller = section.locator("..");
    const diffBox = await diffScroller.boundingBox();
    expect(diffBox!.x + diffBox!.width).toBeLessThanOrEqual(outlineBox!.x + 1);
    await window.mouse.move(dockBox!.x + 100, dockBox!.y + dockBox!.height / 2);
    await window.mouse.wheel(0, 650);
    await expect.poll(async () => (await section.boundingBox())!.y).toBeLessThan(sectionBefore!.y - 100);
    await expect.poll(async () => (await bar.boundingBox())!.y).toBe(headerBefore!.y);
    await expect.poll(() => section.evaluate((node) => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
          return parent.getBoundingClientRect().top;
        }
      }
      return -1;
    })).toBeGreaterThanOrEqual(headerBefore!.y + headerBefore!.height);
    const fileHeader = section.getByRole("button").first();
    await expect.poll(async () => (await fileHeader.boundingBox())!.y).toBeCloseTo(diffBox!.y, 0);
    expect(await outline.locator("div").first().evaluate((node) => node.scrollTop)).toBe(0);
    const diffScrollBefore = await diffScroller.evaluate((node) => node.scrollTop);
    await window.mouse.move(outlineBox!.x + outlineBox!.width / 2, outlineBox!.y + outlineBox!.height / 2);
    await window.mouse.wheel(0, 500);
    await expect.poll(() => outline.locator("div").first().evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
    expect(await diffScroller.evaluate((node) => node.scrollTop)).toBe(diffScrollBefore);
    // Geometry alone misses transparent overlays: the real refresh button
    // must remain the hit target in the titlebar after the body has scrolled.
    const refresh = bar.getByRole("button", { name: "Refresh Session changes" });
    await expect.poll(() => refresh.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    await window.screenshot({ path: testInfo.outputPath("changes-scrolled.png") });
    await bar.getByRole("button", { name: "Collapse all", exact: true }).click();
    await expect(bar.getByRole("button", { name: "Expand all", exact: true })).toBeVisible();

    await dock.getByRole("button", { name: "Files", exact: true }).click();
    const files = window.getByRole("region", { name: "Session files" });
    await files.getByText("src", { exact: true }).click();
    await files.getByText("app.ts", { exact: true }).click();
    const viewer = files.getByTestId("session-file-viewer");
    await expect(viewer).toBeVisible();
    const treePane = files.locator(".pigui-files-tree").locator("..");
    const previewPane = viewer.locator("../..");
    const treeBox = await treePane.boundingBox();
    const previewBox = await previewPane.boundingBox();
    expect(Math.abs(treeBox!.y + treeBox!.height - dockBox!.y - dockBox!.height)).toBeLessThanOrEqual(2);
    expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(treeBox!.x + 1);
    await window.mouse.move(treeBox!.x + treeBox!.width / 2, treeBox!.y + treeBox!.height / 2);
    await window.mouse.wheel(0, 500);
    await expect.poll(() => treePane.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
    expect(await previewPane.evaluate((node) => node.scrollTop)).toBe(0);
    const treeScroll = await treePane.evaluate((node) => node.scrollTop);
    await window.mouse.move(previewBox!.x + 50, previewBox!.y + previewBox!.height / 2);
    await window.mouse.wheel(0, 500);
    await expect.poll(() => previewPane.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
    expect(await treePane.evaluate((node) => node.scrollTop)).toBe(treeScroll);
    await window.screenshot({ path: testInfo.outputPath("files-independent-scroll.png") });

  } finally {
    await testApp.close();
  }
});

async function openSeededSession(window: Page, title: string) {
  await window.getByRole("button", { name: "New Chat for E2E Project", exact: true }).click();
  await expect(window.getByRole("combobox", { name: "Prompt" })).toBeVisible();

  const session = window.getByRole("button", { name: new RegExp(`^${title}`, "i") });

  await expect(session).toBeVisible();
  await session.click();
  await window.getByRole("button", { name: "Session dock", exact: true }).click();
}

test("Changes stacks every diff; Files browses and previews the checkout", async ({}, testInfo) => {
  const testApp = await launchPace({ seedGitChanges: true, seedPreflightAuth: true });

  try {
    await testApp.resizeWindow(1440, 900);

    const { window } = testApp;

    await openSeededSession(window, testApp.projection!.initialPrompt);

    const dock = window.getByTestId("session-dock");

    await expect(dock).toBeVisible();

    // Changes: both files are open at once, no click needed to see either diff.
    await expect(dock.getByText("2 files", { exact: true })).toBeVisible();
    await expect(dock.getByTestId("session-change-section")).toHaveCount(2);
    await expect(
      dock.getByText('export const state = "after";', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      dock.getByText("export const enabled = true;", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    const handle = await window.getByRole("separator", { name: "Resize Session dock" }).boundingBox();
    expect(handle).not.toBeNull();
    await window.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await window.mouse.down();
    await window.mouse.move(handle!.x - 180, handle!.y + handle!.height / 2, { steps: 8 });
    await window.mouse.up();
    const outline = dock.getByRole("navigation", { name: "Changed files" });
    await expect.poll(async () => {
      const outlineBox = await outline.boundingBox();
      const sectionBox = await dock.getByTestId("session-change-section").first().boundingBox();
      return outlineBox && sectionBox ? outlineBox.x >= sectionBox.x + sectionBox.width : false;
    }).toBe(true);
    await window.screenshot({ path: testInfo.outputPath("changes-stacked.png") });

    // Narrow docks keep both scroll columns alongside one another.
    await testApp.resizeWindow(960, 780);
    const fileNames = dock.getByTestId("session-change-section").locator("[title]").filter({ hasText: /^src\// });
    await expect(fileNames).toHaveCount(2);
    for (const fileName of await fileNames.all()) {
      await expect.poll(async () => fileName.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(0);
    }
    await expect.poll(async () => {
      const outlineBox = await outline.boundingBox();
      const sectionBox = await dock.getByTestId("session-change-section").first().boundingBox();
      return outlineBox && sectionBox ? outlineBox.x >= sectionBox.x + sectionBox.width : false;
    }).toBe(true);
    await window.screenshot({ path: testInfo.outputPath("changes-narrow.png") });

    await dock.getByRole("button", { name: "Collapse all", exact: true }).click();
    await expect(
      dock.getByText('export const state = "after";', { exact: true }),
    ).toHaveCount(0);
    await expect(dock.getByRole("button", { name: "Expand all", exact: true })).toBeVisible();

    // Files: the tree is rooted at the checkout, directories load on demand,
    // and a file renders through the code renderer.
    await dock.getByRole("button", { name: "Files", exact: true }).click();
    await expect(window.getByRole("region", { name: "Session files" })).toBeVisible();

    const tree = window.getByRole("region", { name: "Session files" });

    await expect(tree.getByText("src", { exact: true })).toBeVisible();
    await tree.getByText("src", { exact: true }).click();
    await tree.getByText("app.ts", { exact: true }).click();
    await expect(
      tree.getByText('export const state = "after";', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId("session-surface-bar")).toContainText("src/app.ts");
    await window.screenshot({ path: testInfo.outputPath("files-preview.png") });

    // Refresh must replace the review with the clean state, rather than leave
    // an obsolete outline or diff behind after changes have been committed.
    execFileSync("git", ["add", "."], { cwd: testApp.project!.path });
    execFileSync("git", ["commit", "-m", "E2E reviewed changes"], { cwd: testApp.project!.path });
    await dock.getByRole("button", { name: "Changes", exact: true }).click();
    await dock.getByRole("button", { name: "Refresh Session changes", exact: true }).click();
    await expect(dock.getByRole("heading", { name: "No changes yet" })).toBeVisible();
    await expect(dock.getByTestId("session-change-section")).toHaveCount(0);
    await expect(dock.getByRole("navigation", { name: "Changed files" })).toHaveCount(0);
    await window.screenshot({ path: testInfo.outputPath("changes-empty.png") });
  } finally {
    await testApp.close();
  }
});
