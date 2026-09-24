import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);
const repositoryRoot = path.resolve(currentDirectory, "..", "..");
const projectRegistryStorageKey = "pigui.projectRegistry.v1";
const execFileAsync = promisify(execFile);
const packagedExecutable = process.env.PACE_E2E_EXECUTABLE;
/**
 * Extra Electron switches, space separated. Needed on Linux to run under Xvfb:
 * `ELECTRON_OZONE_PLATFORM_HINT` is ignored, only `--ozone-platform=x11` works,
 * and a tiling Wayland compositor otherwise overrides every setSize() call.
 */
const extraElectronArgs = (process.env.PACE_E2E_ELECTRON_ARGS ?? "")
  .split(" ")
  .filter(Boolean);

export type E2EProject = {
  id: string;
  path: string;
  displayName: string;
  addedAt: string;
};

export type E2ESessionProjection = {
  sessionId: string;
  runtimeId: string;
  piSessionId: string;
  projectId: string;
  initialPrompt: string;
  cwd: string;
  status: "completed" | "archived";
  sessionFile?: string;
  sessionFileMissing?: true;
  modelSelection?: {
    provider: string;
    modelId: string;
    thinkingLevel: "off" | "low" | "medium" | "high";
  };
  archivedAt?: string;
  updatedAt: string;
  checkout: {
    mode: "foreground-local";
    root: string;
    repoRoot: string;
    projectRoot: string;
    projectRelativePath: ".";
    executionCheckoutRoot: string;
    diffRoot: string;
    runtimeCwd: string;
    sessionBound: false;
    disposable: false;
    cleanupCandidate: false;
    permanent: true;
  };
};

export type PaceTestApplication = {
  app: ElectronApplication;
  window: Page;
  project: E2EProject | null;
  projection: E2ESessionProjection | null;
  readProjection(): Promise<E2ESessionProjection | null>;
  resizeWindow(width: number, height: number): Promise<void>;
  /**
   * Overwrites a projection file under the running backend, which may still
   * re-save its cached copy over it. Seed with `projections` when the spec
   * does not need the backend alive at write time.
   */
  writeProjection(projection: E2ESessionProjection): Promise<void>;
  close(): Promise<void>;
};

type LaunchPaceOptions = {
  seedProject?: boolean;
  seedSession?: boolean;
  seedGitChanges?: boolean;
  seedModelControls?: boolean;
  /**
   * When true, leave preflight incomplete so the first-run gate is shown.
   * Default false: write a completed preflight status so existing E2E stays on main UI.
   */
  requirePreflight?: boolean;
  seedPreflightAuth?: boolean;
  /** E2E-only: force optional Git check to report missing (must not block Continue). */
  forceGitMissing?: boolean;
  /** Prove the bundled engine does not depend on any executable on PATH. */
  emptyPath?: boolean;
  environment?: Record<string, string>;
  agentFiles?: Record<string, string>;
  /**
   * Replaces the seeded Session Projection with these records before the app
   * starts. The backend owns the projection files once it runs (its first
   * list heals and re-saves them from its cache), so records a spec needs up
   * front must land here rather than through `writeProjection`.
   */
  projections?: (
    seeded: E2ESessionProjection,
    testRoot: string,
  ) => E2ESessionProjection[];
};

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, LC_ALL: "C" },
  });
}

async function seedChangedGitRepository(projectDirectory: string) {
  const sourceDirectory = path.join(projectDirectory, "src");
  await mkdir(sourceDirectory, { recursive: true });
  await git(projectDirectory, "init");
  await git(projectDirectory, "config", "user.name", "Pace E2E");
  await git(projectDirectory, "config", "user.email", "pigui-e2e@example.test");
  await writeFile(
    path.join(sourceDirectory, "app.ts"),
    'export const state = "before";\n',
    "utf8",
  );
  await git(projectDirectory, "add", ".");
  await git(projectDirectory, "commit", "-m", "E2E baseline");
  await writeFile(
    path.join(sourceDirectory, "app.ts"),
    'export const state = "after";\n',
    "utf8",
  );
  await writeFile(
    path.join(sourceDirectory, "new-feature.ts"),
    "export const enabled = true;\n",
    "utf8",
  );
}

function stringEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function projectionFilePath(dataDirectory: string, sessionId: string) {
  return path.join(
    dataDirectory,
    "projections",
    `${encodeURIComponent(sessionId)}.json`,
  );
}

