import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type Extension, type HarnessSettings, type Registry } from "@earendil-works/pi-durable";
import type { OpenHostOptions } from "../host.ts";
import { ApprovalBoard } from "./approvals.ts";
import { AREAS, createOncall } from "./oncall.ts";
import { PlanDoc, RolloutDoc } from "./state.ts";
import { DemoTasks } from "./tasks.ts";

export interface DemoOptions {
  /** Delay between streamed lines of an investigation tool's output. */
  readonly paceMs?: number;
  /** Length of one rollback step in a region. */
  readonly stepMs?: number;
  /** The investigation tools' module; `reload()` imports it again. */
  readonly investigationModule?: string;
}

export interface Demo {
  readonly registry: Registry;
  readonly investigationModule: string;
  /** What `openHost` needs to run the demo: its registry, approvals, documents, and root setup. */
  readonly hostOptions: Pick<OpenHostOptions, "registry" | "approvals" | "docs" | "onOpen">;
  /** Reinstall the investigation tools from their module; returns the module's load count. */
  reload(): Promise<number>;
  /** `base` with a short verbatim tail, so a manual compaction of a demo-sized transcript has something to summarize. */
  settings(base?: HarnessSettings): HarnessSettings;
}

const defaultModule = fileURLToPath(new URL("./investigation.ts", import.meta.url));

export async function createDemo(options: DemoOptions = {}): Promise<Demo> {
  const { paceMs = 400, stepMs = 2000, investigationModule = defaultModule } = options;
  const registry = createRegistry();
  const approvals = new ApprovalBoard();
  let loads = 0;
  const load = async (): Promise<Extension> => {
    // A fresh URL is a fresh module instance; the registry replaces the extension of the same name in place.
    const module = (await import(`${pathToFileURL(investigationModule).href}?v=${++loads}`)) as typeof import("./investigation.ts");
    return module.createInvestigation({ paceMs });
  };
  registry.install(DemoTasks);
  registry.install(await load());
  registry.install(createOncall({ approvals, stepMs }));
  return {
    registry,
    investigationModule,
    hostOptions: {
      registry,
      approvals,
      docs: [PlanDoc, RolloutDoc],
      async onOpen(harness, root) {
        approvals.attach(harness);
        // The main agent delegates instead of investigating itself; tools are stored by name, so this survives reloads.
        const investigation = registry.snapshot().extension("investigation")!.tools ?? [];
        const own = investigation.filter((tool) => Object.values(AREAS).some((area) => area.tool === tool.name));
        await root.configure({ tools: { remove: own } }, BACKGROUND_CONTEXT);
      },
    },
    async reload() {
      registry.install(await load());
      return loads;
    },
    settings(base = {}) {
      // Descriptors, not a spread: pi's settings are getters that read the settings file at each use.
      return Object.defineProperties({}, {
        ...Object.getOwnPropertyDescriptors(base),
        compaction: { enumerable: true, get: () => ({ ...base.compaction, keepRecentTokens: 400 }) },
      });
    },
  };
}
