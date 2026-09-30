import { copyFile, mkdir } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";
import { relaxCspForDevServer } from "./vite-dev-csp";

// The @pace/* workspace packages are internal TS source, not external runtime
// deps — bundle them into the main/preload output so the utilityProcess can find
// the backend service. Node builtins stay externalized by the plugin default.
const internalPackages = ["@pace/core", "@pace/backend"];
const piPackageDirectory = realpathSync(
  resolve(
    __dirname,
    "../../packages/backend/node_modules/@earendil-works/pi-coding-agent",
  ),
);
const requireFromPi = createRequire(join(piPackageDirectory, "package.json"));
const piPackage = JSON.parse(readFileSync(join(piPackageDirectory, "package.json"), "utf8"));
const appPackage = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));
const photonWasmPath = requireFromPi.resolve(
  "@silvia-odwyer/photon-node/photon_rs_bg.wasm",
);

// Pi's config.js is the anchor for codemode's bundled runtime: the emitted
// codemode-worker.js and quickjs.wasm resolve relative to whichever chunk ends
// up containing it, so both the transform and the guard below key off its id.
const piConfigModuleId = realpathSync(join(piPackageDirectory, "dist/config.js"));
const piCodemodeWorkerEntry = join(
  piPackageDirectory,
  "dist/extensions/codemode/worker.js",
);
// quickjs-wasi is a dependency of pi-codemode, not pi-coding-agent, so resolve
// the wasm through pi-codemode's own package the way its imports do: pi's deps
// sit beside it in the same scope directory (bun isolated install), which is
// also where Node's upward node_modules walk finds it.
const piCodemodeDirectory = realpathSync(
  join(dirname(piPackageDirectory), "pi-codemode"),
);
const quickJsWasmPath = createRequire(
  join(piCodemodeDirectory, "package.json"),
).resolve("quickjs-wasi/quickjs.wasm");

function copyMainRuntimeAssets(): Plugin {
  return {
    name: "pigui-copy-main-runtime-assets",
    async writeBundle(options) {
      if (!options.dir) {
        throw new Error("Main build output directory is required.");
      }

      // The bundled Photon chunk resolves its WASM beside the emitted chunk.
      const outputPath = resolve(options.dir, "chunks/photon_rs_bg.wasm");

      await mkdir(dirname(outputPath), { recursive: true });
      await copyFile(photonWasmPath, outputPath);
      // Codemode's QuickJS runtime is looked up beside the chunk that contains
      // pi's dist/config.js (see rewritePiQuickJsWasmResolution).
      await copyFile(
        quickJsWasmPath,
        resolve(options.dir, "chunks/quickjs.wasm"),
      );
      // Pi resolves built-in themes through its public package asset directory.
      const themes = "dist/modes/interactive/theme";
      const themeDirectory = resolve(options.dir, "pi-assets", themes);
      await mkdir(themeDirectory, { recursive: true });
      for (const name of ["dark.json", "light.json"]) {
        await copyFile(join(piPackageDirectory, themes, name), join(themeDirectory, name));
      }
    },
  };
}

// electron-vite's `vite:esm-shim` finds "the last static import" of a chunk
// with a regex that also matches import-like text inside string literals. Pi
// 0.86 loads jiti lazily, so jiti + Babel become their own chunk whose last
// such match is an error-message string ("Directory import '%s' ..."); the
// shim gets spliced into the middle of that string and esbuild rejects the
// chunk. Hoisting the identical shim to the top of every chunk that needs one
// is always valid ESM and makes `vite:esm-shim` skip the chunk (it checks
// `code.includes(shim)` first). Keep the text byte-identical to electron-vite's
// `CJSShim_node_20_11`; a drift shows up as a duplicate-declaration build error.
const cjsSyntaxPattern = /__filename|__dirname|require\(|require\.resolve\(/;
const cjsShim = `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`;

// Pi's dist/config.js resolves the codemode QuickJS wasm through createRequire,
// which cannot work in the packaged app: electron-builder ships no node_modules.
// Point it at the copy emitted beside the chunk instead. The replacement must
// match exactly once so a Pi upgrade that rewrites this lookup fails the build
// loudly instead of silently breaking codemode.
const QUICKJS_WASM_REQUIRE =
  'createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")';

function rewritePiQuickJsWasmResolution(): Plugin {
  return {
    name: "pigui-pi-quickjs-wasm-path",
    apply: "build",
    transform(code, id) {
      if (id !== piConfigModuleId) {
        return null;
      }
      const occurrences = code.split(QUICKJS_WASM_REQUIRE).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `Expected exactly one "${QUICKJS_WASM_REQUIRE}" in ${id}, found ${occurrences}.`,
        );
      }
      return {
        code:
          'import { fileURLToPath as __paceFileURLToPath } from "node:url";\n' +
          code.replace(
            QUICKJS_WASM_REQUIRE,
            '__paceFileURLToPath(new URL("./quickjs.wasm", import.meta.url))',
          ),
        map: null,
      };
    },
  };
}

