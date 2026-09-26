import { expect, test, type Page } from "@playwright/test";

async function openGallery(page: Page) {
  await page.goto("/#/design");
  await page.getByRole("button", { name: "Components", exact: true }).click();
  await page.getByRole("textbox", { name: "Search components" }).fill("AnimatedIcons");
}

test("navigation does not replay an icon under a stationary pointer", async ({ page }) => {
  await page.goto("/");
  const trajectory = page.getByRole("button", { name: "Trajectory", exact: true });
  await trajectory.waitFor();
  await page.evaluate(() => {
    document.documentElement.dataset.iconStarts = "0";
    document.addEventListener("animationstart", (event) => {
      if ((event.target as Element).closest('svg[data-icon-motion="history"]')) {
        document.documentElement.dataset.iconStarts = String(Number(document.documentElement.dataset.iconStarts) + 1);
      }
    });
  });
  await trajectory.hover();
  await trajectory.locator("svg").evaluate(async (svg) => {
    await Promise.all(svg.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  const starts = () => page.evaluate(() => Number(document.documentElement.dataset.iconStarts));
  const beforeClick = await starts();
  expect(beforeClick).toBeGreaterThan(0);

  // Keep the pointer still so the click cannot be mistaken for a fresh hover.
  await page.mouse.down();
  await page.mouse.up();
  await expect(page).toHaveURL(/\/trajectory$/);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await starts()).toBe(beforeClick);

  const box = (await trajectory.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await starts()).toBe(beforeClick);

  await page.mouse.move(0, 0);
  await trajectory.hover();
  await expect.poll(starts).toBeGreaterThan(beforeClick);
});

test("animated icons finish their hover gesture in the same time", async ({ page }) => {
  await openGallery(page);

  const controls = page.getByRole("button", { name: / animated$/ });
  await expect(controls.first()).toBeVisible();
  const durations: Record<string, number> = {};

  for (const control of await controls.all()) {
    await page.mouse.move(0, 0);
    await control.hover();
    const timing = await control.locator("svg").evaluate((svg) => {
      const animations = svg.getAnimations({ subtree: true });
      return Math.max(0, ...animations.map((animation) =>
        animation.effect!.getComputedTiming().endTime as number,
      ));
    });
    durations[(await control.getAttribute("aria-label"))!] = timing;
  }

  expect(Object.values(durations).every((duration) => duration > 0), JSON.stringify(durations)).toBe(true);
  expect(new Set(Object.values(durations)).size, JSON.stringify(durations)).toBe(1);
});

test("pressing an animated icon control does not shrink it", async ({ page }) => {
  await openGallery(page);

  for (const name of ["Models", "Models animated"]) {
    const control = page.getByRole("button", { name, exact: true });
    await control.hover();
    await page.mouse.down();
    const pressed = await control.evaluate(async (button) => {
      await Promise.all(button.getAnimations().map((animation) => animation.finished));
      const style = getComputedStyle(button);
      return { transform: style.transform, scale: style.scale };
    });
    await page.mouse.up();
    expect(pressed).toEqual({ transform: "none", scale: "none" });
  }
});

test("keyboard, disabled, static and reduced-motion icons stay still", async ({ page }) => {
  await openGallery(page);
  const models = page.getByRole("button", { name: "Models animated", exact: true });
  const animationCount = () => models.locator("svg").evaluate((svg) => svg.getAnimations({ subtree: true }).length);

  await models.focus();
  await page.keyboard.press("Enter");
  expect(await animationCount()).toBe(0);

  for (const state of ["disabled", "static"]) {
    const control = page.getByRole("button", { name: `Models ${state}`, exact: true });
    await control.hover();
    expect(await control.locator("svg").evaluate((svg) => svg.getAnimations({ subtree: true }).length)).toBe(0);
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await models.hover();
  expect(await animationCount()).toBe(0);
});

test("a touch tap does not start an icon gesture", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await openGallery(page);
  const control = page.getByRole("button", { name: "Models animated", exact: true });
  await control.tap();
  expect(await control.locator("svg").evaluate((svg) => svg.getAnimations({ subtree: true }).length)).toBe(0);
  await context.close();
});
