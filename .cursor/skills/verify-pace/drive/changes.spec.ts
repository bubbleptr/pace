import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { launchPace } from "../../../../e2e/fixtures/electron-app";

const execFileAsync = promisify(execFile);

test("session dock Changes shows the seeded git diff", async () => {
  const evidenceDir = process.env.PACE_VERIFY_EVIDENCE;
  if (!evidenceDir) {
    throw new Error("PACE_VERIFY_EVIDENCE is required");
  }
  await mkdir(evidenceDir, { recursive: true });

  const testApp = await launchPace({ seedGitChanges: true, seedPreflightAuth: true });
  const spawnargs = testApp.app.process().spawnargs ?? [];
  const userDataArg = spawnargs.find((arg) => arg.startsWith("--user-data-dir="));
  const userDataDir = userDataArg?.slice("--user-data-dir=".length) ?? "";
  const testRoot = userDataDir ? path.dirname(userDataDir) : "";
  const instance = {
    pid: testApp.app.process().pid ?? null,
    userDataDir,
    testRoot,
    evidenceDir,
    closed: false,
  };

  await writeFile(path.join(evidenceDir, "instance.json"), `${JSON.stringify(instance, null, 2)}\n`);

  try {
    expect(userDataDir).toContain(`${path.sep}pace-e2e-`);
    if (!process.env.PACE_E2E_EXECUTABLE) {
      expect(
        spawnargs.some((arg) => arg.endsWith(path.join("apps", "desktop", "out", "main", "main.js"))),
      ).toBe(true);
    }
    await expect(testApp.window).toHaveTitle(/Pace/);
    const title = await testApp.window.title();
    await writeFile(
      path.join(evidenceDir, "doctor-instance.txt"),
      `title=${title}\nuserDataDir=${userDataDir}\npid=${instance.pid}\n`,
    );

    await testApp.resizeWindow(1440, 900);

    const { window } = testApp;
    await window.getByRole("button", { name: "New Chat for E2E Project", exact: true }).click();
    await expect(window.getByRole("combobox", { name: "Prompt" })).toBeVisible();

    const session = window.getByRole("button", {
      name: new RegExp(`^${testApp.projection!.initialPrompt}`, "i"),
    });
    await expect(session).toBeVisible();
    await session.click();
    await window.getByRole("button", { name: "Session dock", exact: true }).click();

    const dock = window.getByTestId("session-dock");
    await expect(dock).toBeVisible();
    await expect(window.getByRole("complementary", { name: "Changes" })).toBeVisible();
    await expect(dock.getByText("2 files", { exact: true })).toBeVisible();
    await expect(dock.getByTestId("session-change-section")).toHaveCount(2);
    await expect(dock.getByText('export const state = "after";', { exact: true })).toBeVisible();
    await expect(dock.getByText("export const enabled = true;", { exact: true })).toBeVisible();

    const projectPath = testApp.project!.path;
    const appSource = await readFile(path.join(projectPath, "src", "app.ts"), "utf8");
    await writeFile(path.join(evidenceDir, "checkout-app.ts"), appSource);
    const diff = await execFileAsync("git", ["diff", "--", "src/app.ts"], {
      cwd: projectPath,
      encoding: "utf8",
    });
    await writeFile(path.join(evidenceDir, "checkout.diff"), diff.stdout);
    expect(appSource).toContain('export const state = "after";');

    await window.screenshot({ path: path.join(evidenceDir, "changes.png") });
    const aria = await dock.ariaSnapshot();
    await writeFile(path.join(evidenceDir, "changes.aria.yml"), aria);
    await writeFile(
      path.join(evidenceDir, "result.txt"),
      "feature=session-dock-changes\nentry=Session dock button\n",
    );
  } finally {
    await testApp.close();
    await writeFile(
      path.join(evidenceDir, "instance.json"),
      `${JSON.stringify({ ...instance, closed: true, pid: null }, null, 2)}\n`,
    );
  }
});
