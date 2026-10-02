import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
// bun nests a second `react` under @astryxdesign/core; pin one copy, as Pace's
// renderer config does, or React 19 throws `reading 'use'` in Astryx hooks.
const requireFromSpike = createRequire(new URL("../package.json", import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      react: dirname(requireFromSpike.resolve("react/package.json")),
      "react-dom": dirname(requireFromSpike.resolve("react-dom/package.json")),
    },
  },
  server: { host: "127.0.0.1", port: 5199, strictPort: true },
});
