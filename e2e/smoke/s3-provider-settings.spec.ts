import { expect, test } from "@playwright/test";
import {
  launchPace,
  type E2EProject,
  type E2ESessionProjection,
} from "../fixtures/electron-app";

// Astryx renders the Settings tab set as <nav aria-label="Tabs"> + buttons,
// not role="tab". Scope through the nav so "Subscription" cannot also match
// the "Login with subscription" buttons on the cards below.
function settingsTab(window: import("@playwright/test").Page, name: string) {
  return window
    .getByRole("navigation", { name: "Tabs" })
    .getByRole("button", { name, exact: true });
}

// The sidebar row button's accessible name starts with the Session title
// ("<title> <relative time>"), while the hover-revealed menu button next to it
// reads "Session actions for <title>". Anchoring at the start keeps the row the
// only match without resorting to positional selectors.
function sessionRowButton(window: import("@playwright/test").Page, title: string) {
  return window.getByRole("button", { name: new RegExp(`^${title}`, "i") });
}

async function openProjectDraft(window: import("@playwright/test").Page, project: E2EProject) {
  const newSession = window.getByRole("button", { name: "New Chat for E2E Project", exact: true });
  await expect(newSession).toBeVisible();
  await newSession.click();
  await expect(window.getByRole("combobox", { name: "Prompt" })).toBeVisible();
}

async function openSession(
  window: import("@playwright/test").Page,
  project: E2EProject,
  projection: E2ESessionProjection,
) {
  await openProjectDraft(window, project);
  const session = sessionRowButton(window, projection.initialPrompt);
  await expect(session).toBeVisible();
  await session.click();
  await expect(window.getByLabel("Session dock")).toBeVisible();
}

