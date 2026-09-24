import { expect, test, type Page } from "@playwright/test";
import {
  assertNoFixtureData,
  launchPace,
  type E2EProject,
  type E2ESessionProjection,
} from "../fixtures/electron-app";

declare global {
  interface Window {
    __paceE2EBackendLifecycle?: Array<{
      generation: number;
      lifecycle: string;
    }>;
  }
}

// The sidebar row button's accessible name starts with the Session title
// ("<title> <relative time>"), while the hover-revealed menu button next to it
// reads "Session actions for <title>". Anchoring at the start keeps the row the
// only match without resorting to positional selectors.
function sessionRowButton(window: Page, title: string) {
  return window.getByRole("button", { name: new RegExp(`^${title}`, "i") });
}

async function openProjectDraft(window: Page, project: E2EProject) {
  const newSession = window.getByRole("button", { name: "New Chat for E2E Project", exact: true });

  await expect(newSession).toBeVisible();
  await newSession.click();
  await expect(window.getByRole("textbox")).toBeVisible();
  await expect(window.getByText(project.displayName, { exact: true }).first()).toBeVisible();
}

async function openSession(
  window: Page,
  project: E2EProject,
  projection: E2ESessionProjection,
) {
  await openProjectDraft(window, project);

  const session = sessionRowButton(window, projection.initialPrompt);

  await expect(session).toBeVisible();
  await session.click();
  await expect(window.getByRole("button", { name: "Session dock", exact: true })).toBeVisible();
}

test.describe("M1: Real-data-only", () => {
  test("starts from an isolated fixture-free state", async () => {
    const testApp = await launchPace();

    try {
      await expect(testApp.window).toHaveTitle(/Pace/);
      await expect(
        testApp.window.getByRole("button", { name: /add project/i }),
      ).toBeVisible();
      await assertNoFixtureData(testApp.window);
    } finally {
      await testApp.close();
    }
  });

  test("opens a real registered Project with an empty Session draft", async () => {
    const testApp = await launchPace({ seedProject: true, seedPreflightAuth: true });

    try {
      await openProjectDraft(testApp.window, testApp.project!);
      await expect(testApp.window.getByTestId("project-row-with-actions").getByRole("button", { name: "No chats", exact: true })).toBeVisible();
      await assertNoFixtureData(testApp.window);
    } finally {
      await testApp.close();
    }
  });
});

test.describe("M2: Reliable lifecycle", () => {
  test("archives a persisted Session through the real UI", async () => {
    const testApp = await launchPace({ seedSession: true, seedPreflightAuth: true });

    try {
      await openSession(
        testApp.window,
        testApp.project!,
        testApp.projection!,
      );
      // Archive lives on the sidebar row's action menu (the dock's
      // Actions surface was removed; the row menu is the remaining entry).
      await testApp.window
        .getByRole("button", {
          name: `Session actions for ${testApp.projection!.initialPrompt}`,
        })
        .click();

      const archive = testApp.window.getByRole("menuitem", { name: "Archive Session" });

      await archive.click();
      await expect.poll(async () => (await testApp.readProjection())?.status).toBe(
        "archived",
      );
      expect((await testApp.readProjection())?.archivedAt).toBeTruthy();
      // Archived Sessions leave the sidebar list.
      await expect(
        sessionRowButton(testApp.window, testApp.projection!.initialPrompt),
      ).toHaveCount(0);
    } finally {
      await testApp.close();
    }
  });

  test("restarts the killed backend and reloads persisted projections", async () => {
    // A second Session this renderer never views: ADR-0044 §5 keeps a viewed
    // (live-owned) projection wholesale across rehydrate, so only a record
    // the renderer does not own proves the restart re-read the store.
    const testApp = await launchPace({
      seedSession: true,
      seedPreflightAuth: true,
      projections: (seeded) => [
        seeded,
        {
          ...seeded,
          sessionId: "e2e-background-session",
          runtimeId: "e2e-background-runtime",
          piSessionId: "e2e-background-pi-session",
          initialPrompt: "Background before restart",
        },
      ],
    });

    try {
      await openSession(
        testApp.window,
        testApp.project!,
        testApp.projection!,
      );
      await expect(
        sessionRowButton(testApp.window, "Background before restart"),
      ).toBeVisible();
      await testApp.window.evaluate(() => {
        window.__paceE2EBackendLifecycle = [];
        window.pace!.onBackendEvent((event) => {
          if (event.event.sessionId !== "__backend__") {
            return;
          }

          window.__paceE2EBackendLifecycle!.push({
            generation: Number(event.event.payload.generation),
            lifecycle: String(event.event.payload.lifecycle),
          });
        });
      });

      // The row above means the backend's startup list (the one pass that
      // re-saves records) is done; this record has no journal to heal anyway.
      await testApp.writeProjection({
        ...testApp.projection!,
        sessionId: "e2e-background-session",
        runtimeId: "e2e-background-runtime",
        piSessionId: "e2e-background-pi-session",
        initialPrompt: "Reloaded after backend restart",
        updatedAt: "2026-07-19T00:02:00.000Z",
      });
      const killedGeneration = await testApp.window.evaluate(() =>
        window.pace!.invoke<{ generation: number }>("__e2e_kill_backend"),
      );

      await expect
        .poll(
          () =>
            testApp.window.evaluate(
              () => window.__paceE2EBackendLifecycle ?? [],
            ),
          { timeout: 15_000 },
        )
        .toEqual([
          {
            generation: killedGeneration.generation,
            lifecycle: "disconnected",
          },
          {
            generation: killedGeneration.generation + 1,
            lifecycle: "connected",
          },
        ]);
      await expect(
        sessionRowButton(testApp.window, "Reloaded after backend restart"),
      ).toBeVisible();
      await expect(
        sessionRowButton(testApp.window, testApp.projection!.initialPrompt),
      ).toBeVisible();
      await expect(
        testApp.window.getByRole("heading", { name: testApp.projection!.initialPrompt }),
      ).toBeVisible();
      await expect(testApp.window).toHaveTitle(/Pace/);
    } finally {
      await testApp.close();
    }
  });

});