// getCodemodeWorkerUrl() and the wasm lookup above both resolve relative to the
// emitted chunk that contains pi's dist/config.js. If chunk splitting ever moves
// it out of chunks/, both files land in the wrong place — fail the build.
function assertPiConfigChunkLocation(): Plugin {
  return {
    name: "pigui-pi-config-chunk-location",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunk = Object.values(bundle).find(
        (output) =>
          output.type === "chunk" && output.moduleIds.includes(piConfigModuleId),
      );
      if (!chunk) {
        throw new Error("No emitted main chunk contains pi's dist/config.js.");
      }
      if (!chunk.fileName.startsWith("chunks/")) {
        throw new Error(
          `Pi's dist/config.js must stay under chunks/ (emitted as ${chunk.fileName}); ` +
            "codemode-worker.js and quickjs.wasm resolve relative to it.",
        );
      }
    },
  };
}

function hoistCommonJsShim(): Plugin {
  return {
    name: "pigui-hoist-cjs-shim",
    apply: "build",
    renderChunk(code, _chunk, { format }) {
      if (format !== "es" || code.includes(cjsShim) || !cjsSyntaxPattern.test(code)) {
        return null;
      }
      return { code: cjsShim + code, map: null };
    },
  };
}

const mainBuild = {
  rollupOptions: {
    input: {
      main: resolve(__dirname, "electron/main.ts"),
      backend: resolve(__dirname, "electron/backend.ts"),
      "session-worker": resolve(__dirname, "electron/session-worker.ts"),
      // Pi's bundled codemode entry; getCodemodeWorkerUrl() resolves
      // ./codemode-worker.js beside the chunk containing dist/config.js.
      "chunks/codemode-worker": piCodemodeWorkerEntry,
    },
    output: {
      entryFileNames: "[name].js",
    },
  },
};

const preloadBuild = {
  rollupOptions: {
    // Two entries that must stay self-contained: a sandboxed preload's
    // `require` cannot resolve a relative chunk, so neither may import a module
    // the other does (PRD S2 constraint 6). They share types only.
    input: {
      preload: resolve(__dirname, "electron/preload.ts"),
      "browser-annotation-preload": resolve(
        __dirname,
        "electron/browser-annotation-preload.ts",
      ),
    },
    output: {
      entryFileNames: "[name].js",
      format: "cjs",
    },
  },
};

const rendererBuild = {
  rollupOptions: {
    input: resolve(__dirname, "index.html"),
  },
};

const coreAlias = {
  "@pace/core": resolve(__dirname, "../../packages/core/src/index.ts"),
  "@pace/backend": resolve(__dirname, "../../packages/backend/src/index.ts"),
  // Not in Pi's package exports map, so bundled by file path like the codemode
  // worker entry above; the alias pins the backend to the installed Pi version.
  "@pace/pi-mcp": join(piPackageDirectory, "dist/extensions/mcp"),
  "@": resolve(__dirname, "src"),
};

// bun nests a second `react` under @astryxdesign/core. Without pinning, Vite
// prebundles Astryx CodeBlock's `useTranslator` against that copy while the
// renderer uses the workspace copy — React 19 throws `reading 'use'`.
const requireFromRepo = createRequire(resolve(__dirname, "../../package.json"));
const reactPackage = dirname(requireFromRepo.resolve("react/package.json"));
const reactDomPackage = dirname(requireFromRepo.resolve("react-dom/package.json"));
const rendererReactAlias = {
  ...coreAlias,
  react: reactPackage,
  "react-dom": reactDomPackage,
};

export default defineConfig({
  main: {
    // Use Pi's embedded peer modules; dist aliases point at files that do not
    // exist after electron-vite bundles the SDK into the backend.
    define: {
      PI_BUNDLED_NODE: "true",
      __PACE_APP_VERSION__: JSON.stringify(appPackage.version),
      __PACE_PI_VERSION__: JSON.stringify(piPackage.version),
    },
    plugins: [
      externalizeDepsPlugin({ exclude: [...internalPackages, "electron-updater"] }),
      copyMainRuntimeAssets(),
      rewritePiQuickJsWasmResolution(),
      assertPiConfigChunkLocation(),
      hoistCommonJsShim(),
    ],
    build: mainBuild as any,
    resolve: { alias: coreAlias },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: internalPackages })],
    build: preloadBuild as any,
    resolve: { alias: coreAlias },
  },
  renderer: {
    root: ".",
    plugins: [react(), tailwindcss(), relaxCspForDevServer()],
    clearScreen: false,
    build: rendererBuild as any,
    resolve: {
      alias: rendererReactAlias,
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "react-dom/client",
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 1420,
      strictPort: true,
    },
  },
});
