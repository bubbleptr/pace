import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      "@pace/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@pace/backend": resolve(__dirname, "packages/backend/src/index.ts"),
      // Not in Pi's package exports map, so resolved by file path; the alias
      // pins the backend to the installed Pi version (contract-tested).
      "@pace/pi-mcp": resolve(
        __dirname,
        "packages/backend/node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp",
      ),
      "@": resolve(__dirname, "apps/desktop/src"),
      // Dev-only Durable multiview spike page; removed with spikes/durable-multiview.
      "@pace/durable-spike": resolve(__dirname, "spikes/durable-multiview"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    exclude: [
      ...configDefaults.exclude,
      "e2e/**",
      "**/out/**",
      "**/.claude/worktrees/**",
      // Playwright drive scripts, not Vitest suites.
      ".cursor/**",
      // Spikes run their own Node-environment suites.
      "spikes/**",
    ],
    pool: "forks",
    // @lobehub/icons ships extensionless directory imports that Node's ESM
    // resolver rejects; let Vite resolve them so pages using brand icons stay
    // unit-testable.
    server: { deps: { inline: [/@lobehub\//] } },
    setupFiles: ["./apps/desktop/src/test/setup.ts"],
  },
});
