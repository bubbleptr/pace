import type { ProjectRegistryEntry } from "@/entities/project/project-registry";
import type { SessionDraft } from "@/entities/session/session-drafts";
import { isElectronRuntime } from "@/shared/runtime";

declare global {
  interface Window {
    __PACE_ENABLE_BROWSER_DEVELOPMENT_MOCKS__?: boolean;
  }
}

type BrowserDevelopmentImportMeta = ImportMeta & {
  env?: {
    DEV?: boolean;
    MODE?: string;
    VITEST?: boolean;
  };
};

export const browserDevelopmentProjectId = "/Users/void/code/opensource/Pig";

const browserDevelopmentProject: ProjectRegistryEntry = {
  id: browserDevelopmentProjectId,
  path: browserDevelopmentProjectId,
  displayName: "Pig",
  addedAt: "2026-06-30T08:00:00.000Z",
};

function isVitestRuntime() {
  const env = (import.meta as BrowserDevelopmentImportMeta).env;

  return env?.MODE === "test" || Boolean(env?.VITEST);
}

export function shouldUseBrowserDevelopmentData() {
  if (typeof window === "undefined" || isElectronRuntime()) {
    return false;
  }

  if (window.__PACE_ENABLE_BROWSER_DEVELOPMENT_MOCKS__ === true) {
    return true;
  }

  return (
    Boolean((import.meta as BrowserDevelopmentImportMeta).env?.DEV) &&
    !isVitestRuntime()
  );
}

export function getBrowserDevelopmentProjectRegistry(): ProjectRegistryEntry[] {
  return [browserDevelopmentProject];
}

export function getProjectRegistryWithBrowserDevelopmentFallback(
  projects: ProjectRegistryEntry[],
) {
  if (projects.length > 0 || !shouldUseBrowserDevelopmentData()) {
    return projects;
  }

  return getBrowserDevelopmentProjectRegistry();
}

export function getBrowserDevelopmentSessionDraft(
  projectIds: string[],
): SessionDraft | null {
  if (!shouldUseBrowserDevelopmentData()) {
    return null;
  }

  const projectId = projectIds[0] ?? null;

  if (!projectId) {
    return null;
  }

  return {
    projectId,
    prompt: "",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}
