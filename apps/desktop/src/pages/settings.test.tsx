import { act, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog, resetCatalogRefreshGate, startCatalogRefresh } from "@/pages/settings";
import { AppFrame } from "@/app/app-shell";
import {
  getVisibleModels,
  saveVisibleModels,
} from "@/entities/model/visible-models";
import { resetUpdateStatusStore } from "@/entities/update/use-update-status";
import type { PaceRendererApi } from "@/shared/runtime";
import type { UpdateStatus } from "@/shared/update-protocol";
import type { ModelCatalogRefreshResult, ProviderConnectionTestResult } from "@pace/core";

const providerAuthStatus = {
  agentDir: "/agent",
  authPath: "/agent/auth.json",
  configuredCount: 1,
  providers: [
    {
      id: "anthropic",
      label: "Anthropic",
      supportsApiKey: true,
      supportsOAuth: true,
      mode: "api_key",
      configured: true,
      keyHint: "…dev1",
    },
    {
      id: "xai",
      label: "Grok (xAI)",
      supportsApiKey: true,
      supportsOAuth: true,
      mode: "none",
      configured: false,
    },
    {
      // Label does not contain the id, so an id query cannot pass via label.
      id: "github-copilot",
      label: "GitHub Copilot",
      supportsApiKey: true,
      supportsOAuth: true,
      mode: "none",
      configured: false,
    },
  ],
};

const modelControls = {
  models: [
    {
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      thinkingLevels: ["off", "high"],
    },
    {
      provider: "xai",
      modelId: "grok-4",
      name: "Grok 4",
      thinkingLevels: ["off", "high"],
    },
    {
      provider: "xai",
      modelId: "grok-4-fast",
      name: "Grok 4 Fast",
      thinkingLevels: ["off", "high"],
    },
    // Catalog providers are a superset of the auth providers.
    {
      provider: "moonshot",
      modelId: "kimi-k3",
      name: "Kimi K3",
      thinkingLevels: ["off"],
    },
  ],
  selected: {
    provider: "xai",
    modelId: "grok-4",
    thinkingLevel: "high",
  },
};

const disabledUpdateStatus: UpdateStatus = {
  state: "disabled",
  currentVersion: "0.0.1",
  reason: "Updates are only available in the packaged desktop app.",
};

const defaultCatalogRefreshedAt = "2026-09-22T15:04:00.000Z";

type CatalogRefreshFixture =
  | { offline: true }
  | {
      refreshedAt?: string;
      errors?: Record<string, string>;
      models?: typeof modelControls.models;
    };

const defaultConnectionTestResult: ProviderConnectionTestResult = {
  ok: true,
  modelId: "claude-sonnet-4",
  latencyMs: 42,
};