test.describe("M3: Real diff action surface", () => {
  test("renders Git changes from the Session checkout", async () => {
    const testApp = await launchPace({ seedGitChanges: true, seedPreflightAuth: true });

    try {
      await openSession(
        testApp.window,
        testApp.project!,
        testApp.projection!,
      );
      await testApp.resizeWindow(960, 780);
      await testApp.window.getByRole("button", { name: "Session dock", exact: true }).click();
      await expect(testApp.window.getByRole("complementary", { name: "Changes" })).toBeVisible();
      await expect(testApp.window.getByRole("dialog")).toHaveCount(0);

      // Each file name renders twice (section header + outline); at narrow
      // dock widths the header copy truncates to zero width, so assert on
      // whichever copy is actually visible.
      await expect(
        testApp.window.getByText("src/app.ts").filter({ visible: true }).first(),
      ).toBeVisible();
      await expect(
        testApp.window.getByText("src/new-feature.ts").filter({ visible: true }).first(),
      ).toBeVisible();
      await expect(testApp.window.getByText("+2").first()).toBeVisible();
      await expect(testApp.window.getByText("-1").first()).toBeVisible();
      await expect(
        testApp.window.getByText('export const state = "after";', {
          exact: true,
        }),
      ).toBeVisible({ timeout: 15_000 });

      const panel = testApp.window.getByTestId("session-dock");
      const bounds = await panel.boundingBox();
      const viewport = await testApp.window.evaluate(() => ({width: innerWidth, height: innerHeight}));
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThan(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
      await testApp.window.screenshot({path: "output/playwright/session-dock-narrow.png"});
      await panel.getByRole("button", {name: "Terminal", exact: true}).click();
      await expect(testApp.window.getByRole("complementary", {name: "Terminal"})).toBeVisible();
      await testApp.window.getByRole("button", { name: "Session dock", exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expect(testApp.window.getByRole("dialog")).toHaveCount(0);
      await testApp.window.getByRole("button", { name: "Session dock", exact: true }).click();
      await expect(panel).toBeVisible();
      await testApp.resizeWindow(1440, 900);
      await expect(panel).toBeVisible();
      await panel.getByRole("button", {name: "Changes", exact: true}).click();
      await testApp.window.screenshot({path: "output/playwright/session-dock-wide.png"});
    } finally {
      await testApp.close();
    }
  });

  test("puts the Session dock beside Chat in a wide Electron window", async () => {
    const testApp = await launchPace({ seedGitChanges: true, seedPreflightAuth: true });

    try {
      await testApp.resizeWindow(1440, 900);
      await openSession(
        testApp.window,
        testApp.project!,
        testApp.projection!,
      );
      await testApp.window.getByRole("button", { name: "Session dock", exact: true }).click();

      const changesAside = testApp.window.getByTestId("session-dock");

      await expect(changesAside).toBeVisible();
      await expect(testApp.window.getByLabel("Live Chat messages")).toBeVisible();
      await expect(testApp.window.getByLabel("Resize Session dock")).toBeVisible();
      await expect(
        testApp.window.getByRole("dialog", { name: "Changes" }),
      ).toHaveCount(0);
      await expect(changesAside.getByText("src/app.ts").first()).toBeVisible();
      await expect(
        changesAside.getByText('export const state = "after";', {
          exact: true,
        }),
      ).toBeVisible({ timeout: 15_000 });

      const resizeHandle = testApp.window.getByLabel("Resize Session dock");
      const handleBox = await resizeHandle.boundingBox();
      const initialAsideBox = await changesAside.boundingBox();
      const viewportHeight = await testApp.window.evaluate(() => window.innerHeight);
      const visibleHandleBounds = await resizeHandle.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        let top = bounds.top;
        let bottom = bounds.bottom;

        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const overflowY = window.getComputedStyle(parent).overflowY;

          if (["auto", "clip", "hidden", "scroll"].includes(overflowY)) {
            const parentBounds = parent.getBoundingClientRect();

            top = Math.max(top, parentBounds.top);
            bottom = Math.min(bottom, parentBounds.bottom);
          }
        }

        return { bottom, top };
      });

      expect(handleBox).not.toBeNull();
      expect(initialAsideBox).not.toBeNull();
      expect(visibleHandleBounds.top).toBeLessThanOrEqual(1);
      expect(visibleHandleBounds.bottom).toBeGreaterThanOrEqual(viewportHeight - 1);
      await testApp.window.mouse.move(
        handleBox!.x + handleBox!.width / 2,
        handleBox!.y + handleBox!.height / 2,
      );
      await testApp.window.mouse.down();
      await testApp.window.mouse.move(
        handleBox!.x + handleBox!.width / 2 - 80,
        handleBox!.y + handleBox!.height / 2,
        { steps: 5 },
      );
      await testApp.window.mouse.up();
      await expect
        .poll(async () => (await changesAside.boundingBox())?.width ?? 0)
        .toBeGreaterThan(initialAsideBox!.width + 40);

      const chatBox = await testApp.window.getByTestId("live-session-column").boundingBox();
      const asideBox = await changesAside.boundingBox();

      expect(chatBox).not.toBeNull();
      expect(asideBox).not.toBeNull();
      expect(asideBox!.x).toBeGreaterThanOrEqual(chatBox!.x + chatBox!.width);

      // Dragging as far as the handle will go hands the panel everything Chat
      // does not need — Chat keeps its 400px minimum and no more.
      const handleAgain = (await testApp.window
        .getByRole("separator", { name: "Resize Session dock" })
        .boundingBox())!;

      await testApp.window.mouse.move(
        handleAgain.x + handleAgain.width / 2,
        handleAgain.y + handleAgain.height / 2,
      );
      await testApp.window.mouse.down();
      await testApp.window.mouse.move(0, handleAgain.y + handleAgain.height / 2, {
        steps: 10,
      });
      await testApp.window.mouse.up();

      const chatPane = testApp.window.getByTestId("session-workspace-main-pane");

      await expect
        .poll(async () => Math.round((await chatPane.boundingBox())?.width ?? 0))
        .toBeGreaterThanOrEqual(400);
    } finally {
      await testApp.close();
    }
  });
});

