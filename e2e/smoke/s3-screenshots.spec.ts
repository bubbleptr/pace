import { expect, test } from "@playwright/test";
import { launchPace } from "../fixtures/electron-app";

test.describe("DF-011 draft model trigger screenshots", () => {
  test("capture draft composer model trigger and popover", async () => {
    const testApp = await launchPace({
      seedProject: true,
      seedPreflightAuth: true,
      seedModelControls: true,
    });

    try {
      await testApp.resizeWindow(1280, 840);

      // Open draft composer
      await testApp.window.getByRole("button", { name: "New Chat for E2E Project", exact: true }).click();
      await expect(testApp.window.getByRole("combobox", { name: "Prompt" })).toBeVisible();

      // Model trigger should be present in draft (DF-011 fix)
      const trigger = testApp.window.getByTestId("model-thinking-trigger");
      await expect(trigger).toBeVisible({ timeout: 15_000 });
      await testApp.window.waitForTimeout(400);
      await testApp.window.screenshot({
        path: "e2e/screenshots/df11-draft-model-trigger.png",
      });

      // Open popover
      await trigger.click();
      await expect(testApp.window.getByTestId("model-thinking-popover")).toBeVisible();
      await testApp.window.waitForTimeout(400);
      await testApp.window.screenshot({
        path: "e2e/screenshots/df11-draft-model-popover.png",
      });
    } finally {
      await testApp.close();
    }
  });
});