type RenderSettingsOptions = {
  connectionTestResult?: ProviderConnectionTestResult;
  authStatus?: typeof providerAuthStatus;
  probe?: () => Promise<ProviderConnectionTestResult>;
  catalogRefresh?: CatalogRefreshFixture;
  catalogRefreshImpl?: (args?: Record<string, unknown>) => Promise<ModelCatalogRefreshResult>;
  strict?: boolean;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderSettings(
  path = "/usage?settings=models",
  updateStatus: UpdateStatus = disabledUpdateStatus,
  options: RenderSettingsOptions = {},
) {
  const connectionTestResult = options.connectionTestResult ?? defaultConnectionTestResult;
  const catalogRefresh = options.catalogRefresh ?? {
    refreshedAt: defaultCatalogRefreshedAt,
    errors: {},
  };
  const updateListeners = new Set<(status: UpdateStatus) => void>();
  let models = modelControls.models;
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "test_provider_connection") {
      return options.probe ? options.probe() : connectionTestResult;
    }

    if (
      command === "list_provider_auth_status" ||
      command === "set_provider_api_key"
    ) {
      return options.authStatus ?? providerAuthStatus;
    }

    if (command === "list_available_model_controls") {
      return { ...modelControls, models };
    }

    if (command === "refresh_model_catalog") {
      if (options.catalogRefreshImpl) {
        return options.catalogRefreshImpl(args);
      }

      if ("offline" in catalogRefresh) {
        return { offline: true };
      }

      if (args?.force === true) {
        if (catalogRefresh.models) models = catalogRefresh.models;
        return {
          refreshedAt: catalogRefresh.refreshedAt ?? defaultCatalogRefreshedAt,
          errors: catalogRefresh.errors ?? {},
        };
      }

      return {
        refreshedAt: catalogRefresh.refreshedAt ?? defaultCatalogRefreshedAt,
        errors: {},
      };
    }

    if (command === "get_chat_workspace_root") {
      return { path: "/tmp/pigui-dev/chats" };
    }

    if (command === "get_runtime_info") {
      return { appVersion: "0.0.1", piVersion: "0.86.0", mode: "SDK" };
    }

    if (command === "reveal_project_in_finder") {
      return undefined;
    }

    if (
      command === "update:status" ||
      command === "update:check" ||
      command === "update:install"
    ) {
      return updateStatus;
    }

    throw new Error(`unexpected backend command ${command}`);
  });

  window.pace = {
    invoke: invoke as unknown as PaceRendererApi["invoke"],
    onBackendEvent: vi.fn(() => vi.fn()),
    onBrowserEvent: vi.fn(() => vi.fn()),
    onUpdateEvent: vi.fn((listener) => {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    }),
    onWindowFocusChanged: vi.fn(() => vi.fn()),
    onNavigateRequest: vi.fn(() => vi.fn()),
  };

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <AppFrame>
          <textarea aria-label="Session draft" defaultValue="Keep my draft" />
        </AppFrame>
        <SettingsDialog />
      </>
    ),
  });
  const usageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/usage",
    component: () => null,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: rootRoute.addChildren([usageRoute]),
  });

  const tree = (
    <QueryClientProvider client={new QueryClient()}>
      {options.strict ? (
        <StrictMode>
          <RouterProvider router={router} />
        </StrictMode>
      ) : (
        <RouterProvider router={router} />
      )}
    </QueryClientProvider>
  );

  return {
    ...render(tree),
    router,
    emitUpdate: (status: UpdateStatus) => {
      act(() => {
        for (const listener of updateListeners) listener(status);
      });
    },
    countCalls: (command: string) =>
      invoke.mock.calls.filter(([called]) => called === command).length,
  };
}

async function findModelsSection() {
  return screen.findByRole("region", { name: "Models" });
}

beforeEach(() => {
  resetUpdateStatusStore();
  resetCatalogRefreshGate();
});

