import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /changes\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    screenshot: "off",
    trace: "off",
  },
});
