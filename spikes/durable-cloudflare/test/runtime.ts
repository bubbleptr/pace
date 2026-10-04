import { resolve } from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare, type V4WorkerOptions } from "miniflare";

export async function startRuntime(
  entry: string,
  options: { persist?: string; serviceBindings?: V4WorkerOptions["serviceBindings"] } = {},
): Promise<Miniflare> {
  const bundle = await build({
    entryPoints: [resolve(entry)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers", "node:*"],
  });
  const config = convertV4MiniflareOptions({
    name: "durable-cloudflare-spike",
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { SESSIONS: { className: "SessionObject", useSQLite: true } },
    ...(options.serviceBindings ? { serviceBindings: options.serviceBindings } : {}),
    bindings: { SPIKE_TOKEN: "local-test-token" },
  });
  const mf = new Miniflare({ ...config, resourcePersistencePath: options.persist });
  try {
    await mf.ready;
    return mf;
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