describe("Settings — visible models", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("lists the available models grouped by provider, all visible by default", async () => {
    renderSettings();

    const section = await findModelsSection();
    const groups = await within(section).findAllByRole("group");

    expect(groups).toHaveLength(3);
    expect(
      within(section).getByRole("group", { name: "Anthropic models" }),
    ).toBe(groups[0]);
    expect(
      within(section).getByRole("group", { name: "Grok (xAI) models" }),
    ).toBe(groups[1]);
    // A catalog provider without an auth entry falls back to its raw id.
    expect(
      within(section).getByRole("group", { name: "moonshot models" }),
    ).toBe(groups[2]);
    for (const name of [
      "Claude Sonnet 4",
      "Grok 4",
      "Grok 4 Fast",
      "Kimi K3",
    ]) {
      expect(within(section).getByRole("checkbox", { name })).toBeChecked();
    }
  });

  it("persists the models left visible after unchecking one", async () => {
    const user = userEvent.setup();

    renderSettings();

    const section = await findModelsSection();

    await user.click(
      await within(section).findByRole("checkbox", { name: "Grok 4 Fast" }),
    );

    await waitFor(() => {
      expect(getVisibleModels()).toEqual([
        { provider: "anthropic", modelId: "claude-sonnet-4" },
        { provider: "moonshot", modelId: "kimi-k3" },
        { provider: "xai", modelId: "grok-4" },
      ]);
    });
    expect(
      within(section).getByRole("checkbox", { name: "Grok 4 Fast" }),
    ).not.toBeChecked();
  });

  it("drops stored models that have left the catalog when the set changes", async () => {
    const user = userEvent.setup();

    saveVisibleModels([
      { provider: "xai", modelId: "grok-4" },
      { provider: "xai", modelId: "retired-model" },
    ]);
    renderSettings();

    const section = await findModelsSection();

    await user.click(
      await within(section).findByRole("checkbox", { name: "Claude Sonnet 4" }),
    );

    await waitFor(() => {
      expect(getVisibleModels()).toEqual([
        { provider: "xai", modelId: "grok-4" },
        { provider: "anthropic", modelId: "claude-sonnet-4" },
      ]);
    });
  });

  it("clears and restores every model of one provider from its Select all row", async () => {
    const user = userEvent.setup();

    renderSettings();

    const section = await findModelsSection();
    const group = within(section).getByRole("group", { name: "Grok (xAI) models" });
    const selectAll = () => within(group).getByRole("checkbox", { name: "Select all" });

    expect(selectAll()).toBeChecked();

    await user.click(selectAll());

    await waitFor(() => {
      expect(getVisibleModels()).toEqual([
        { provider: "anthropic", modelId: "claude-sonnet-4" },
        { provider: "moonshot", modelId: "kimi-k3" },
      ]);
    });
    expect(within(group).getByRole("checkbox", { name: "Grok 4" })).not.toBeChecked();
    expect(within(group).getByRole("checkbox", { name: "Grok 4 Fast" })).not.toBeChecked();
    expect(selectAll()).not.toBeChecked();

    // A partial selection shows as indeterminate, never as "all checked".
    await user.click(within(group).getByRole("checkbox", { name: "Grok 4" }));
    await waitFor(() => {
      expect(selectAll()).toBePartiallyChecked();
    });

    await user.click(selectAll());

    await waitFor(() => {
      expect(getVisibleModels()).toEqual([
        { provider: "anthropic", modelId: "claude-sonnet-4" },
        { provider: "moonshot", modelId: "kimi-k3" },
        { provider: "xai", modelId: "grok-4" },
        { provider: "xai", modelId: "grok-4-fast" },
      ]);
    });
    expect(selectAll()).toBeChecked();
  });

  it("refetches the model catalog after provider credentials change", async () => {
    const user = userEvent.setup();
    const { countCalls } = renderSettings();

    const section = await findModelsSection();
    await waitFor(() => {
      expect(section.querySelector("time")).toBeTruthy();
      expect(countCalls("list_available_model_controls")).toBeGreaterThanOrEqual(2);
    });
    const listsAfterOpen = countCalls("list_available_model_controls");

    await user.click(screen.getByRole("button", { name: "Providers" }));
    await user.click(screen.getByRole("button", { name: "API Key" }));

    const card = await screen.findByTestId("provider-api-key-anthropic");

    await user.type(
      within(card).getByPlaceholderText("Paste API key"),
      "sk-test",
    );
    await user.click(within(card).getByRole("button", { name: "Replace key" }));

    await waitFor(() => {
      expect(countCalls("list_available_model_controls")).toBe(listsAfterOpen + 1);
    });
  });

  it("refreshes the catalog on opening Models and shows the force refresh result", async () => {
    const user = userEvent.setup();
    const refreshedAt = "2026-09-22T15:04:00.000Z";
    renderSettings("/usage?settings=models", disabledUpdateStatus, {
      catalogRefresh: {
        refreshedAt,
        errors: { xai: "catalog unavailable" },
        models: [
          ...modelControls.models,
          {
            provider: "xai",
            modelId: "grok-4.7",
            name: "Grok 4.7",
            thinkingLevels: ["off", "high"],
          },
        ],
      },
    });

    const section = await findModelsSection();

    await waitFor(() => {
      expect(section.querySelector("time")).toHaveAttribute("datetime", refreshedAt);
    });
    expect(window.pace!.invoke).toHaveBeenCalledWith("refresh_model_catalog", {
      force: false,
    });
    expect(within(section).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Refresh models" })).toBeEnabled();
    expect(within(section).getByText(/Last refreshed/)).toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "Refresh models" }));

    expect(
      await within(section).findByRole("checkbox", { name: "Grok 4.7" }),
    ).toBeInTheDocument();
    expect(within(section).getByRole("checkbox", { name: "Grok 4" })).toBeInTheDocument();
    expect(within(section).getByRole("alert")).toHaveTextContent("Grok (xAI)");
    expect(within(section).getByRole("alert")).toHaveTextContent("catalog unavailable");
    expect(window.pace!.invoke).toHaveBeenCalledWith("refresh_model_catalog", {
      force: true,
    });
  });

  it("does not refresh the catalog until the Models section is open", async () => {
    const user = userEvent.setup();
    const { countCalls } = renderSettings("/usage?settings=providers");

    await screen.findByRole("region", { name: "Providers" });
    expect(countCalls("refresh_model_catalog")).toBe(0);

    await user.click(screen.getByRole("button", { name: "Models" }));

    await waitFor(() => {
      expect(countCalls("refresh_model_catalog")).toBe(1);
    });
    expect(window.pace!.invoke).toHaveBeenCalledWith("refresh_model_catalog", {
      force: false,
    });

    await user.click(screen.getByRole("button", { name: "Providers" }));
    await user.click(screen.getByRole("button", { name: "Models" }));

    await waitFor(() => {
      expect(countCalls("refresh_model_catalog")).toBe(2);
    });
  });

  it("reuses the in-flight refresh when Models is left and reopened", async () => {
    const user = userEvent.setup();
    const pending = deferred<ModelCatalogRefreshResult>();
    const { countCalls } = renderSettings("/usage?settings=models", disabledUpdateStatus, {
      catalogRefreshImpl: () => pending.promise,
    });
    const section = await findModelsSection();
    const refreshButton = () => within(section).getByRole("button", { name: "Refresh models" });

    await waitFor(() => expect(refreshButton()).toBeDisabled());
    expect(countCalls("refresh_model_catalog")).toBe(1);
    expect(window.pace!.invoke).toHaveBeenCalledWith("refresh_model_catalog", { force: false });

    await user.click(screen.getByRole("button", { name: "Providers" }));
    await user.click(screen.getByRole("button", { name: "Models" }));

    expect(countCalls("refresh_model_catalog")).toBe(1);
    expect(refreshButton()).toBeDisabled();

    pending.resolve({ refreshedAt: defaultCatalogRefreshedAt, errors: {} });
    await waitFor(() => expect(refreshButton()).toBeEnabled());
  });

  it("keeps Refresh models disabled when a later refresh settles before an earlier one", async () => {
    const first = deferred<ModelCatalogRefreshResult>();
    const second = deferred<ModelCatalogRefreshResult>();
    renderSettings("/usage?settings=models", disabledUpdateStatus, {
      catalogRefreshImpl: () => first.promise,
    });
    const section = await findModelsSection();
    const refreshButton = () => within(section).getByRole("button", { name: "Refresh models" });
    await waitFor(() => expect(refreshButton()).toBeDisabled());

    act(() => {
      startCatalogRefresh(true, () => second.promise);
    });
    expect(refreshButton()).toBeDisabled();

    await act(async () => {
      second.resolve({ refreshedAt: defaultCatalogRefreshedAt, errors: {} });
      await second.promise;
    });
    expect(refreshButton()).toBeDisabled();

    first.resolve({ refreshedAt: defaultCatalogRefreshedAt, errors: {} });
    await waitFor(() => expect(refreshButton()).toBeEnabled());
  });

  it("fires one auto-refresh when Models mounts under StrictMode", async () => {
    const pending = deferred<ModelCatalogRefreshResult>();
    const { countCalls } = renderSettings("/usage?settings=models", disabledUpdateStatus, {
      catalogRefreshImpl: () => pending.promise,
      strict: true,
    });

    await findModelsSection();
    await waitFor(() => expect(countCalls("refresh_model_catalog")).toBe(1));
    expect(window.pace!.invoke).toHaveBeenCalledWith("refresh_model_catalog", { force: false });

    pending.resolve({ refreshedAt: defaultCatalogRefreshedAt, errors: {} });
    await act(async () => {
      await pending.promise;
    });
  });

  it("disables Refresh models when catalog refresh is offline", async () => {
    const { countCalls } = renderSettings("/usage?settings=models", disabledUpdateStatus, {
      catalogRefresh: { offline: true },
    });
    const section = await findModelsSection();

    await waitFor(() => {
      expect(within(section).getByText(/PI_OFFLINE/)).toBeInTheDocument();
    });
    expect(window.pace!.invoke).toHaveBeenCalledWith("refresh_model_catalog", {
      force: false,
    });
    expect(within(section).getByRole("button", { name: "Refresh models" })).toBeDisabled();
    expect(countCalls("refresh_model_catalog")).toBe(1);
  });

  it("opens directly to Models and switches sections without losing an API key draft", async () => {
    const user = userEvent.setup();
    renderSettings();
    await findModelsSection();
    expect(
      screen.queryByRole("region", { name: "Providers" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Providers" }));
    await user.click(screen.getByRole("button", { name: "API Key" }));
    const card = await screen.findByTestId("provider-api-key-anthropic");
    await user.type(
      within(card).getByPlaceholderText("Paste API key"),
      "sk-unsaved",
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    await findModelsSection();
    await user.click(screen.getByRole("button", { name: "Providers" }));
    expect(within(card).getByPlaceholderText("Paste API key")).toHaveValue(
      "sk-unsaved",
    );
  });
});

describe("Settings — chats", () => {
  it("does not query the chat workspace root until the Chats section is open", async () => {
    const user = userEvent.setup();
    const { countCalls } = renderSettings();

    await findModelsSection();
    expect(countCalls("get_chat_workspace_root")).toBe(0);

    await user.click(screen.getByRole("button", { name: "Chats" }));

    await waitFor(() => {
      expect(countCalls("get_chat_workspace_root")).toBe(1);
    });
  });

  it("shows the chat workspace root and opens the folder", async () => {
    const user = userEvent.setup();
    const { countCalls } = renderSettings("/usage?settings=chats");

    const section = await screen.findByTestId("settings-chats");

    expect(within(section).getByRole("heading", { name: "Chats" })).toBeInTheDocument();
    expect(await within(section).findByText("/tmp/pigui-dev/chats")).toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "Open folder" }));

    expect(countCalls("reveal_project_in_finder")).toBe(1);
    expect(window.pace!.invoke).toHaveBeenCalledWith("reveal_project_in_finder", {
      path: "/tmp/pigui-dev/chats",
      ensure: true,
    });
  });
});