test.describe("S3: Provider Settings (DF-002)", () => {
  test("Settings dialog shows Subscription/API Key tabs with provider cards", async () => {
    const testApp = await launchPace({ seedPreflightAuth: true });

    try {
      // Open Settings without navigating away from the current page.
      await testApp.window.getByRole("button", { name: "Settings" }).click();
      await expect(testApp.window.getByRole("dialog", { name: "Settings" })).toBeVisible();

      // Tab structure exists
      await expect(
        settingsTab(testApp.window, "Subscription"),
      ).toBeVisible();
      await expect(
        settingsTab(testApp.window, "API Key"),
      ).toBeVisible();

      // API Key tab: OpenAI / Anthropic / DeepSeek / Grok (xAI) cards + brand icons.
      // Brand icons are scoped to their card: the Models section below the tabs
      // renders the same provider-icon testid per model-visibility group.
      await settingsTab(testApp.window, "API Key").click();
      for (const provider of ["openai", "anthropic", "deepseek", "xai"]) {
        const card = testApp.window.getByTestId(`provider-api-key-${provider}`);
        await expect(card).toBeVisible();
        await expect(card.getByTestId(`provider-icon-${provider}`)).toBeVisible();
      }
      await expect(
        testApp.window.getByTestId("provider-api-key-openai-codex"),
      ).toHaveCount(0);

      // Subscription tab: ChatGPT/Codex + Anthropic + Grok (xAI)
      await settingsTab(testApp.window, "Subscription").click();
      for (const provider of ["openai-codex", "anthropic", "xai"]) {
        const card = testApp.window.getByTestId(`provider-subscription-${provider}`);
        await expect(card).toBeVisible();
        await expect(card.getByTestId(`provider-icon-${provider}`)).toBeVisible();
      }
      // OpenAI API key and DeepSeek have no subscription card
      await expect(
        testApp.window.getByTestId("provider-subscription-openai"),
      ).toHaveCount(0);
      await expect(
        testApp.window.getByTestId("provider-subscription-deepseek"),
      ).toHaveCount(0);
    } finally {
      await testApp.close();
    }
  });

  test("blocks session creation with no provider credentials and offers Settings CTA", async () => {
    const testApp = await launchPace({
      seedProject: true,
      seedPreflightAuth: false,
    });

    try {
      // Open draft composer without any auth -> hard gate
      await testApp.window.getByRole("button", { name: "New Chat for E2E Project", exact: true }).click();

      const gate = testApp.window.getByTestId("session-draft-no-models-gate");
      await expect(gate).toBeVisible();
      await expect(
        gate.getByText("No models available", { exact: true }),
      ).toBeVisible();

      // CTA opens Settings over the draft.
      await gate.getByRole("button", { name: /Open Provider Settings/i }).click();
      await expect(testApp.window.getByRole("dialog", { name: "Settings" })).toBeVisible();
      await expect(
        settingsTab(testApp.window, "API Key"),
      ).toBeVisible();
    } finally {
      await testApp.close();
    }
  });

  test("preflight model_auth failure shows Configure providers CTA to Settings", async () => {
    const testApp = await launchPace({
      requirePreflight: true,
      seedPreflightAuth: false,
    });

    try {
      await expect(testApp.window.getByText("Before your first session")).toBeVisible();
      await expect(
        testApp.window.getByText(/No provider credentials/i).first(),
      ).toBeVisible({ timeout: 30_000 });

      // Continue is disabled while auth missing
      await expect(
        testApp.window.getByRole("button", { name: /Continue/i }),
      ).toBeDisabled();

      // CTA opens Settings over preflight.
      await testApp.window.getByRole("button", { name: /Configure providers/i }).click();
      await expect(testApp.window.getByRole("dialog", { name: "Settings" })).toBeVisible();
      await expect(
        settingsTab(testApp.window, "API Key"),
      ).toBeVisible();
      await testApp.window.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Close", exact: true }).click();
      await expect(testApp.window.getByText("Before your first session")).toBeVisible();
    } finally {
      await testApp.close();
    }
  });

  test("Settings preserves the draft and restores focus; Add Models opens its section", async () => {
    const testApp = await launchPace({ seedProject: true, seedModelControls: true, seedPreflightAuth: true });
    try {
      const page = testApp.window;
      await page.getByRole("button", { name: "New Chat for E2E Project", exact: true }).click();
      const draft = page.getByRole("combobox", { name: "Prompt" });
      await draft.fill("Keep this unsent draft while I change settings");
      const url = page.url();
      const trigger = page.getByRole("button", { name: "Settings", exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveJSProperty("open", true);
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(url);
      await expect(draft).toHaveText("Keep this unsent draft while I change settings");
      await expect(trigger).toBeFocused();

      await page.getByTestId("model-thinking-trigger").click();
      await page.getByText("Add Models", { exact: true }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("region", { name: "Models", exact: true })).toBeVisible();
      const selectedModel = dialog.getByRole("listitem").filter({
        has: page.getByRole("checkbox", { checked: true }),
      }).first();
      await expect(selectedModel).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(url);
      await expect(draft).toHaveText("Keep this unsent draft while I change settings");
    } finally {
      await testApp.close();
    }
  });

  test("legacy Models bookmarks open the dialog during first-run preflight", async () => {
    const testApp = await launchPace({ requirePreflight: true, seedPreflightAuth: false });
    try {
      await expect(testApp.window.getByText("Before your first session")).toBeVisible();
      await testApp.window.evaluate(() => { window.location.hash = "/settings#models"; });
      const dialog = testApp.window.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("region", { name: "Models", exact: true })).toBeVisible();
      await expect(testApp.window).toHaveURL(/#\/preflight\?settings=models$/);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(testApp.window).toHaveURL(/#\/preflight$/);
    } finally {
      await testApp.close();
    }
  });

  test("after provider auth is configured, session creation exposes models", async () => {
    const testApp = await launchPace({
      seedModelControls: true,
      seedPreflightAuth: true,
    });

    try {
      // Draft composer (no session selected) must NOT show the no-models gate
      await testApp.window.getByRole("button", { name: "New Chat for E2E Project", exact: true }).click();
      await expect(testApp.window.getByTestId("session-draft-no-models-gate")).toHaveCount(0);

      // Open the seeded session: model/thinking trigger is available with models
      await openSession(
        testApp.window,
        testApp.project!,
        testApp.projection!,
      );

      const trigger = testApp.window.getByTestId("model-thinking-trigger");
      await expect(trigger).toBeVisible();

      // Popover lists at least one model
      await trigger.click();
      await expect(testApp.window.getByTestId("model-thinking-popover")).toBeVisible();
      const modelItems = testApp.window
        .getByTestId("model-thinking-model-list")
        .getByRole("listitem");
      await expect(modelItems.first()).toBeVisible();
      const count = await modelItems.count();
      expect(count).toBeGreaterThanOrEqual(1);
    } finally {
      await testApp.close();
    }
  });
});