test.describe("M4: Model and Thinking controls", () => {
  test("switches a capability-driven model pair and restores it after backend restart", async () => {
    const testApp = await launchPace({ seedModelControls: true });

    try {
      await openSession(
        testApp.window,
        testApp.project!,
        testApp.projection!,
      );

      const trigger = testApp.window.getByTestId("model-thinking-trigger");

      await expect(trigger).toHaveText(/GPT-5\.5 · High/);
      await trigger.click();
      await testApp.window.getByText("GPT-4.1", { exact: true }).click();
      await expect(trigger).toHaveText(/GPT-4.1 · Off/);
      await expect
        .poll(async () => (await testApp.readProjection())?.modelSelection)
        .toEqual({
          provider: "openai",
          modelId: "gpt-4.1",
          thinkingLevel: "off",
        });

      await testApp.window.evaluate(() => {
        window.__paceE2EBackendLifecycle = [];
        window.pace!.onBackendEvent((event) => {
          if (event.event.sessionId !== "__backend__") {
            return;
          }

          window.__paceE2EBackendLifecycle!.push({
            generation: Number(event.event.payload.generation),
            lifecycle: String(event.event.payload.lifecycle),
          });
        });
      });
      const killedGeneration = await testApp.window.evaluate(() =>
        window.pace!.invoke<{ generation: number }>("__e2e_kill_backend"),
      );

      await expect
        .poll(
          () =>
            testApp.window.evaluate(
              () => window.__paceE2EBackendLifecycle ?? [],
            ),
          { timeout: 15_000 },
        )
        .toEqual([
          {
            generation: killedGeneration.generation,
            lifecycle: "disconnected",
          },
          {
            generation: killedGeneration.generation + 1,
            lifecycle: "connected",
          },
        ]);
      await expect(trigger).toHaveText(/GPT-4.1 · Off/);
    } finally {
      await testApp.close();
    }
  });
});