describe("Settings — about and updates", () => {
  it.each([false, true])(
    "keeps the update indicator in sync while browsing another section (compact: %s)",
    async (compact) => {
      const originalMatchMedia = window.matchMedia;
      const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
        ...originalMatchMedia(query),
        matches: query === "(max-width: 640px)" && compact,
      }));
      try {
        const { emitUpdate, countCalls } = renderSettings("/usage?settings=models", {
          state: "idle",
          currentVersion: "0.0.1",
        });
        const navigation = await screen.findByRole("navigation", { name: "Settings sections" });
        const about = within(navigation).getByRole("button", {
          name: compact ? "About" : "About & Updates",
        });
        await findModelsSection();
        await waitFor(() => expect(countCalls("update:status")).toBe(1));
        expect(within(about).queryByText("Update")).not.toBeInTheDocument();
        expect(within(about).queryByText("Ready")).not.toBeInTheDocument();

        emitUpdate({ state: "available", currentVersion: "0.0.1", availableVersion: "0.0.2" });
        expect(within(about).getByText("Update")).toBeVisible();
        expect(screen.queryByRole("region", { name: "About & Updates" })).not.toBeInTheDocument();

        emitUpdate({ state: "downloading", currentVersion: "0.0.1", progressPercent: 42 });
        expect(within(about).getByText("Update")).toBeVisible();

        emitUpdate({ state: "ready", currentVersion: "0.0.1", availableVersion: "0.0.2" });
        expect(within(about).queryByText("Update")).not.toBeInTheDocument();
        expect(within(about).getByText("Ready")).toBeVisible();
        await userEvent.click(about);
        const section = await screen.findByRole("region", { name: "About & Updates" });
        expect(within(section).getByRole("button", { name: "Restart to update" })).toBeEnabled();
        expect(within(about).getByText("Ready")).toBeVisible();

        emitUpdate({ state: "idle", currentVersion: "0.0.2" });
        expect(within(about).queryByText("Update")).not.toBeInTheDocument();
        expect(within(about).queryByText("Ready")).not.toBeInTheDocument();
        expect(within(section).queryByRole("button", { name: "Restart to update" })).not.toBeInTheDocument();
      } finally {
        matchMedia.mockRestore();
      }
    },
  );

  async function findAboutSection() {
    await userEvent.click(
      await screen.findByRole("button", { name: /^About & Updates/ }),
    );
    return screen.findByTestId("settings-about");
  }

  it("shows a cached ready update when Settings opens after a background download", async () => {
    const { emitUpdate, countCalls } = renderSettings("/usage", {
      state: "idle",
      currentVersion: "0.0.1",
    });
    const settings = await screen.findByRole("button", { name: "Settings" });
    await waitFor(() => expect(countCalls("update:status")).toBe(1));
    emitUpdate({ state: "ready", currentVersion: "0.0.1", availableVersion: "0.0.2" });

    await userEvent.click(settings);
    const navigation = await screen.findByRole("navigation", { name: "Settings sections" });
    const about = within(navigation).getByRole("button", { name: /^About & Updates/ });
    expect(within(about).getByText("Ready")).toBeVisible();
    expect(screen.getByRole("region", { name: "Providers" })).toBeVisible();
    expect(countCalls("update:status")).toBe(1);
  });

  it("shows the bundled Pi SDK version once runtime info resolves", async () => {
    renderSettings();

    const section = await findAboutSection();

    expect(await within(section).findByText("Pi SDK 0.86.0")).toBeInTheDocument();
  });

  it("shows the current version and a disabled check button when updates are disabled", async () => {
    renderSettings();

    const section = await findAboutSection();

    expect(await within(section).findByText(/0\.0\.1/)).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Check for updates" }),
    ).toBeDisabled();
    expect(
      within(section).queryByRole("button", { name: "Restart to update" }),
    ).not.toBeInTheDocument();
  });

  it("keeps restart hidden while an update is available", async () => {
    renderSettings("/usage?settings=about", {
      state: "available",
      currentVersion: "0.0.1",
      availableVersion: "0.0.2",
    });

    const section = await findAboutSection();

    expect(await within(section).findByText(/0\.0\.1/)).toBeInTheDocument();
    expect(within(section).getByText(/0\.0\.2/)).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Check for updates" }),
    ).toBeEnabled();
    expect(
      within(section).queryByRole("button", { name: "Restart to update" }),
    ).not.toBeInTheDocument();
  });

  it("shows restart to update only when an update is ready", async () => {
    renderSettings("/usage?settings=about", {
      state: "ready",
      currentVersion: "0.0.1",
      availableVersion: "0.0.2",
    });

    const section = await findAboutSection();

    expect(
      await within(section).findByRole("button", { name: "Restart to update" }),
    ).toBeEnabled();
    expect(
      within(section).getByRole("button", { name: "Check for updates" }),
    ).toBeEnabled();
  });

  it("surfaces an update error without offering restart", async () => {
    renderSettings("/usage?settings=about", {
      state: "error",
      currentVersion: "0.0.1",
      message: "GitHub releases timed out",
    });

    const section = await findAboutSection();

    expect(
      await within(section).findByText("GitHub releases timed out"),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Check for updates" }),
    ).toBeEnabled();
    expect(
      within(section).queryByRole("button", { name: "Restart to update" }),
    ).not.toBeInTheDocument();
  });
});