async function writeJson(pathname: string, value: unknown) {
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function seedPiRuntimeFixture(input: {
  agentDirectory: string;
  projectDirectory: string;
  sessionFile: string;
}) {
  await mkdir(path.dirname(input.sessionFile), { recursive: true });
  await Promise.all([
    writeJson(path.join(input.agentDirectory, "auth.json"), {
      openai: { type: "api_key", key: "pace-e2e-placeholder" },
    }),
    writeFile(
      input.sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "e2e-pi-session",
        timestamp: "2026-07-19T00:00:00.000Z",
        cwd: input.projectDirectory,
      })}\n`,
      "utf8",
    ),
  ]);
}

export async function launchPace(
  options: LaunchPaceOptions = {},
): Promise<PaceTestApplication> {
  const testRoot = await mkdtemp(path.join(tmpdir(), "pace-e2e-"));
  const profileDirectory = path.join(testRoot, "profile");
  const dataDirectory = path.join(testRoot, "data");
  const agentDirectory = path.join(testRoot, "agent");
  const projectDirectory = path.join(testRoot, "project");
  const piSessionFile = path.join(
    agentDirectory,
    "sessions",
    "e2e-pi-session.jsonl",
  );
  const shouldSeedProject =
    options.seedProject ||
    options.seedSession ||
    options.seedGitChanges ||
    options.seedModelControls;
  const project: E2EProject | null = shouldSeedProject
    ? {
        id: projectDirectory,
        path: projectDirectory,
        displayName: "E2E Project",
        addedAt: "2026-07-19T00:00:00.000Z",
      }
    : null;
  const projection: E2ESessionProjection | null =
    (options.seedSession || options.seedGitChanges || options.seedModelControls) &&
    project
    ? {
        sessionId: "e2e-session",
        runtimeId: "e2e-runtime",
        piSessionId: "e2e-pi-session",
        projectId: project.id,
        initialPrompt: options.seedModelControls
          ? "E2E model controls session"
          : "E2E lifecycle session",
        cwd: project.path,
        status: "completed",
        ...(options.seedModelControls
          ? {
              sessionFile: piSessionFile,
              modelSelection: {
                provider: "openai",
                modelId: "gpt-5.5",
                thinkingLevel: "high" as const,
              },
            }
          : { sessionFileMissing: true as const }),
        checkout: {
          mode: "foreground-local",
          root: project.path,
          repoRoot: project.path,
          projectRoot: project.path,
          projectRelativePath: ".",
          executionCheckoutRoot: project.path,
          diffRoot: project.path,
          runtimeCwd: project.path,
          sessionBound: false,
          disposable: false,
          cleanupCandidate: false,
          permanent: true,
        },
        updatedAt: "2026-07-19T00:01:00.000Z",
      }
    : null;

  await Promise.all([
    mkdir(profileDirectory, { recursive: true }),
    mkdir(dataDirectory, { recursive: true }),
    mkdir(agentDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
  ]);

  if (options.seedGitChanges) {
    await seedChangedGitRepository(projectDirectory);
  }

  if (options.seedModelControls) {
    await seedPiRuntimeFixture({
      agentDirectory,
      projectDirectory,
      sessionFile: piSessionFile,
    });
  }

  if (options.seedPreflightAuth || options.seedModelControls) {
    await writeJson(path.join(agentDirectory, "auth.json"), {
      openai: { type: "api_key", key: "pace-e2e-placeholder" },
    });
  }

  if (!options.requirePreflight) {
    await writeJson(path.join(dataDirectory, "preflight-status.json"), {
      completedAt: "2026-07-25T00:00:00.000Z",
    });
  }

  const seededProjections = projection
    ? options.projections?.(projection, testRoot) ?? [projection]
    : [];

  for (const record of seededProjections) {
    await writeJson(projectionFilePath(dataDirectory, record.sessionId), record);
  }

  for (const [relative, contents] of Object.entries(options.agentFiles ?? {})) {
    const filename = path.join(agentDirectory, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
  }
  await mkdir(path.join(testRoot, "tmp"), { recursive: true });
  const app = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: [
      ...(packagedExecutable
        ? []
        : [path.join(repositoryRoot, "apps/desktop/out/main/main.js")]),
      `--user-data-dir=${profileDirectory}`,
      ...extraElectronArgs,
    ],
    env: {
      ...stringEnvironment(),
      PACE_DATA_DIR: dataDirectory,
      PACE_E2E: "1",
      PI_CODING_AGENT_DIR: agentDirectory,
      HOME: testRoot,
      TMPDIR: path.join(testRoot, "tmp"),
      ...(options.emptyPath ? { PATH: "" } : {}),
      ...(options.forceGitMissing ? { PACE_E2E_FORCE_GIT_MISSING: "1" } : {}),
      ...options.environment,
    },
  });
  const window = await app.firstWindow();

  await window.waitForLoadState("domcontentloaded");

  if (project) {
    await window.evaluate(
      ({ key, value }) => {
        window.localStorage.setItem(key, JSON.stringify([value]));
      },
      { key: projectRegistryStorageKey, value: project },
    );
    await window.reload({ waitUntil: "domcontentloaded" });
  }

  let closed = false;

  return {
    app,
    window,
    project,
    projection:
      seededProjections.find((record) => record.sessionId === projection?.sessionId) ??
      projection,
    async readProjection() {
      if (!projection) {
        return null;
      }

      return JSON.parse(
        await readFile(
          projectionFilePath(dataDirectory, projection.sessionId),
          "utf8",
        ),
      ) as E2ESessionProjection;
    },
    async resizeWindow(width, height) {
      await app.evaluate(
        ({ BrowserWindow }, dimensions) => {
          BrowserWindow.getAllWindows()[0]?.setSize(
            dimensions.width,
            dimensions.height,
          );
        },
        { width, height },
      );
      await window.waitForFunction(
        (dimensions) =>
          window.innerWidth >= dimensions.width - 32 &&
          window.innerHeight >= dimensions.height - 64,
        { width, height },
      );
    },
    async writeProjection(nextProjection) {
      await writeJson(
        projectionFilePath(dataDirectory, nextProjection.sessionId),
        nextProjection,
      );
    },
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      await app.close().catch(() => undefined);
      await rm(testRoot, { recursive: true, force: true });
    },
  };
}

export async function assertNoFixtureData(window: Page): Promise<void> {
  const fixtureStrings = [
    "Usage evidence review",
    "Agent Workspace shell",
    "Archived checkout snapshot",
    "Trace boundary pass",
    "dev fixture:",
  ];
  const bodyText = await window.locator("body").innerText();

  for (const needle of fixtureStrings) {
    if (bodyText.includes(needle)) {
      throw new Error(`Fixture data leak detected: found "${needle}" in page`);
    }
  }
}