describe("Settings — changelog", () => {
  it("uses compact navigation labels and keeps every section accessible on narrow screens", async () => {
    const originalMatchMedia = window.matchMedia;
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      ...originalMatchMedia(query),
      matches: query === "(max-width: 640px)",
    }));
    try {
      renderSettings("/usage?settings=changelog");
      const navigation = await screen.findByRole("navigation", { name: "Settings sections" });
      await userEvent.click(within(navigation).getByRole("button", { name: "About" }));
      expect(await screen.findByRole("region", { name: "About & Updates" })).toBeVisible();
      await userEvent.click(within(navigation).getByRole("button", { name: "Changelog" }));
      expect(await screen.findByRole("region", { name: "Changelog" })).toBeVisible();
    } finally {
      matchMedia.mockRestore();
    }
  });

  it("opens the release timeline directly from the settings query", async () => {
    renderSettings("/usage?settings=changelog");

    const section = await screen.findByRole("region", { name: "Changelog" });
    expect(within(section).getByRole("heading", { name: "v0.0.1" })).toBeVisible();
    expect(within(section).getByText("September 6, 2026")).toBeVisible();
    expect(within(section).getByText("Projects and sessions")).toBeVisible();
    expect(within(section).getByText("Chat and trajectory")).toBeVisible();
    expect(within(section).getByText("Browser and terminal")).toBeVisible();
    expect(within(section).getByText("Providers and models")).toBeVisible();
    const firstRelease = within(section).getByRole("article", { name: "v0.0.1" });
    expect(within(firstRelease).getByRole("link", { name: /View release on GitHub/ }))
      .toHaveAttribute("href", "https://github.com/BubblePtr/pace/releases/tag/v0.0.1");
  });

  it("switches to the changelog without losing the route or an unsaved settings draft", async () => {
    const user = userEvent.setup();
    const { router } = renderSettings("/usage?range=week&settings=providers#totals");
    await user.click(await screen.findByRole("button", { name: "API Key" }));
    const input = within(await screen.findByTestId("provider-api-key-anthropic"))
      .getByPlaceholderText("Paste API key");
    await user.type(input, "sk-unsaved");
    await user.click(screen.getByRole("button", { name: "Changelog" }));

    expect(await screen.findByRole("region", { name: "Changelog" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/usage");
    expect(router.state.location.search).toMatchObject({ range: "week", settings: "changelog" });
    expect(router.state.location.hash).toBe("totals");
    await user.click(screen.getByRole("button", { name: "Providers" }));
    expect(input).toHaveValue("sk-unsaved");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(router.state.location.href).toBe("/usage?range=week#totals"));
  });
});

describe("Settings — provider connection test", () => {
  it("offers Check only for configured providers and shows a single status line", async () => {
    const user = userEvent.setup();
    renderSettings("/usage?settings=providers");

    const anthropic = await screen.findByTestId("provider-subscription-anthropic");
    const xai = screen.getByTestId("provider-subscription-xai");
    // Never checked: the credential summary, no "not tested" noise.
    expect(within(anthropic).getByTestId("provider-connection-status")).toHaveTextContent("API key · …dev1");
    expect(within(anthropic).queryByText(/not tested/i)).not.toBeInTheDocument();
    expect(within(xai).queryByRole("button", { name: "Check" })).not.toBeInTheDocument();

    await user.click(within(anthropic).getByRole("button", { name: "Check" }));

    expect(await within(anthropic).findByText("Working")).toBeInTheDocument();
    expect(window.pace!.invoke).toHaveBeenCalledWith("test_provider_connection", {
      providerId: "anthropic",
    });

    await user.click(screen.getByRole("button", { name: "API Key" }));
    const apiCard = await screen.findByTestId("provider-api-key-anthropic");
    expect(within(apiCard).getByText("Working")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("provider-api-key-xai")).queryByRole("button", { name: "Check" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the raw provider text behind Details", async () => {
    const user = userEvent.setup();
    renderSettings("/usage?settings=providers", disabledUpdateStatus, {
      connectionTestResult: {
        ok: false,
        kind: "entitlement",
        message: "Not covered by your subscription plan",
        detail: "403 status code (no body)",
        modelId: "claude-sonnet-4",
      },
    });

    const anthropic = await screen.findByTestId("provider-subscription-anthropic");
    await user.click(within(anthropic).getByRole("button", { name: "Check" }));

    expect(await within(anthropic).findByText("Not covered by your plan")).toBeInTheDocument();
    expect(within(anthropic).queryByText("403 status code (no body)")).not.toBeInTheDocument();
    await user.click(within(anthropic).getByText("Details"));
    expect(within(anthropic).getByText("403 status code (no body)")).toBeInTheDocument();
  });

  it("turns an expired subscription sign-in into a Sign in again action", async () => {
    const user = userEvent.setup();
    renderSettings("/usage?settings=providers", disabledUpdateStatus, {
      authStatus: {
        ...providerAuthStatus,
        providers: [
          { ...providerAuthStatus.providers[1]!, mode: "oauth", configured: true },
        ],
      },
      connectionTestResult: {
        ok: false,
        kind: "auth",
        message: "Authentication failed",
        detail: "OAuth refresh failed for xai: invalid_grant",
        modelId: "grok-4.6",
      },
    });

    const xai = await screen.findByTestId("provider-subscription-xai");
    expect(within(xai).queryByRole("button", { name: "Sign in again" })).not.toBeInTheDocument();
    await user.click(within(xai).getByRole("button", { name: "Check" }));

    expect(await within(xai).findByText("Sign-in expired")).toBeInTheDocument();
    expect(within(xai).getByRole("button", { name: "Sign in again" })).toBeEnabled();
  });

  it("clears a verified probe when the API key is replaced", async () => {
    const user = userEvent.setup();
    renderSettings("/usage?settings=providers");
    await user.click(await screen.findByRole("button", { name: "API Key" }));
    const card = await screen.findByTestId("provider-api-key-anthropic");

    await user.click(within(card).getByRole("button", { name: "Check" }));
    expect(await within(card).findByText("Working")).toBeInTheDocument();

    await user.type(within(card).getByPlaceholderText("Paste API key"), "sk-replaced");
    await user.click(within(card).getByRole("button", { name: "Replace key" }));

    await waitFor(() => expect(within(card).queryByText("Working")).not.toBeInTheDocument());
  });

  it("does not show a probe that resolves after the credential changed", async () => {
    const user = userEvent.setup();
    let resolveProbe: (result: ProviderConnectionTestResult) => void = () => {};
    const pending = new Promise<ProviderConnectionTestResult>((resolve) => {
      resolveProbe = resolve;
    });
    renderSettings("/usage?settings=providers", disabledUpdateStatus, {
      connectionTestResult: { ok: true, modelId: "claude-sonnet-4", latencyMs: 42 },
      probe: () => pending,
    });
    await user.click(await screen.findByRole("button", { name: "API Key" }));
    const card = await screen.findByTestId("provider-api-key-anthropic");

    await user.click(within(card).getByRole("button", { name: "Check" }));
    expect(within(card).getByRole("button", { name: "Checking…" })).toBeDisabled();

    await user.type(within(card).getByPlaceholderText("Paste API key"), "sk-replaced");
    await user.click(within(card).getByRole("button", { name: "Replace key" }));
    expect(await within(card).findByRole("button", { name: "Check" })).toBeEnabled();

    resolveProbe({ ok: true, modelId: "claude-sonnet-4", latencyMs: 42 });
    await waitFor(() => {
      expect(within(card).queryByText("Working")).not.toBeInTheDocument();
    });
  });
});

describe("Settings — provider API keys", () => {
  it("filters API key cards by label or id", async () => {
    const user = userEvent.setup();
    renderSettings("/usage?settings=providers");

    await user.click(await screen.findByRole("button", { name: "API Key" }));
    expect(await screen.findByTestId("provider-api-key-anthropic")).toBeVisible();
    expect(screen.getByTestId("provider-api-key-xai")).toBeVisible();
    expect(screen.getByTestId("provider-api-key-github-copilot")).toBeVisible();

    await user.type(screen.getByPlaceholderText(/filter/i), "Grok");

    expect(screen.getByTestId("provider-api-key-xai")).toBeVisible();
    expect(screen.queryByTestId("provider-api-key-anthropic")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("provider-api-key-github-copilot"),
    ).not.toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText(/filter/i));
    await user.type(screen.getByPlaceholderText(/filter/i), "github-copilot");

    expect(screen.getByTestId("provider-api-key-github-copilot")).toBeVisible();
    expect(screen.queryByTestId("provider-api-key-anthropic")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-api-key-xai")).not.toBeInTheDocument();
  });
});

describe("Settings dialog navigation", () => {
  it("opens over the current page and restores its route, draft and trigger on close", async () => {
    const user = userEvent.setup();
    const { router, countCalls } = renderSettings("/usage?range=week#totals");
    const trigger = await screen.findByRole("button", { name: "Settings" });
    const draft = screen.getByRole("textbox", { name: "Session draft" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(countCalls("list_provider_auth_status")).toBe(0);
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(router.state.location.pathname).toBe("/usage");
    expect(router.state.location.search).toMatchObject({
      range: "week",
      settings: "providers",
    });
    expect(router.state.location.hash).toBe("totals");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(router.state.location.href).toBe("/usage?range=week#totals");
    expect(screen.getByRole("textbox", { name: "Session draft" })).toBe(draft);
    expect(draft).toHaveValue("Keep my draft");
    expect(trigger).toHaveFocus();
  });

  it("closes with Escape", async () => {
    const user = userEvent.setup();
    const { router } = renderSettings();
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("button", { name: "Models" }));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(router.state.location.pathname).toBe("/usage");
  });
});
