import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useState, type ComponentProps } from "react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { BackendRpcEvent } from "@pace/backend";
import type {
  AgentMessagePartSnapshot,
  AgentMessagePartType,
  SessionChanges,
} from "@pace/core";
import {
  AgentWorkspaceSessionsPage,
  AgentWorkspaceSessionsView,
} from "@/pages/agent-workspace";
import { addProjectToRegistry } from "@/entities/project/project-registry";
import { SessionProjectionsProvider } from "@/entities/session/use-session-projections";
import {
  createSessionProjectionsStore,
  type SessionProjectionsStore,
} from "@/entities/session/session-projections-store";
import {
  PiRuntimeBridgeError,
  type AgentRuntimeEventEntry,
  type ForkSessionInput,
  type ForkSessionResult,
  type PiSessionState,
  type PiRuntimeEvent,
  type PiRuntimeBridge,
} from "@/entities/runtime/pi-runtime-bridge";
import * as inMemoryBridgeModule from "@/entities/runtime/in-memory-pi-runtime-bridge";
import * as runtimeFactoryModule from "@/entities/runtime/pi-runtime-factory";
import {
  createInMemoryPiRuntimeBridge,
  type InMemoryPiRuntimeBridge,
} from "@/entities/runtime/in-memory-pi-runtime-bridge";
import { createExecutionCheckoutManager } from "@/entities/checkout/execution-checkout";
import * as checkoutClientModule from "@/entities/checkout/execution-checkout-client";
import { createSessionFromDraft } from "@/entities/session/session-creation";
import {
  applySessionProjectionEvent,
  createSessionProjection,
  type SessionProjection,
} from "@/entities/session/session-projection";
import { createSessionRuntimeModel } from "@/entities/session/session-runtime-model";
import { getFollowUpDraft, saveFollowUpDraft } from "@/entities/session/follow-up-drafts";
import { injectIntoComposer } from "@/entities/session/composer-injections";
import { getLastModelSelection, saveLastModelSelection } from "@/entities/session/last-model-preference";
import { saveVisibleModels } from "@/entities/model/visible-models";
import { ensureSessionDraft, getSessionDraft, saveSessionDraft, setSessionDraftTarget } from "@/entities/session/session-drafts";
import * as sessionsApi from "@/entities/session/sessions";
import * as runtimeModule from "@/shared/runtime";
import { createMockApi, mockProject } from "@/dev/mock/scenarios";
import { footerOf } from "@/test/composer-footer";
import { render } from "@/test/render";
import { fixtureWorkspace } from "@/dev/fixtures/agent-workspace";

type SessionsViewProps = ComponentProps<typeof AgentWorkspaceSessionsView>;

// The View requires its Project; tests that do not care which one render the
// fixture Workspace.
function FixtureSessionsView({
  projectId = fixtureWorkspace.id,
  workspace = fixtureWorkspace,
  ...props
}: Omit<SessionsViewProps, "projectId" | "workspace"> &
  Partial<Pick<SessionsViewProps, "projectId" | "workspace">>) {
  return <AgentWorkspaceSessionsView projectId={projectId} workspace={workspace} {...props} />;
}

// The app shell renders the sidebar with Astryx SideNav: rows are buttons,
// project sessions live in the aria-controls group owned by the project
// header row. These helpers mirror widgets/app-frame/app-frame.test.tsx.
function isAstryxSideNavRow(candidate: HTMLElement) {
  return candidate.classList.contains("astryx-side-nav-item");
}

function getProjectHeaderRowByName(name: string) {
  const projectGroup = screen.getByTestId("sidebar-projects");
  const header = within(projectGroup)
    .getAllByRole("button")
    .find(
      (candidate) =>
        isAstryxSideNavRow(candidate) &&
        candidate.hasAttribute("aria-expanded") &&
        !candidate.hasAttribute("aria-haspopup") &&
        (candidate.textContent ?? "").startsWith(name),
    );

  if (!header) {
    throw new Error(`Project header row not found: ${name}`);
  }

  return header;
}

function getProjectSessionsGroupByName(name: string) {
  const header = getProjectHeaderRowByName(name);
  const groupId = header.getAttribute("aria-controls");
  const group = groupId ? document.getElementById(groupId) : null;

  if (!group) {
    throw new Error(`Project sessions group not found: ${name}`);
  }

  return group as HTMLElement;
}

async function findProjectSessionsGroupByName(name: string) {
  await screen.findByTestId("sidebar-projects");

  return getProjectSessionsGroupByName(name);
}

function getSidebarSessionRows(scope: HTMLElement) {
  return within(scope)
    .getAllByRole("button")
    .filter(
      (candidate) =>
        isAstryxSideNavRow(candidate) && !candidate.hasAttribute("aria-expanded"),
    );
}

function querySidebarSessionRow(title: string) {
  const projectGroup = screen.queryByTestId("sidebar-projects");

  if (!projectGroup) {
    return undefined;
  }

  return within(projectGroup)
    .queryAllByRole("button")
    .filter(
      (candidate) =>
        isAstryxSideNavRow(candidate) && !candidate.hasAttribute("aria-expanded"),
    )
    .find((candidate) => (candidate.textContent ?? "").includes(title));
}

async function findSidebarSessionRow(title: string) {
  return waitFor(() => {
    const row = querySidebarSessionRow(title);

    if (!row) {
      throw new Error(`Session row not found: ${title}`);
    }

    return row;
  });
}

vi.mock("@/entities/session/session-diff-viewer", () => ({
  default: ({ patch, style }: { patch: string; style: string }) => (
    <div data-testid="session-diff-viewer" data-style={style}>
      {patch}
    </div>
  ),
}));

const pigProjectPath = "/Users/void/code/opensource/Pig";
const studyProjectPath = "/Users/void/Documents/study";

function renderProjectSessions(
  path = "/projects/pig/sessions",
  { seedProjects = true }: { seedProjects?: boolean } = {},
) {
  if (seedProjects) {
    addProjectToRegistry(pigProjectPath, {
      now: () => "2026-06-30T08:00:00.000Z",
    });
    if (!window.pace) {
      window.__PACE_ENABLE_BROWSER_DEVELOPMENT_MOCKS__ = true;
    }
  }

  const routePath = path.replace(
    "/projects/pig/sessions",
    `/projects/${encodeURIComponent(pigProjectPath)}/sessions`,
  );

  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId/sessions",
    component: AgentWorkspaceSessionsPage,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [routePath] }),
    routeTree: rootRoute.addChildren([sessionsRoute]),
  });

  return {
    ...render(
      <SessionProjectionsProvider>
        <RouterProvider router={router} />
      </SessionProjectionsProvider>,
    ),
    router,
  };
}

function storeWith(bridge: PiRuntimeBridge, ...projections: SessionProjection[]) {
  const store = createSessionProjectionsStore({ bridge, listSessions: async () => [] });
  for (const projection of projections) store.insert(projection);
  return store;
}

/** The ChatPromptInput root inside a composer, where accent/status live. */
function promptInputShellOf(composer: HTMLElement) {
  const shell = composer.querySelector<HTMLElement>('[data-slot="prompt-input"]');

  if (!shell) {
    throw new Error("composer has no prompt input");
  }

  return shell;
}

async function chooseProjectFromPicker(
  user: ReturnType<typeof userEvent.setup>,
  projectName: string,
) {
  await user.click(screen.getByTestId("project-picker-trigger"));
  await user.click(await screen.findByRole("option", { name: projectName }));
}

// Astryx Selector renders the dropdown as a role="listbox" popup labelled by
// its trigger; these helpers assert the structural contract of that popup.
function expectAdaptiveInlineSelectPopover(listbox: HTMLElement) {
  expect(listbox).toBeInTheDocument();
  expect(listbox.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
}

function expectInlineSelectOptionIsAstryxOption(option: HTMLElement) {
  expect(option).toHaveAttribute("role", "option");
  expect(option).toHaveAttribute("aria-selected");
}

function expectInlineSelectOptionLabelMatchesCompactMenu(
  option: HTMLElement,
  label: string,
) {
  expect(within(option).getByText(label)).toBeInTheDocument();
}

function getOpenSelectorListbox() {
  const listbox = document.querySelector('[role="listbox"]');

  if (!(listbox instanceof HTMLElement)) {
    throw new Error("Expected an open Selector listbox to be rendered.");
  }

  return listbox;
}

/**
 * Every window uses the same panel, reached through its toolbar and rail.
 */
async function openSessionSurfaceSheet(
  user: ReturnType<typeof userEvent.setup>,
  surfaceTitle: "Changes" | "Terminal",
) {
  await user.click(await screen.findByRole("button", { name: "Session dock" }));

  const sheet = await screen.findByRole("complementary", { name: "Changes" });

  await user.click(within(sheet).getByRole("button", { name: surfaceTitle }));

  return sheet;
}

function setDockedLayout(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn((query: string): MediaQueryList => ({
      matches: query === "(min-width: 1280px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  });
}

describe("AgentWorkspaceSessionsPage", () => {
  beforeEach(() => {
    setDockedLayout(false);
    window.localStorage.clear();
    delete window.pace;
    delete (
      window as typeof window & {
        __PACE_ENABLE_BROWSER_DEVELOPMENT_MOCKS__?: boolean;
      }
    ).__PACE_ENABLE_BROWSER_DEVELOPMENT_MOCKS__;
  });

  it("retries only the latest failed request and preserves the unsent draft", async () => {
    const user = userEvent.setup();
    const bridge = createInMemoryPiRuntimeBridge();
    const send = vi.spyOn(bridge, "sendInitialPrompt");
    const onProviders = vi.fn();
    let projection: SessionProjection = {
      ...createSessionProjection({ id: "retry-chat", projectId: "pig-docs", initialPrompt: "Original task", createdAt: "2026-09-07T10:00:00.000Z" }),
      creationStage: "accepted", piSessionId: "retry-pi", runtimeId: "retry-runtime",
    };
    for (const event of [
      { id: "request", kind: "message", role: "user", body: "Original task" },
      { id: "failure", kind: "error", title: "Run failed", body: '401 {"error":{"message":"Invalid API key"}}' },
    ] as const) {
      projection = applySessionProjectionEvent(projection, { type: "runtime-event-received",
        event: { ...event, piSessionId: "retry-pi", timestamp: "2026-09-07T10:00:00.000Z" } });
    }
    saveFollowUpDraft(projection.id, "An unsent follow-up");
    render(<FixtureSessionsView projectId="pig-docs" sessionProjection={projection}
      runtimeBridge={bridge} onOpenProviderSettings={onProviders} />);
    await user.click(screen.getByRole("button", { name: "Provider settings" }));
    expect(onProviders).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Retry request" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ piSessionId: "retry-pi", prompt: "Original task" }));
    expect(getFollowUpDraft(projection.id)?.message).toBe("An unsent follow-up");
    expect(screen.queryByRole("button", { name: "Retry request" })).not.toBeInTheDocument();
  });

  it("waits for a model change before retrying a failed request", async () => {
    const user = userEvent.setup();
    const baseBridge = createInMemoryPiRuntimeBridge();
    const send = vi.spyOn(baseBridge, "sendInitialPrompt");
    const models = [
      { provider: "openai", modelId: "first", name: "First model", thinkingLevels: ["off" as const] },
      { provider: "openai", modelId: "second", name: "Second model", thinkingLevels: ["off" as const] },
    ];
    let finishChange!: () => void;
    const pendingChange = new Promise<void>((resolve) => { finishChange = resolve; });
    const configureModel = vi.fn(async () => {
      await pendingChange;
      return { models, selected: { provider: "openai", modelId: "second", thinkingLevel: "off" as const } };
    });
    let projection: SessionProjection = {
      ...createSessionProjection({ id: "retry-model", projectId: "pig-docs", initialPrompt: "Original task", createdAt: "2026-09-07T10:00:00.000Z" }),
      creationStage: "accepted", piSessionId: "retry-model-pi", runtimeId: "retry-model-runtime",
      modelControls: { models, selected: { provider: "openai", modelId: "first", thinkingLevel: "off" } },
    };
    for (const event of [
      { id: "request", kind: "message", role: "user", body: "Original task" },
      { id: "failure", kind: "error", title: "Run failed", body: "401 Invalid API key" },
    ] as const) {
      projection = applySessionProjectionEvent(projection, { type: "runtime-event-received",
        event: { ...event, piSessionId: "retry-model-pi", timestamp: "2026-09-07T10:00:00.000Z" } });
    }
    render(<FixtureSessionsView projectId="pig-docs" sessionProjection={projection}
      runtimeBridge={{ ...baseBridge, configureModel }} />);
    await user.click(screen.getAllByTestId("model-thinking-trigger")[0]);
    await user.click(within(screen.getByRole("dialog")).getByText("Second model"));
    expect(configureModel).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Retry request" }));
    expect(send).not.toHaveBeenCalled();
    await act(async () => finishChange());
    await waitFor(() => expect(send).toHaveBeenCalledWith({ piSessionId: "retry-model-pi", prompt: "Original task" }));
  });

  it("renders a Project-scoped Sessions view with Live Chat and the action surface", async () => {
    const user = userEvent.setup();

    const { container } = renderProjectSessions();

    const sessionsView = await screen.findByTestId("project-sessions-view");

    expect(within(sessionsView).queryByText("Project Workspace")).not.toBeInTheDocument();
    expect(within(sessionsView).queryByText(/Pig keeps live Pi work/)).not.toBeInTheDocument();
    expect(within(sessionsView).queryByText("Live Session View")).not.toBeInTheDocument();
    expect(within(sessionsView).queryByText(/Messages and run activity/)).not.toBeInTheDocument();

    const liveColumn = screen.getByTestId("live-session-column");
    // Session hydration and auto-selection settle asynchronously after the
    // sessions view mounts; the toolbar appears once a session is selected.
    const navbarActions = await screen.findByTestId("navbar-actions");

    expect(within(liveColumn).queryByText("Evidence preserved")).not.toBeInTheDocument();
    expect(within(liveColumn).queryByText("Analyze preserved")).not.toBeInTheDocument();

    expect(screen.getByTestId("sidebar-projects")).toBeInTheDocument();
    expect(
      within(sessionsView).queryByTestId("project-session-list-column"),
    ).not.toBeInTheDocument();
    expect(
      within(sessionsView).queryByTestId("structured-action-surface-column"),
    ).not.toBeInTheDocument();
    expect(within(liveColumn).queryByRole("heading", { name: "Live Chat" })).not.toBeInTheDocument();
    expect(within(liveColumn).queryByRole("heading", { name: "Run timeline" })).not.toBeInTheDocument();
    expect(within(liveColumn).queryByRole("button", { name: "Session dock" })).not.toBeInTheDocument();
    expect(liveColumn).toHaveClass("h-full");
    expect(sessionsView).toHaveClass("-mt-10", "h-[calc(100%+2.5rem)]", "pb-0");
    expect(sessionsView).not.toHaveClass("pt-6", "py-6");
    // One toolbar toggle now stands for the whole dock; Changes and
    // Actions are surfaces inside it, not separate toolbar buttons.
    const sessionDockButton = within(navbarActions).getByRole("button", {
      name: "Session dock",
    });

    expect(
      within(navbarActions).queryByRole("button", { name: "Session changes" }),
    ).not.toBeInTheDocument();
    expect(
      within(navbarActions).queryByRole("button", { name: "Session actions" }),
    ).not.toBeInTheDocument();
    const chatConversation = liveColumn.querySelector('[data-slot="chat-conversation"]');
    const promptInput = liveColumn.querySelector('[data-slot="prompt-input"]');
    const composer = liveColumn.querySelector('[data-testid="full-chat-composer"]');
    const liveComposerInput = within(liveColumn).getByPlaceholderText(
      "Queue the next task…",
    );
    const trajectorySidebarLabel = within(screen.getByRole("button", { name: "Trajectory" }))
      .getByText("Trajectory");
    const newSessionSidebarLabel = within(
      screen.getByRole("group", { name: "Trajectory and usage navigation" }),
    ).getByText("New Chat");

    expect(sessionDockButton).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector('[data-slot="navbar-spacer"]')).toHaveAttribute(
      "data-window-drag-region",
    );
    expect(chatConversation).toBeInTheDocument();
    expect(chatConversation?.closest(".card")).toBeNull();
    expect(promptInput?.closest(".card")).toBeNull();
    // The log role lives on the Astryx ChatMessageList inside the viewport.
    const conversationLog = chatConversation?.querySelector('[role="log"]');
    expect(conversationLog).toBeInTheDocument();
    expect(conversationLog).toHaveClass("astryx-chat-message-list");
    expect(trajectorySidebarLabel).not.toHaveClass("font-medium");
    expect(newSessionSidebarLabel).not.toHaveClass("font-medium");
    expect(liveComposerInput).not.toHaveClass("font-medium");
    expect(
      liveColumn.querySelector('[data-slot="chat-conversation-content"]'),
    ).toBeInTheDocument();
    expect(liveColumn.querySelectorAll('[data-slot="chat-message-user"]')).toHaveLength(1);
    expect(liveColumn.querySelectorAll('[data-slot="chat-message-assistant"]')).toHaveLength(1);
    expect(liveColumn.querySelectorAll('[data-slot="chat-message-bubble"]')).toHaveLength(1);
    expect(liveColumn.querySelectorAll('[data-slot="chat-message-body"]')).toHaveLength(1);
    expect(liveColumn.querySelectorAll('[data-slot="chat-message-content"]')).toHaveLength(2);
    expect(liveColumn.querySelectorAll('[data-slot="chat-message-avatar"]')).toHaveLength(0);
    expect(liveColumn.querySelectorAll('[data-slot="chat-message-actions"]')).toHaveLength(1);
    const userMessage = liveColumn.querySelector(
      '[data-slot="chat-message-user"]',
    );
    const userBubble = userMessage?.querySelector(
      '[data-slot="chat-message-bubble"]',
    );
    const userActions = userMessage?.querySelector(
      '[data-slot="chat-message-actions"]',
    );
    const assistantMessage = liveColumn.querySelector(
      '[data-slot="chat-message-assistant"]',
    );
    const assistantTrace = assistantMessage?.querySelector(
      '[data-slot="chain-of-thought"]',
    );
    const assistantContent = assistantMessage?.querySelector(
      '[data-slot="chat-message-content"]',
    );
    const assistantActions = assistantMessage?.querySelector(
      '[data-slot="chat-message-actions"]',
    );
    expect(userActions).toBeInTheDocument();
    expect(userActions?.parentElement).toHaveClass(
      "flex",
      "flex-col",
      "items-end",
      "gap-1",
    );
    expect(userBubble?.nextElementSibling).toBe(userActions);
    expect(
      within(userMessage as HTMLElement).getByRole("button", { name: "Copy" }),
    ).toBeInTheDocument();
    expect(assistantTrace).not.toBeInTheDocument();
    expect(assistantContent).toBeInTheDocument();
    expect(assistantActions).not.toBeInTheDocument();
    expect(
      within(assistantMessage as HTMLElement).queryByRole("button", { name: "Copy" }),
    ).not.toBeInTheDocument();
    expect(
      within(assistantMessage as HTMLElement).queryByRole("button", { name: "Good response" }),
    ).not.toBeInTheDocument();
    expect(
      within(assistantMessage as HTMLElement).queryByRole("button", { name: "Bad response" }),
    ).not.toBeInTheDocument();
    expect(liveColumn.querySelectorAll('[data-slot="chain-of-thought-step"]')).toHaveLength(0);
    expect(within(liveColumn).queryByText("Project context loaded")).not.toBeInTheDocument();
    expect(promptInput).toBeInTheDocument();
    expect(composer).toBeInTheDocument();
    expect(composer).toHaveClass("mt-auto", "pb-3");
    expect(liveColumn.querySelector(".astryx-chat-composer")).toBeInTheDocument();
    expect(liveColumn.querySelector('[data-slot="prompt-input-textarea"]')).toBeInTheDocument();
    expect(promptInput).toHaveAttribute("data-status", "streaming");
    expect(within(liveColumn).getByPlaceholderText("Queue the next task…")).not.toBeDisabled();
    // Queue-first: no composer-level Steer; steering lives on queued rows.
    expect(within(liveColumn).queryByRole("button", { name: "Steer" })).not.toBeInTheDocument();
    expect(within(liveColumn).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(within(liveColumn).queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    expect(
      within(liveColumn).queryByText("Queue is the default while Pi is running."),
    ).not.toBeInTheDocument();
    expect(within(navbarActions).queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const terminalDialog = await openSessionSurfaceSheet(user, "Terminal");
    expect(terminalDialog).toHaveAttribute("data-testid", "session-dock");
    expect(
      within(terminalDialog).queryByRole("button", { name: "Refresh Session changes" }),
    ).not.toBeInTheDocument();
    expect(
      within(terminalDialog).getByText("Terminal requires the desktop app."),
    ).toBeInTheDocument();
  });

  it("uses the same dock panel in narrow windows without a dialog", async () => {
    const user = userEvent.setup();
    setDockedLayout(false);
    renderProjectSessions();
    const toggle = await screen.findByRole("button", { name: "Session dock" });
    await user.click(toggle);
    const panel = await screen.findByRole("complementary", { name: "Changes" });
    expect(
      within(panel).getByRole("button", { name: "Refresh Session changes" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-workspace-split-view")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Terminal" }));
    const terminal = await screen.findByRole("complementary", { name: "Terminal" });
    expect(within(terminal).getByText("Terminal requires the desktop app.")).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByTestId("session-dock")).toHaveAttribute("data-open", "false");
    expect(screen.getByRole("button", { name: "Session dock" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await waitFor(() => {
      expect(screen.queryByTestId("session-dock")).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clamps the docked panel when the window no longer has room for it", async () => {
    const user = userEvent.setup();
    setDockedLayout(true);

    // The split container's own ResizeObserver is the production signal, so
    // the test drives that rather than a stand-in: a controllable observer
    // plus a measurable container width.
    let containerWidth = 1440;
    const notifyResize: Array<() => void> = [];

    class ControllableResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {
        notifyResize.push(() => this.callback([], this as unknown as ResizeObserver));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width: containerWidth, height: 900, x: 0, y: 0, top: 0, left: 0,
        right: containerWidth, bottom: 900, toJSON: () => ({}) }) as DOMRect,
    );

    try {
      renderProjectSessions();
      await user.click(await screen.findByRole("button", { name: "Session dock" }));

      const aside = await screen.findByRole("complementary", { name: "Changes" });
      const asidePane = aside.closest('[data-testid="session-workspace-aside-pane"]') as HTMLElement;

      // 1440 container - 1px handle divider - 400px Chat leaves 1039, so the
      // 560px default is untouched.
      expect(asidePane.style.width).toBe("560px");

      containerWidth = 800;
      act(() => {
        for (const notify of notifyResize) {
          notify();
        }
      });

      // 800 - 1 - 400 = 399: the panel gives back what Chat now needs instead
      // of pushing Chat under its minimum.
      await waitFor(() => expect(asidePane.style.width).toBe("399px"));
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("puts the Session dock beside Chat on wide Workspaces", async () => {
    const user = userEvent.setup();
    setDockedLayout(true);

    renderProjectSessions();

    await user.click(await screen.findByRole("button", { name: "Session dock" }));

    const aside = await screen.findByRole("complementary", { name: "Changes" });
    const splitView = aside.closest('[data-slot="resizable"]');

    expect(
      within(aside).getByRole("button", { name: "Refresh Session changes" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Live Chat messages")).toBeVisible();
    // The handle is the 1px divider itself: no margins, so the grab zone and
    // pill overlay the panes instead of taking width from them.
    expect(screen.getByLabelText("Resize Session dock")).not.toHaveClass("mx-2");
    // The titlebar band is a real 40px row on the Chat side; on the aside
    // side the surface's own first row fills that band (ADR-0028), so the
    // aside pane carries no offset. One hairline under the band spans the
    // whole view (across the resize handle too) rather than being drawn per
    // column.
    expect(
      within(screen.getByTestId("session-workspace-main-pane")).getByTestId(
        "session-workspace-titlebar-band",
      ),
    ).toHaveClass("h-10");
    expect(screen.getByTestId("session-workspace-aside-pane")).not.toHaveClass("pt-10");
    expect(within(aside).getByTestId("session-surface-bar")).toHaveClass("h-10");
    expect(
      within(screen.getByTestId("project-sessions-view")).getByTestId(
        "session-workspace-titlebar-rule",
      ),
    ).toHaveClass("absolute", "inset-x-0", "top-10");
    expect(splitView?.querySelectorAll('[data-slot="resizable-panel"]')).toHaveLength(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The panel's rail hugs the window edge: no centered max-width box or
    // horizontal padding may sit between the split view and the viewport.
    expect(aside.closest(".max-w-\\[96rem\\]")).toBeNull();
    expect(screen.getByTestId("project-sessions-view")).not.toHaveClass("px-6");
    // The toolbar toggle is the head of the rail column: docked, it sits on
    // the rail's axis (a rail-width slot that cancels the header inset).
    expect(
      screen.getByRole("button", { name: "Session dock" }).closest(
        '[data-testid="session-dock-trigger-rail-slot"]',
      ),
    ).toHaveClass("w-11", "-mr-4", "justify-center");

    // The rail swaps the surface inside the same docked panel.
    await user.click(
      within(screen.getByRole("group", { name: "Session surfaces" })).getByRole(
        "button",
        { name: "Terminal" },
      ),
    );

    const terminalAside = await screen.findByRole("complementary", { name: "Terminal" });

    expect(
      within(terminalAside).getByText("Terminal requires the desktop app."),
    ).toBeInTheDocument();
    expect(
      within(terminalAside).queryByRole("button", { name: "Refresh Session changes" }),
    ).not.toBeInTheDocument();

    // No close button in the panel; the toolbar toggle is the one way in and
    // out.
    expect(
      within(terminalAside).queryByRole("button", { name: "Close Session dock" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Session dock" }));

    const closing = screen.getByTestId("session-dock");
    expect(closing).toHaveAttribute("data-open", "false");
    expect(closing).toHaveAttribute("aria-hidden", "true");
    // The split pane, and with it the divider and Chat's width, closes on the
    // same clock as the dock instead of waiting for the unmount.
    const pane = screen.getByTestId("session-workspace-aside-pane").parentElement!;
    expect(pane).toHaveAttribute("data-open", "false");
    expect(pane).toHaveAttribute("data-motion", "true");
    expect(pane.style.getPropertyValue("--pigui-session-dock-width")).toMatch(/px$/);
    expect(screen.getByRole("button", { name: "Session dock" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await waitFor(() => {
      expect(screen.queryByTestId("session-dock")).not.toBeInTheDocument();
    });
  });

  it("counts changed files on the rail, whichever surface is showing", async () => {
    const user = userEvent.setup();
    setDockedLayout(true);
    const persisted = {
      sessionId: "persisted-session-1",
      runtimeId: "pi-sdk:persisted-session-1",
      piSessionId: "pi-session-persisted-1",
      projectId: pigProjectPath,
      initialPrompt: "Review the diff",
      cwd: pigProjectPath,
      status: "completed",
      updatedAt: "2026-09-02T12:00:00.000Z",
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_session_projections") {
        return [persisted];
      }

      if (command === "get_session_changes") {
        return {
          sessionId: "persisted-session-1",
          state: "ready",
          checkoutRoot: pigProjectPath,
          repositoryRoot: pigProjectPath,
          generatedAt: "2026-09-02T12:01:00.000Z",
          head: {
            oid: "abc1234deadbeef",
            branch: "main",
            detached: false,
          },
          files: [
            {
              path: "src/app.ts",
              kind: "modified",
              staged: false,
              unstaged: true,
              additions: 2,
              deletions: 1,
              binary: false,
              patchTruncated: false,
            },
            {
              path: "src/main.ts",
              kind: "added",
              staged: true,
              unstaged: false,
              additions: 4,
              deletions: 0,
              binary: false,
              patchTruncated: false,
            },
          ],
          totals: {
            files: 2,
            additions: 6,
            deletions: 1,
            binaryFiles: 0,
            conflictedFiles: 0,
          },
          truncated: false,
          omittedFileCount: 0,
        } satisfies SessionChanges;
      }

      throw new Error(`unexpected backend command ${command}`);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };

    renderProjectSessions();

    // The composer footer reads Git as soon as the Session is on screen, so
    // the same round-trip later feeds the dock badge and panel.
    await waitFor(() => {
      expect(screen.getByTestId("git-branch-status-trigger")).toHaveTextContent(
        "main",
      );
    });

    await user.click(await screen.findByRole("button", { name: "Session dock" }));

    const rail = await screen.findByRole("group", { name: "Session surfaces" });

    await waitFor(() => {
      expect(within(rail).getByText("2")).toBeInTheDocument();
    });
    // The badge and the panel's totals row must never disagree.
    expect(
      within(await screen.findByRole("complementary", { name: "Changes" }))
        .getByText("2 files ·", { exact: false }),
    ).toBeInTheDocument();

    await user.click(within(rail).getByRole("button", { name: "Terminal" }));

    await screen.findByRole("complementary", { name: "Terminal" });
    expect(within(rail).getByText("2")).toBeInTheDocument();
    // One read feeds the composer chip, the panel, and the badge.
    expect(
      invoke.mock.calls.filter(([command]) => command === "get_session_changes"),
    ).toHaveLength(1);
  });

  it.each([
    "src/new-file.ts#L1",
    `${mockProject}/src/new-file.ts:1:2`,
    `file://${mockProject}/src/%6Eew-file.ts#L1`,
  ])("opens fresh Changes from chat link %s and refocuses on repeat clicks", async (href) => {
    const user = userEvent.setup();
    setDockedLayout(true);
    addProjectToRegistry(mockProject);
    const api = createMockApi();
    let reads = 0;
    let pendingRead: Promise<void> | null = null;
    window.pace = {
      ...api,
      async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        const result = await api.invoke<T>(command, args);
        if (command === "get_runtime_snapshot") {
          const snapshot = result as unknown as import("@pace/core").RuntimeGatewaySnapshot;
          for (const envelope of snapshot.events) {
            const event = envelope.payload as import("@pace/core").AgentRuntimeEvent;
            if (event.type === "message" && event.role === "assistant" && event.parts) {
              for (const part of event.parts) {
                if (part.partType === "text") {
                  part.body = `See [the new file](${href}) and [website](https://example.com/src/new-file.ts).`;
                }
              }
            }
          }
        }
        if (command === "get_session_changes") {
          reads += 1;
          if (pendingRead) await pendingRead;
          // The first read predates the agent's edits; clicking must not use it.
          if (reads === 1) return { ...(result as SessionChanges), state: "clean", files: [] } as T;
        }
        return result;
      },
    };
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    onTestFinished(() => scroll.mockRestore());
    const { router } = renderProjectSessions(`/projects/${encodeURIComponent(mockProject)}/sessions`, { seedProjects: false });
    const chat = await screen.findByLabelText("Live Chat messages");
    const link = await within(chat).findByRole("link", { name: "the new file" });
    await waitFor(() => expect(reads).toBe(1));
    const before = router.state.location.href;
    expect(screen.queryByTestId("session-dock")).not.toBeInTheDocument();

    let finishRefresh!: () => void;
    pendingRead = new Promise<void>((resolve) => { finishRefresh = resolve; });
    expect(fireEvent.click(link)).toBe(false);
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByTestId("session-dock")).not.toBeInTheDocument();
    await act(async () => { finishRefresh(); await pendingRead; });
    pendingRead = null;
    const dock = await screen.findByRole("complementary", { name: "Changes" });
    const section = within(dock).getAllByTestId("session-change-section")
      .find((node) => node.textContent?.includes("src/new-file.ts"))!;
    await waitFor(() => expect(section.contains(document.activeElement)).toBe(true));
    expect(scroll.mock.instances).toContain(section);
    expect(within(section).getByRole("button", { expanded: true })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Changed files" }))
      .getByRole("button", { name: /src\/new-file.ts/ })).toHaveAttribute("data-current", "true");
    expect(router.state.location.href).toBe(before);

    await user.click(within(section).getByRole("button", { expanded: true }));
    expect(within(section).getByRole("button", { expanded: false })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "the new file" }));
    await waitFor(() => {
      const refreshedSection = screen.getAllByTestId("session-change-section")
        .find((node) => node.textContent?.includes("src/new-file.ts"))!;
      expect(within(refreshedSection).getByRole("button", { expanded: true })).toHaveFocus();
    });

    await user.click(within(screen.getByRole("group", { name: "Session surfaces" }))
      .getByRole("button", { name: "Files" }));
    await screen.findByRole("complementary", { name: "Files" });
    await user.click(screen.getByRole("link", { name: "the new file" }));
    await screen.findByRole("complementary", { name: "Changes" });
    const readsBeforeWeb = reads;
    expect(fireEvent.click(screen.getByRole("link", { name: "website" }))).toBe(true);
    expect(reads).toBe(readsBeforeWeb);

    // A late read from the previous Session must not steal the new Session's Dock.
    await user.click(within(screen.getByRole("group", { name: "Session surfaces" }))
      .getByRole("button", { name: "Files" }));
    let releaseRead!: () => void;
    pendingRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    fireEvent.click(screen.getByRole("link", { name: "the new file" }));
    await waitFor(() => expect(reads).toBe(readsBeforeWeb + 1));
    await user.click(await findSidebarSessionRow("03 · 无变更与空目录"));
    await waitFor(() => expect(reads).toBe(readsBeforeWeb + 2));
    await act(async () => { releaseRead(); await pendingRead; });
    expect(screen.getByRole("complementary", { name: "Files" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Changes" })).not.toBeInTheDocument();
  });

  it("keeps the rail badge empty when the working tree cannot be read", async () => {
    const user = userEvent.setup();
    setDockedLayout(true);

    renderProjectSessions();

    await user.click(await screen.findByRole("button", { name: "Session dock" }));

    const aside = await screen.findByRole("complementary", { name: "Changes" });

    expect(await within(aside).findByRole("alert")).toHaveTextContent(
      "unavailable outside Electron",
    );
    expect(
      within(screen.getByRole("group", { name: "Session surfaces" })).queryByText(
        /^\d+$/,
      ),
    ).not.toBeInTheDocument();
  });

  it("shows a Chat draft when the Project Registry is empty", async () => {
    ensureSessionDraft("chat");
    renderProjectSessions("/projects/chat/sessions?view=draft", { seedProjects: false });

    expect(await screen.findByTestId("empty-workspace-state")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Chat without a project" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No Projects" })).not.toBeInTheDocument();
    expect(screen.getByTestId("project-picker-trigger")).toHaveTextContent("No project");
  });

  it("redirects an empty registry off a missing Project route to the Chat draft", async () => {
    const { router } = renderProjectSessions("/projects/gone/sessions?view=draft", {
      seedProjects: false,
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/projects/chat/sessions");
      expect(router.state.location.search).toMatchObject({ view: "draft" });
    });
    expect(screen.queryByTestId("project-not-found-state")).not.toBeInTheDocument();
    expect(await screen.findByTestId("empty-workspace-state")).toBeInTheDocument();
  });

  it("does not mark a populated Chat workspace as the empty workspace state", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_session_projections") {
        return [
          {
            sessionId: "session-chat-1",
            runtimeId: "pi-sdk:session-chat-1",
            piSessionId: "pi-session-chat-1",
            projectId: "chat",
            initialPrompt: "What is a monad?",
            cwd: "/tmp/pigui-chats/session-chat-1",
            status: "completed",
            updatedAt: "2026-09-07T12:00:00.000Z",
          },
        ];
      }

      throw new Error(`unexpected backend command ${command}`);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };

    renderProjectSessions("/projects/chat/sessions", { seedProjects: false });

    expect(await screen.findByRole("button", { name: "Session dock" })).toBeInTheDocument();
    expect(screen.queryByTestId("empty-workspace-state")).not.toBeInTheDocument();
    expect(screen.queryByTestId("project-not-found-state")).not.toBeInTheDocument();
  });

  it("does not query session changes for a Chat session", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_session_projections") {
        return [
          {
            sessionId: "session-chat-1",
            runtimeId: "pi-sdk:session-chat-1",
            piSessionId: "pi-session-chat-1",
            projectId: "chat",
            initialPrompt: "What is a monad?",
            cwd: "/tmp/pigui-chats/session-chat-1",
            status: "completed",
            updatedAt: "2026-09-07T12:00:00.000Z",
          },
        ];
      }

      if (command === "get_session_changes") {
        throw new Error("Chat sessions must not probe git");
      }

      throw new Error(`unexpected backend command ${command}`);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };

    renderProjectSessions("/projects/chat/sessions", { seedProjects: false });

    expect(await screen.findByRole("button", { name: "Session dock" })).toBeInTheDocument();
    expect(
      invoke.mock.calls.filter(([command]) => command === "get_session_changes"),
    ).toHaveLength(0);
  });

  it("renders an Electron Project with zero Sessions without fixture data", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_session_projections") {
        return [];
      }

      throw new Error(`unexpected backend command ${command}`);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };

    const { container } = renderProjectSessions();

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("list_session_projections", undefined);
    });
    expect(await screen.findByTestId("project-sessions-view")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Session dock" })).not.toBeInTheDocument();
    expect(screen.queryByText("Agent Workspace shell")).not.toBeInTheDocument();
    expect(screen.queryByText("Usage evidence review")).not.toBeInTheDocument();
    expect(screen.queryByText("Create the Agent Workspace entry shape for this Project.")).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain("session-control-plane-shell");
    expect(container.innerHTML).not.toContain("session-usage-review");
  });

  it("loads sidebar history from persisted Session Projections in Electron", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_session_projections") {
        return [
          {
            sessionId: "persisted-session-1",
            runtimeId: "pi-sdk:persisted-session-1",
            piSessionId: "pi-session-persisted-1",
            projectId: pigProjectPath,
            initialPrompt: "Persisted cold session",
            cwd: pigProjectPath,
            status: "idle",
            updatedAt: "2026-07-03T10:00:00.000Z",
          },
        ];
      }

      throw new Error(`unexpected backend command ${command}`);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };

    renderProjectSessions();

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("list_session_projections", undefined);
    });
    expect(await findSidebarSessionRow("Persisted cold session")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("list_sessions", expect.anything());
  });

  it("reloads projections and history for the selected Session after backend recovery", async () => {
    const backendListeners: Array<(event: BackendRpcEvent) => void> = [];
    const persisted = {
      sessionId: "persisted-session-1",
      runtimeId: "pi-sdk:persisted-session-1",
      piSessionId: "pi-session-persisted-1",
      projectId: pigProjectPath,
      initialPrompt: "Recover this session",
      cwd: pigProjectPath,
      status: "idle",
      sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-persisted-1.jsonl",
      checkout: {
        mode: "foreground-local",
        root: pigProjectPath,
        runtimeCwd: pigProjectPath,
      },
      updatedAt: "2026-07-18T12:00:00.000Z",
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_session_projections") {
        return [persisted];
      }

      if (command === "get_runtime_snapshot") {
        return {
          ...persisted,
          events: [],
        };
      }

      throw new Error(`unexpected backend command ${command}`);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn((listener) => {
        backendListeners.push(listener);
        return vi.fn();
      }),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };

    renderProjectSessions();

    await waitFor(() => {
      expect(
        invoke.mock.calls.filter(([command]) => command === "get_runtime_snapshot"),
      ).toHaveLength(1);
    });

    backendListeners[0]?.({
      type: "event",
      event: {
        id: "backend-connected-2",
        seq: 0,
        sessionId: "__backend__",
        piSessionId: "__backend__",
        type: "status",
        ts: "2026-07-18T12:01:00.000Z",
        payload: {
          kind: "status",
          lifecycle: "connected",
          title: "Backend connected",
          body: "Pace backend utility process is connected.",
        },
      },
    });

    await waitFor(() => {
      expect(
        invoke.mock.calls.filter(([command]) => command === "list_session_projections"),
      ).toHaveLength(2);
      expect(
        invoke.mock.calls.filter(([command]) => command === "get_runtime_snapshot"),
      ).toHaveLength(2);
    });
  });

  it("loads a selected persisted Session without resuming execution", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_session_projections") {
        return [
          {
            sessionId: "persisted-session-1",
            runtimeId: "pi-sdk:persisted-session-1",
            piSessionId: "pi-session-persisted-1",
            projectId: pigProjectPath,
            initialPrompt: "Persisted cold session",
            cwd: pigProjectPath,
            status: "idle",
            sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-persisted-1.jsonl",
            checkout: {
              mode: "foreground-local",
              root: pigProjectPath,
              runtimeCwd: pigProjectPath,
            },
            updatedAt: "2026-07-03T10:00:00.000Z",
          },
        ];
      }

      if (command === "get_runtime_snapshot") {
        return {
          sessionId: "persisted-session-1",
          runtimeId: "pi-sdk:persisted-session-1",
          piSessionId: "pi-session-persisted-1",
          projectId: pigProjectPath,
          cwd: pigProjectPath,
          status: "idle",
          sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-persisted-1.jsonl",
          events: [
            {
              id: "evt-existing-user",
              seq: 1,
              sessionId: "persisted-session-1",
              piSessionId: "pi-session-persisted-1",
              type: "message_update",
              ts: "2026-07-03T10:00:01.000Z",
              payload: {
                kind: "message",
                role: "user",
                body: "Existing history",
              },
            },
          ],
          updatedAt: "2026-07-03T10:00:01.000Z",
        };
      }

      throw new Error(`unexpected backend command ${command}`);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };

    renderProjectSessions();

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("get_runtime_snapshot", {
        sessionId: "persisted-session-1",
        piSessionId: "pi-session-persisted-1",
      });
    });
    expect(await screen.findByText("Existing history")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("resume_session", expect.anything());
  });

  it("loads journal history even when the Pi context file is missing", async () => {
    const user = userEvent.setup();
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_session_projections") {
        return [
          {
            sessionId: "persisted-session-1",
            runtimeId: "pi-sdk:persisted-session-1",
            piSessionId: "pi-session-persisted-1",
            projectId: pigProjectPath,
            initialPrompt: "Missing session file",
            cwd: pigProjectPath,
            status: "idle",
            sessionFileMissing: true,
            updatedAt: "2026-07-03T10:00:00.000Z",
          },
        ];
      }

      if (command === "get_runtime_snapshot") {
        return { sessionId: "persisted-session-1", piSessionId: "pi-session-persisted-1", runtimeId: "runtime",
          projectId: pigProjectPath, cwd: pigProjectPath, executionState: "cold", status: "completed",
          events: [{ id: "history", seq: 1, sessionId: "persisted-session-1", piSessionId: "pi-session-persisted-1",
            type: "message_update", ts: "2026-07-03T10:00:00.000Z", payload: { kind: "message", role: "assistant", body: "Saved answer without Pi file" } }],
          updatedAt: "2026-07-03T10:00:00.000Z" };
      }
      if (command === "send_prompt") throw new Error("Pi session file is missing");

      throw new Error(`unexpected backend command ${command}`);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };

    renderProjectSessions();

    expect(await screen.findByText("Saved answer without Pi file")).toBeInTheDocument();
    expect(screen.queryByTestId("runtime-fallback-banner")).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText("What do you want to know?");
    await user.type(input, "Continue");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Pi session file is missing")).toBeInTheDocument();
    expect(input).toHaveValue("Continue");
    expect(invoke).not.toHaveBeenCalledWith("resume_session", expect.anything());
  });

  it("allows a failed history read to be retried for the same selected Session", async () => {
    const user = userEvent.setup();
    let resumeCalls = 0;
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_session_projections") {
        return [
          {
            sessionId: "persisted-session-1",
            runtimeId: "pi-sdk:persisted-session-1",
            piSessionId: "pi-session-persisted-1",
            projectId: pigProjectPath,
            initialPrompt: "Retry cold resume",
            cwd: pigProjectPath,
            status: "idle",
            sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-persisted-1.jsonl",
            checkout: {
              mode: "foreground-local",
              root: pigProjectPath,
              runtimeCwd: pigProjectPath,
            },
            updatedAt: "2026-07-03T10:00:00.000Z",
          },
        ];
      }

      if (command === "get_runtime_snapshot") {
        resumeCalls += 1;

        if (resumeCalls === 1) {
          throw new Error("Journal read failed");
        }

        return {
          sessionId: "persisted-session-1",
          runtimeId: "pi-sdk:persisted-session-1",
          piSessionId: "pi-session-persisted-1",
          projectId: pigProjectPath,
          cwd: pigProjectPath,
          status: "idle",
          sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-persisted-1.jsonl",
          events: [],
          updatedAt: "2026-07-03T10:00:01.000Z",
        };
      }

      throw new Error(`unexpected backend command ${command}`);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };

    renderProjectSessions();

    expect(await screen.findByTestId("runtime-fallback-banner")).toHaveTextContent(
      "Journal read failed",
    );

    const snapshotReads = () =>
      invoke.mock.calls.filter(([command]) => command === "get_runtime_snapshot").length;
    const readsBeforeRetry = snapshotReads();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    // Retry must issue a fresh history read. The exact count is protected by
    // the Session Projections store's history tests; this end-to-end path
    // only asserts the fresh read.
    await waitFor(() => {
      expect(snapshotReads()).toBeGreaterThan(readsBeforeRetry);
    });
  });

  it("uses browser development Project data for plain-browser draft debugging", async () => {
    (
      window as typeof window & {
        __PACE_ENABLE_BROWSER_DEVELOPMENT_MOCKS__?: boolean;
      }
    ).__PACE_ENABLE_BROWSER_DEVELOPMENT_MOCKS__ = true;

    renderProjectSessions("/projects/pig/sessions?view=draft", {
      seedProjects: false,
    });

    const draftComposer = await screen.findByTestId("session-draft-composer");
    const projectPickerTrigger = screen.getByTestId("project-picker-trigger");

    expect(getProjectHeaderRowByName("Pig")).toBeInTheDocument();
    expect(screen.queryByTestId("empty-workspace-state")).not.toBeInTheDocument();
    expect(within(draftComposer).getByPlaceholderText("Do anything with Pi")).toHaveValue("");
    expect(projectPickerTrigger).toHaveTextContent("Pig");
    expect(getSessionDraft()).toBeNull();
    expect(window.localStorage.getItem("pigui.projectRegistry.v1")).toBeNull();

    delete (
      window as typeof window & {
        __PACE_ENABLE_BROWSER_DEVELOPMENT_MOCKS__?: boolean;
      }
    ).__PACE_ENABLE_BROWSER_DEVELOPMENT_MOCKS__;
  });

  it("exposes the Terminal surface on the rail, without file tree or abort placeholders", async () => {
    const user = userEvent.setup();
    setDockedLayout(true);

    renderProjectSessions();

    const sessionsView = await screen.findByTestId("project-sessions-view");

    expect(within(sessionsView).queryByText(/file tree|file explorer/i)).not.toBeInTheDocument();
    expect(within(sessionsView).queryByText("Abort")).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Session dock" }));

    const rail = await screen.findByRole("group", { name: "Session surfaces" });
    const terminalToggle = within(rail).getByRole("button", { name: "Terminal" });

    expect(terminalToggle).toBeInTheDocument();

    // Outside Electron the panel degrades to its calm empty state, no crash.
    await user.click(terminalToggle);

    expect(
      await screen.findByRole("complementary", { name: "Terminal" }),
    ).toBeInTheDocument();
  });

  it("stops the selected active run from the composer", async () => {
    const user = userEvent.setup();

    renderProjectSessions();

    const liveColumn = await screen.findByTestId("live-session-column");

    // Session hydration settles asynchronously after the column mounts.
    expect(
      await within(liveColumn).findByRole("button", { name: "Stop" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("navbar-actions")).queryByRole("button", { name: "Stop" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Abort")).not.toBeInTheDocument();

    await user.click(within(liveColumn).getByRole("button", { name: "Stop" }));

    const liveChat = await screen.findByLabelText("Live Chat messages");

    await waitFor(() => {
      expect(within(liveColumn).queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    });
    expect(within(liveChat).queryByText("Stopped")).not.toBeInTheDocument();
    expect(
      within(liveChat).queryByText("Pi stopped the active run."),
    ).not.toBeInTheDocument();
  });

  it.each([pigProjectPath, studyProjectPath])(
    "shows the branch selector after creating a draft Session in %s without selecting its sidebar row",
    async (targetProjectId) => {
      const user = userEvent.setup();
      addProjectToRegistry(targetProjectId);
      saveSessionDraft(targetProjectId, "Show the branch after creation");
      const loadChanges = vi.spyOn(sessionsApi, "getSessionChanges").mockImplementation(
        async (sessionId) => ({
          sessionId,
          state: "ready",
          checkoutRoot: targetProjectId,
          repositoryRoot: targetProjectId,
          generatedAt: "2026-09-07T08:00:00.000Z",
          head: { oid: "abc1234", branch: "main", detached: false },
          branches: ["main"],
          files: [],
          totals: { files: 0, additions: 0, deletions: 0, binaryFiles: 0, conflictedFiles: 0 },
          truncated: false,
          omittedFileCount: 0,
        }),
      );

      try {
        const { router } = renderProjectSessions("/projects/pig/sessions?view=draft&settings=models");
        await screen.findByTestId("session-draft-composer");
        expect(loadChanges).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Send" }));

        expect(await screen.findByTestId("git-branch-status-trigger")).toHaveTextContent("main");
        expect(screen.getByLabelText("Live Chat messages")).toHaveTextContent("Show the branch after creation");
        expect(screen.queryByTestId("session-draft-composer")).not.toBeInTheDocument();
        expect(getSessionDraft()).toBeNull();
        expect(router.state.location.search).toEqual({ settings: "models" });
        expect(router.state.location.pathname).toBe(`/projects/${encodeURIComponent(targetProjectId)}/sessions`);
        expect(loadChanges).toHaveBeenCalledTimes(1);
        const sessionRow = await findSidebarSessionRow("Show the branch after creation");
        expect(sessionRow).toHaveAttribute("aria-current", "page");
      } finally {
        loadChanges.mockRestore();
      }
    },
  );

  it("shows the branch after worktree creation and runtime binding without reselecting the Session", async () => {
    const user = userEvent.setup();
    addProjectToRegistry(pigProjectPath);
    saveSessionDraft(pigProjectPath, "Work in a new worktree");
    let releaseWorktree = () => {};
    let releaseRuntime = () => {};
    let runtimeStarted = false;
    let runtimeReady = false;
    const worktreeGate = new Promise<void>((resolve) => { releaseWorktree = resolve; });
    const runtimeGate = new Promise<void>((resolve) => { releaseRuntime = resolve; });
    const gitClientSpy = vi.spyOn(checkoutClientModule, "createInvokeExecutionCheckoutGitClient")
      .mockReturnValue({
        isGitRepository: async () => true,
        addDetachedWorktree: async () => { await worktreeGate; },
      });
    const createBridge = inMemoryBridgeModule.createInMemoryPiRuntimeBridge;
    const bridgeSpy = vi.spyOn(inMemoryBridgeModule, "createInMemoryPiRuntimeBridge")
      .mockImplementation((options) => {
        const bridge = createBridge(options);
        return {
          ...bridge,
          startRuntime: async (input) => {
            runtimeStarted = true;
            await runtimeGate;
            const runtime = await bridge.startRuntime(input);
            // create_session persists the backend projection before returning.
            runtimeReady = true;
            return runtime;
          },
        };
      });
    const loadChanges = vi.spyOn(sessionsApi, "getSessionChanges")
      .mockImplementation(async (sessionId) => {
        if (!runtimeReady) {
          throw new Error(`Session projection "${sessionId}" was not found.`);
        }
        return {
          sessionId,
          state: "ready",
          checkoutRoot: `/tmp/worktrees/${sessionId}`,
          repositoryRoot: `/tmp/worktrees/${sessionId}`,
          generatedAt: "2026-09-10T08:00:00.000Z",
          head: { oid: "abc1234", branch: null, detached: true },
          branches: ["main"],
          files: [],
          totals: { files: 0, additions: 0, deletions: 0, binaryFiles: 0, conflictedFiles: 0 },
          truncated: false,
          omittedFileCount: 0,
        };
      });

    try {
      const { router } = renderProjectSessions("/projects/pig/sessions?view=draft");
      await screen.findByTestId("session-draft-composer");
      await user.click(screen.getByTestId("checkout-strategy-trigger"));
      await user.click(await screen.findByRole("option", { name: /Git worktree/ }));
      await user.click(screen.getByRole("button", { name: "Send" }));

      expect(await screen.findByTestId("session-creation-status")).toHaveTextContent("preparing checkout");
      expect(router.state.location.search).toEqual({});
      expect(screen.getByPlaceholderText("Starting session…")).toBeDisabled();
      expect(runtimeStarted).toBe(false);
      expect(loadChanges).not.toHaveBeenCalled();

      await act(async () => { releaseWorktree(); });
      await waitFor(() => expect(runtimeStarted).toBe(true));
      expect(screen.getByPlaceholderText("Starting session…")).toBeDisabled();
      expect(loadChanges).not.toHaveBeenCalled();

      await act(async () => { releaseRuntime(); });
      await waitFor(() => expect(getSessionDraft()).toBeNull());
      expect(await screen.findByTestId("git-branch-status-trigger")).toHaveTextContent("abc1234");
      expect(loadChanges).toHaveBeenCalledTimes(1);
      expect(await findSidebarSessionRow("Work in a new worktree")).toHaveAttribute("aria-current", "page");
    } finally {
      releaseWorktree();
      releaseRuntime();
      gitClientSpy.mockRestore();
      bridgeSpy.mockRestore();
      loadChanges.mockRestore();
    }
  });

  it("hands the draft over to the Live Session before Pi accepts the initial prompt", async () => {
    const user = userEvent.setup();
    addProjectToRegistry(pigProjectPath);
    saveSessionDraft(pigProjectPath, "Hand over before accept");
    let releasePrompt = () => {};
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const createBridge = inMemoryBridgeModule.createInMemoryPiRuntimeBridge;
    // The real user-message boundary can be held back for seconds by Pi
    // extensions; the view must not wait for it.
    const bridgeSpy = vi
      .spyOn(inMemoryBridgeModule, "createInMemoryPiRuntimeBridge")
      .mockImplementation((options) => {
        const bridge = createBridge(options);

        return {
          ...bridge,
          sendInitialPrompt: async (input) => {
            await promptGate;
            return bridge.sendInitialPrompt(input);
          },
        };
      });

    try {
      const { router } = renderProjectSessions("/projects/pig/sessions?view=draft");
      await screen.findByTestId("session-draft-composer");

      await user.click(screen.getByRole("button", { name: "Send" }));

      await waitFor(() =>
        expect(screen.queryByTestId("session-draft-composer")).not.toBeInTheDocument(),
      );
      expect(router.state.location.search).toEqual({});
      expect(router.state.location.pathname).toBe(
        `/projects/${encodeURIComponent(pigProjectPath)}/sessions`,
      );
      expect(screen.getByLabelText("Live Chat messages")).toHaveTextContent(
        "Hand over before accept",
      );
      expect(screen.getByTestId("session-creation-status")).toHaveTextContent("sending prompt");
      expect(screen.getByTestId("live-session-column")).toHaveAttribute("data-draft-handoff");
      expect(screen.getByPlaceholderText("Starting session…")).toBeDisabled();
      expect(getSessionDraft()?.prompt).toBe("Hand over before accept");
      const sessionRow = await findSidebarSessionRow("Hand over before accept");
      expect(sessionRow).toHaveAttribute("aria-current", "page");

      releasePrompt();

      await waitFor(() => expect(getSessionDraft()).toBeNull());
      await waitFor(() =>
        expect(screen.queryByTestId("session-creation-status")).not.toBeInTheDocument(),
      );
      expect(screen.getByLabelText("Live Chat messages")).toHaveTextContent(
        "Hand over before accept",
      );
      expect(screen.getByPlaceholderText("Queue the next task…")).toBeInTheDocument();
    } finally {
      bridgeSpy.mockRestore();
    }
  });

  it("keeps the composer's Location row and model chip through the Draft → Live handoff", async () => {
    const user = userEvent.setup();
    addProjectToRegistry(pigProjectPath);
    saveSessionDraft(pigProjectPath, "Keep the composer in place");
    let releaseBinding = () => {};
    const promptGate = new Promise<void>((resolve) => {
      releaseBinding = resolve;
    });
    const createBridge = inMemoryBridgeModule.createInMemoryPiRuntimeBridge;
    // Hold the session before Pi binds it: that is the window where the old
    // composer dropped its footer line and its model chip.
    const bridgeSpy = vi
      .spyOn(inMemoryBridgeModule, "createInMemoryPiRuntimeBridge")
      .mockImplementation((options) => {
        const bridge = createBridge(options);

        return {
          ...bridge,
          createPiSessionState: async (input) => {
            await promptGate;
            return bridge.createPiSessionState(input);
          },
        };
      });

    try {
      renderProjectSessions("/projects/pig/sessions?view=draft");
      await screen.findByTestId("session-draft-composer");
      const draftModelChip = (await screen.findByTestId("model-thinking-trigger"))
        .textContent;

      await user.click(screen.getByRole("button", { name: "Send" }));

      const liveComposer = await screen.findByTestId("full-chat-composer");
      const composerShell = promptInputShellOf(liveComposer);
      const footer = await waitFor(() => {
        const row = liveComposer.querySelector<HTMLElement>(
          '[data-slot="prompt-input-footer"]',
        );

        if (!row) {
          throw new Error("the Live composer dropped its Location row");
        }

        return row;
      });

      expect(
        within(footer).getByTestId("composer-location-label"),
      ).toHaveTextContent("Project folder");
      expect(
        within(liveComposer).getByTestId("model-thinking-trigger"),
      ).toHaveTextContent(draftModelChip ?? "");
      // The ring flows from the moment the draft is handed over.
      expect(composerShell).toHaveAttribute("data-accent", "brand");
      expect(composerShell).toHaveAttribute("data-status", "submitted");

      releaseBinding();

      await waitFor(() => expect(getSessionDraft()).toBeNull());
      expect(
        liveComposer.querySelector('[data-slot="prompt-input-footer"]'),
      ).toBeInTheDocument();
    } finally {
      bridgeSpy.mockRestore();
    }
  });

  it("stops the composer ring once the Session is idle", async () => {
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:12:00.000Z",
    });
    const projection = applySessionProjectionEvent(
      applySessionProjectionEvent(
        createSessionProjection({
          id: "settled-session",
          projectId: "pig-docs",
          initialPrompt: "Review the first result",
          createdAt: "2026-06-26T08:00:00.000Z",
        }),
        {
          type: "runtime-bound",
          stage: "starting runtime",
          runtimeId: "runtime-settled",
          piSessionId: "pi-session-settled",
          occurredAt: "2026-06-26T08:00:01.000Z",
        },
      ),
      {
        type: "runtime-state-resynced",
        state: {
          piSessionId: "pi-session-settled",
          runtimeId: "runtime-settled",
          projectId: "pig-docs",
          cwd: "/Users/void/code/opensource/Pig/docs",
          status: "idle",
          events: [],
          updatedAt: "2026-06-26T08:00:03.000Z",
        },
      },
    );

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        runtimeBridge={bridge}
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "settled-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    const composerShell = promptInputShellOf(
      await screen.findByTestId("full-chat-composer"),
    );

    expect(composerShell).toHaveAttribute("data-accent", "brand");
    expect(composerShell).toHaveAttribute("data-status", "ready");
  });

  describe("composer Location row", () => {
    const docsWorkspace: ComponentProps<
      typeof AgentWorkspaceSessionsView
    >["workspace"] = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-docs-review",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "gpt-5-codex",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };

    function projectGitLoader(branch: string | null, branches: string[] = []) {
      return vi.fn(async (projectRoot: string) => ({
        projectRoot,
        branch,
        branches,
      }));
    }

    it("names where a Session Draft would run and which branch it would start on", async () => {
      const user = userEvent.setup();
      const loadProjectGitSummary = projectGitLoader("main", ["main", "feat/location-row"]);
      saveSessionDraft("pig-docs", "Draft the Location row");

      render(
        <FixtureSessionsView
          projectId="pig-docs"
          showDraft
          loadProjectGitSummary={loadProjectGitSummary}
          workspace={docsWorkspace}
        />,
      );

      await screen.findByTestId("session-draft-composer");
      const footer = footerOf("session-draft-composer");

      expect(within(footer).getByTestId("checkout-strategy-trigger")).toHaveTextContent(
        "Project folder",
      );
      expect(
        await within(footer).findByTestId("git-branch-status-trigger"),
      ).toHaveTextContent("main");
      expect(loadProjectGitSummary).toHaveBeenCalledWith(
        "/Users/void/code/opensource/Pig/docs",
      );

      // A worktree is cut from a base branch instead of moving the folder onto one.
      await user.click(within(footer).getByTestId("checkout-strategy-trigger"));
      await user.click(await screen.findByRole("option", { name: /Git worktree/ }));

      expect(within(footer).getByTestId("git-branch-status-trigger")).toHaveTextContent(
        "from main",
      );
    });

    it("cuts a worktree from the chosen base branch without moving the Project folder", async () => {
      const user = userEvent.setup();
      const invokeSpy = vi.spyOn(runtimeModule, "invoke");
      onTestFinished(() => invokeSpy.mockRestore());
      const sessionCreator = vi.fn(
        async (input: Parameters<NonNullable<ComponentProps<typeof AgentWorkspaceSessionsView>["sessionCreator"]>>[0]) =>
          createSessionFromDraft({
            ...input,
            bridge: createInMemoryPiRuntimeBridge({
              now: () => "2026-06-26T08:00:03.000Z",
            }),
            idFactory: () => "session-base-branch",
            now: () => "2026-06-26T08:00:00.000Z",
          }),
      );
      saveSessionDraft("pig-docs", "Start from the feature branch");

      render(
        <FixtureSessionsView
          projectId="pig-docs"
          showDraft
          loadProjectGitSummary={projectGitLoader("main", ["main", "feat/location-row"])}
          workspace={docsWorkspace}
          sessionCreator={sessionCreator}
        />,
      );

      await screen.findByTestId("session-draft-composer");
      const footer = footerOf("session-draft-composer");
      await within(footer).findByTestId("git-branch-status-trigger");
      await user.click(within(footer).getByTestId("checkout-strategy-trigger"));
      await user.click(await screen.findByRole("option", { name: /Git worktree/ }));
      await user.click(within(footer).getByTestId("git-branch-status-trigger"));
      await user.click(await screen.findByRole("option", { name: "feat/location-row" }));

      expect(within(footer).getByTestId("git-branch-status-trigger")).toHaveTextContent(
        "from feat/location-row",
      );
      expect(getSessionDraft()?.baseRef).toBe("feat/location-row");
      // Picking a base only sets the draft; the Project folder stays put.
      expect(invokeSpy).not.toHaveBeenCalledWith(
        "checkout_project_branch",
        expect.anything(),
      );

      await user.click(screen.getByRole("button", { name: "Send" }));

      await waitFor(() => expect(sessionCreator).toHaveBeenCalled());
      expect(sessionCreator.mock.calls[0]?.[0].draft.baseRef).toBe("feat/location-row");
      const liveFooter = await waitFor(() => footerOf("full-chat-composer"));
      expect(
        within(liveFooter).getByTestId("composer-branch-label"),
      ).toHaveTextContent("from feat/location-row");
    });

    it("shows the Chat workspace as a Location without asking Git for a branch", async () => {
      const loadProjectGitSummary = projectGitLoader("main", ["main"]);
      saveSessionDraft("chat", "Draft a chat");

      render(
        <FixtureSessionsView
          projectId="chat"
          showDraft
          loadProjectGitSummary={loadProjectGitSummary}
          workspace={docsWorkspace}
        />,
      );

      await screen.findByTestId("session-draft-composer");
      const footer = footerOf("session-draft-composer");

      expect(within(footer).getByTestId("composer-location-label")).toHaveTextContent(
        "Chat",
      );
      expect(
        within(footer).queryByTestId("git-branch-status-trigger"),
      ).not.toBeInTheDocument();
      expect(
        within(footer).queryByTestId("composer-branch-label"),
      ).not.toBeInTheDocument();
      expect(loadProjectGitSummary).not.toHaveBeenCalled();
    });

    it("keeps the draft Location and branch while the Session is being created", async () => {
      const user = userEvent.setup();
      const loadProjectGitSummary = projectGitLoader("main", ["main"]);
      saveSessionDraft("pig-docs", "Carry the Location row over");

      render(
        <FixtureSessionsView
          projectId="pig-docs"
          showDraft
          loadProjectGitSummary={loadProjectGitSummary}
          workspace={docsWorkspace}
          sessionCreator={(input) =>
            createSessionFromDraft({
              ...input,
              bridge: createInMemoryPiRuntimeBridge({
                now: () => "2026-06-26T08:00:03.000Z",
              }),
              idFactory: () => "session-location-row",
              now: () => "2026-06-26T08:00:00.000Z",
            })
          }
        />,
      );

      await within(footerOf("session-draft-composer")).findByTestId(
        "git-branch-status-trigger",
      );
      await user.click(screen.getByRole("button", { name: "Send" }));

      const liveFooter = await waitFor(() => footerOf("full-chat-composer"));
      const location = within(liveFooter).getByTestId("composer-location-label");

      // Frozen once the Session exists: same words, no longer a control.
      expect(location).toHaveTextContent("Project folder");
      expect(location.closest("button")).toBeNull();
      // Git has not answered for the new checkout yet; the row keeps the
      // branch the draft showed instead of blanking.
      expect(
        within(liveFooter).getByTestId("composer-branch-label"),
      ).toHaveTextContent("main");
    });

    it("re-reads the branch when the Session Draft changes Project", async () => {
      const user = userEvent.setup();
      addProjectToRegistry(pigProjectPath, { now: () => "2026-06-30T08:00:00.000Z" });
      addProjectToRegistry(studyProjectPath, { now: () => "2026-06-30T09:00:00.000Z" });
      const loadProjectGitSummary = vi.fn(async (projectRoot: string) => ({
        projectRoot,
        branch: projectRoot === studyProjectPath ? "study/main" : "main",
        branches: [projectRoot === studyProjectPath ? "study/main" : "main"],
      }));
      saveSessionDraft(pigProjectPath, "Retarget the Location row");

      render(
        <FixtureSessionsView
          projectId={pigProjectPath}
          showDraft
          loadProjectGitSummary={loadProjectGitSummary}
          workspace={{ ...docsWorkspace, id: pigProjectPath, projectRoot: pigProjectPath }}
        />,
      );

      const footer = footerOf("session-draft-composer");

      expect(
        await within(footer).findByTestId("git-branch-status-trigger"),
      ).toHaveTextContent("main");

      await chooseProjectFromPicker(user, "study");

      expect(
        await within(footer).findByTestId("git-branch-status-trigger"),
      ).toHaveTextContent("study/main");
    });

    it("forgets the chosen base branch when the Session Draft changes Project", async () => {
      const user = userEvent.setup();
      addProjectToRegistry(pigProjectPath, { now: () => "2026-06-30T08:00:00.000Z" });
      addProjectToRegistry(studyProjectPath, { now: () => "2026-06-30T09:00:00.000Z" });
      const loadProjectGitSummary = vi.fn(async (projectRoot: string) => ({
        projectRoot,
        branch: "main",
        branches: projectRoot === studyProjectPath ? ["main"] : ["main", "feature"],
      }));
      saveSessionDraft(pigProjectPath, "Retarget the base branch");

      render(
        <FixtureSessionsView
          projectId={pigProjectPath}
          showDraft
          loadProjectGitSummary={loadProjectGitSummary}
          workspace={{ ...docsWorkspace, id: pigProjectPath, projectRoot: pigProjectPath }}
        />,
      );

      const footer = footerOf("session-draft-composer");
      await within(footer).findByTestId("git-branch-status-trigger");
      await user.click(within(footer).getByTestId("checkout-strategy-trigger"));
      await user.click(await screen.findByRole("option", { name: /Git worktree/ }));
      await user.click(within(footer).getByTestId("git-branch-status-trigger"));
      await user.click(await screen.findByRole("option", { name: "feature" }));
      expect(within(footer).getByTestId("git-branch-status-trigger")).toHaveTextContent(
        "from feature",
      );

      await chooseProjectFromPicker(user, "study");

      await waitFor(() =>
        expect(loadProjectGitSummary).toHaveBeenCalledWith(studyProjectPath),
      );
      expect(
        await within(footer).findByTestId("git-branch-status-trigger"),
      ).toHaveTextContent("from main");
      expect(getSessionDraft()?.baseRef).toBeUndefined();
    });
  });

  it("keeps background events from a created Session out of an unsent Session Draft", async () => {
    const user = userEvent.setup();
    addProjectToRegistry(pigProjectPath);
    saveSessionDraft(pigProjectPath, "Keep the first session updating");
    const listeners = new Map<string, Set<(event: PiRuntimeEvent) => void>>();
    let firstPiSessionId = "";
    const createBridge = inMemoryBridgeModule.createInMemoryPiRuntimeBridge;
    const bridgeSpy = vi
      .spyOn(inMemoryBridgeModule, "createInMemoryPiRuntimeBridge")
      .mockImplementation((options) => {
        const bridge = createBridge(options);
        return {
          ...bridge,
          sendInitialPrompt: async (input) => {
            firstPiSessionId = input.piSessionId;
            return bridge.sendInitialPrompt(input);
          },
          subscribeToEvents: (piSessionId, listener) => {
            const sessionListeners = listeners.get(piSessionId) ?? new Set();
            sessionListeners.add(listener);
            listeners.set(piSessionId, sessionListeners);
            return () => { sessionListeners.delete(listener); };
          },
        };
      });
    onTestFinished(() => bridgeSpy.mockRestore());

    const { router } = renderProjectSessions("/projects/pig/sessions?view=draft");
    await screen.findByTestId("session-draft-composer");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(getSessionDraft()).toBeNull());
    expect(await screen.findByLabelText("Live Chat messages")).toHaveTextContent(
      "Keep the first session updating",
    );

    await user.click(screen.getByRole("button", { name: "New Chat for Pig" }));
    const draftInput = await screen.findByPlaceholderText("Do anything with Pi");
    fireEvent.change(draftInput, { target: { value: "This draft is not sent" } });
    expect(screen.queryByTestId("session-creation-status")).not.toBeInTheDocument();

    act(() => {
      for (const listener of listeners.get(firstPiSessionId) ?? []) {
        listener({
          id: "background-answer",
          piSessionId: firstPiSessionId,
          kind: "message",
          role: "assistant",
          body: "The first session kept working in the background.",
          timestamp: "2026-09-11T10:00:00.000Z",
        });
      }
    });

    expect(screen.queryByTestId("session-creation-status")).not.toBeInTheDocument();
    expect(draftInput).toHaveValue("This draft is not sent");
    expect(router.state.location.search).toEqual({ view: "draft" });

    await user.click(await findSidebarSessionRow("Keep the first session updating"));
    await waitFor(() =>
      expect(screen.getByLabelText("Live Chat messages")).toHaveTextContent(
        "The first session kept working in the background.",
      ),
    );
  });

  it("keeps a viewed completed Session selected while a created Session runs in the background", async () => {
    const user = userEvent.setup();
    addProjectToRegistry(pigProjectPath);
    saveSessionDraft(pigProjectPath, "Running session that keeps working");
    const listeners = new Map<string, Set<(event: PiRuntimeEvent) => void>>();
    let runningPiSessionId = "";
    const createBridge = inMemoryBridgeModule.createInMemoryPiRuntimeBridge;
    const bridgeSpy = vi
      .spyOn(inMemoryBridgeModule, "createInMemoryPiRuntimeBridge")
      .mockImplementation((options) => {
        const bridge = createBridge(options);

        return {
          ...bridge,
          sendInitialPrompt: async (input) => {
            runningPiSessionId = input.piSessionId;
            return bridge.sendInitialPrompt(input);
          },
          subscribeToEvents: (piSessionId, listener) => {
            const sessionListeners = listeners.get(piSessionId) ?? new Set();
            sessionListeners.add(listener);
            listeners.set(piSessionId, sessionListeners);
            return () => {
              sessionListeners.delete(listener);
            };
          },
        };
      });
    onTestFinished(() => bridgeSpy.mockRestore());

    renderProjectSessions("/projects/pig/sessions?view=draft");
    await screen.findByTestId("session-draft-composer");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const runningRow = await findSidebarSessionRow("Running session that keeps working");
    await waitFor(() => expect(runningRow).toHaveAttribute("aria-current", "page"));

    const completedRow = await findSidebarSessionRow("Usage evidence review");
    await user.click(completedRow);
    await waitFor(() =>
      expect(completedRow).toHaveAttribute("aria-current", "page"),
    );

    act(() => {
      for (const listener of listeners.get(runningPiSessionId) ?? []) {
        listener({
          id: "background-progress",
          piSessionId: runningPiSessionId,
          kind: "message",
          role: "assistant",
          body: "Still working in the background.",
          timestamp: "2026-09-12T10:00:00.000Z",
        });
      }
    });

    // Background events must update the running Session's projection without
    // reclaiming the Live Chat from the Session the user is viewing.
    expect(completedRow).toHaveAttribute("aria-current", "page");
    expect(runningRow).not.toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("Live Chat messages")).not.toHaveTextContent(
      "Still working in the background.",
    );

    await user.click(runningRow);
    await waitFor(() =>
      expect(screen.getByLabelText("Live Chat messages")).toHaveTextContent(
        "Still working in the background.",
      ),
    );
  });

  it("shows a failed Session Creation in the Live Session and reopens the kept draft", async () => {
    const user = userEvent.setup();
    addProjectToRegistry(pigProjectPath);
    saveSessionDraft(pigProjectPath, "Fail after handoff");
    const createBridge = inMemoryBridgeModule.createInMemoryPiRuntimeBridge;
    const bridgeSpy = vi
      .spyOn(inMemoryBridgeModule, "createInMemoryPiRuntimeBridge")
      .mockImplementation((options) =>
        createBridge({
          ...options,
          failAt: "send-initial-prompt",
          failureMessage: "Pi rejected the initial prompt",
        }),
      );

    try {
      const { router } = renderProjectSessions("/projects/pig/sessions?view=draft");
      await screen.findByTestId("session-draft-composer");

      await user.click(screen.getByRole("button", { name: "Send" }));

      const failure = await screen.findByTestId("session-creation-failure");
      expect(failure).toHaveTextContent("Session creation failed");
      expect(failure).toHaveTextContent("sending prompt");
      expect(failure).toHaveTextContent("Pi rejected the initial prompt");
      expect(screen.queryByTestId("session-draft-composer")).not.toBeInTheDocument();
      expect(screen.queryByTestId("full-chat-composer")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Live Chat messages")).toHaveTextContent("Fail after handoff");
      expect(getSessionDraft()?.prompt).toBe("Fail after handoff");

      await user.click(within(failure).getByRole("button", { name: "Back to draft" }));

      expect(await screen.findByTestId("session-draft-composer")).toBeInTheDocument();
      expect(router.state.location.search).toEqual({ view: "draft" });
      expect(screen.getByPlaceholderText("Do anything with Pi")).toHaveValue("Fail after handoff");
    } finally {
      bridgeSpy.mockRestore();
    }
  });

  it("stops a draft-created Session without appending a runtime status message", async () => {
    const user = userEvent.setup();

    renderProjectSessions();

    await user.click(await screen.findByRole("button", { name: "New Chat" }));
    await chooseProjectFromPicker(user, "Pig");
    fireEvent.change(await screen.findByPlaceholderText("Do anything with Pi"), {
      target: { value: "Create a draft-backed active Session" },
    });
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await within(screen.getByTestId("live-session-column")).findByRole("button", {
        name: "Stop",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Queue is the default while Pi is running."),
    ).not.toBeInTheDocument();

    await user.click(
      within(screen.getByTestId("live-session-column")).getByRole("button", { name: "Stop" }),
    );

    const liveChat = await screen.findByLabelText("Live Chat messages");

    await waitFor(() => {
      expect(
        within(screen.getByTestId("live-session-column")).queryByRole("button", {
          name: "Stop",
        }),
      ).not.toBeInTheDocument();
    });
    expect(within(liveChat).queryByText("Stopped")).not.toBeInTheDocument();
    expect(
      within(liveChat).queryByText("Pi stopped the active run."),
    ).not.toBeInTheDocument();
  });

  it("records stop failure in Live Chat without unlocking active archive", async () => {
    const user = userEvent.setup();
    const bridge = createInMemoryPiRuntimeBridge({
      failAt: "stop-run",
      failureMessage: "Pi rejected the stop request.",
    });
    let projection = applySessionProjectionEvent(
      createSessionProjection({
        id: "active-session",
        projectId: "pig-docs",
        initialPrompt: "Keep working on the live run",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime-active",
        piSessionId: "pi-session-active",
        occurredAt: "2026-06-26T08:00:01.000Z",
      },
    );

    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      stage: "accepted",
      event: {
        id: "runtime-event-active-user",
        piSessionId: "pi-session-active",
        kind: "message",
        role: "user",
        body: "Keep working on the live run",
        timestamp: "2026-06-26T08:00:02.000Z",
      },
    });

    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "active-session",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "gpt-5-codex",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    render(
      <FixtureSessionsView
        projectId="pig-docs"
        runtimeBridge={bridge}
        sessionProjection={projection}
        workspace={workspace}
      />,
    );

    await user.click(
      within(screen.getByTestId("live-session-column")).getByRole("button", { name: "Stop" }),
    );

    const liveChat = await screen.findByLabelText("Live Chat messages");

    expect(await within(liveChat).findByText("Stop failed")).toBeInTheDocument();
    expect(within(liveChat).getByText("Pi rejected the stop request.")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("live-session-column")).getByRole("button", { name: "Stop" }),
    ).toBeInTheDocument();
  });

  it("clears unread results after the selected Session content is rendered", async () => {
    const user = userEvent.setup();

    renderProjectSessions();

    const unreadRow = await findSidebarSessionRow("Trace boundary pass");

    expect(within(unreadRow).getByLabelText("Unread result")).toBeInTheDocument();

    await user.click(unreadRow);

    expect(
      within(screen.getByLabelText("Live Chat messages")).getByText("Trace boundary pass"),
    ).toBeInTheDocument();
    await waitFor(() => {
      const row = querySidebarSessionRow("Trace boundary pass");

      if (!row) {
        throw new Error("Session row not found: Trace boundary pass");
      }

      expect(within(row).queryByLabelText("Unread result")).not.toBeInTheDocument();
    });
  });

  it("does not leak implementation placeholder copy into the product UI", async () => {
    renderProjectSessions();

    const sessionsView = await screen.findByTestId("project-sessions-view");

    expect(
      within(sessionsView).queryByText(
        /fixture|slice|not connected|future slices|projection|CONTEXT\.md|PRD|ADR/i,
      ),
    ).not.toBeInTheDocument();
  });

  it("creates default Sessions through the runtime bridge factory instead of a fake bridge", () => {
    const createFakeBridge = inMemoryBridgeModule.createInMemoryPiRuntimeBridge;
    const fakeBridgeSpy = vi.spyOn(inMemoryBridgeModule, "createInMemoryPiRuntimeBridge");
    const factorySpy = vi
      .spyOn(runtimeFactoryModule, "createDefaultPiRuntimeBridge")
      .mockImplementation(() => createFakeBridge());
    onTestFinished(() => {
      fakeBridgeSpy.mockRestore();
      factorySpy.mockRestore();
    });

    render(<FixtureSessionsView projectId="pig" />);

    expect(factorySpy).toHaveBeenCalled();
    expect(fakeBridgeSpy).not.toHaveBeenCalled();
  });

  it("renders completion and failure results inside Live Chat", async () => {
    render(
      <FixtureSessionsView
        projectId="pig-results"
        workspace={{
          id: "pig-results",
          name: "Pig Results",
          projectRoot: "/Users/void/code/opensource/Pig",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "session-results",
          liveMessages: [
            {
              id: "message-completed",
              role: "assistant",
              body: "Run completed. Projection list now uses unread result state.",
            },
            {
              id: "message-failed",
              role: "assistant",
              body: "Run failed. The runtime stream disconnected.",
            },
          ],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    const liveChat = await screen.findByLabelText("Live Chat messages");

    expect(
      within(liveChat).getByText("Run completed. Projection list now uses unread result state."),
    ).toBeInTheDocument();
    expect(
      within(liveChat).getByText("Run failed. The runtime stream disconnected."),
    ).toBeInTheDocument();
  });

  it("queues default active-run input in a pending area without adding it to Live Chat", async () => {
    const user = userEvent.setup();
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:10:00.000Z",
    });
    let projection = applySessionProjectionEvent(
      createSessionProjection({
        id: "active-session",
        projectId: "pig-docs",
        initialPrompt: "Keep working on the live run",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime-active",
        piSessionId: "pi-session-active",
        occurredAt: "2026-06-26T08:00:01.000Z",
      },
    );

    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      stage: "accepted",
      event: {
        id: "runtime-event-active-user",
        piSessionId: "pi-session-active",
        kind: "message",
        role: "user",
        body: "Keep working on the live run",
        timestamp: "2026-06-26T08:00:02.000Z",
      },
    });
    await bridge.restoreSessionState({
      piSessionId: "pi-session-active",
      runtimeId: "runtime-active",
      projectId: "pig-docs",
      cwd: "/Users/void/code/opensource/Pig/docs",
      status: "running",
      events: projection.runtimeEvents,
      updatedAt: projection.updatedAt,
    });

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        runtimeBridge={bridge}
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "active-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    const liveChat = await screen.findByLabelText("Live Chat messages");
    const liveColumn = screen.getByTestId("live-session-column");

    expect(within(liveColumn).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    await user.type(
      screen.getByPlaceholderText("Queue the next task…"),
      "After this, update the queue tests.",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    const pendingQueue = await screen.findByTestId("queued-message-list");

    expect(
      within(pendingQueue).getByText("After this, update the queue tests."),
    ).toBeInTheDocument();
    // Pending rows carry their own routing actions while the run is active.
    expect(
      within(pendingQueue).getByRole("button", {
        name: "Steer the run with this message",
      }),
    ).toBeInTheDocument();
    expect(within(liveChat).getAllByText("Keep working on the live run")).toHaveLength(1);
    expect(
      within(liveChat).queryByText("After this, update the queue tests."),
    ).not.toBeInTheDocument();
    expect(getFollowUpDraft("active-session")).toBeNull();

    await user.click(within(pendingQueue).getByRole("button", { name: "Withdraw queued message" }));

    expect(await within(pendingQueue).findByText("Withdrawn")).toBeInTheDocument();
  });

  function dataTransferStub() {
    return {
      dropEffect: "move",
      effectAllowed: "all",
      setData() {},
      getData() {
        return "";
      },
    };
  }

  function fireCardDrag(
    type: "dragstart" | "dragover" | "drop" | "dragend",
    element: HTMLElement,
    dataTransfer: ReturnType<typeof dataTransferStub>,
    clientY = 0,
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY,
    });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    fireEvent(element, event);
  }

  function dragQueuedCard(
    source: HTMLElement,
    target: HTMLElement,
    edge: "before" | "after" = "before",
  ) {
    const dataTransfer = dataTransferStub();
    target.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 40,
        right: 100,
        width: 100,
        height: 40,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    const clientY = edge === "before" ? 5 : 35;
    fireCardDrag("dragstart", source, dataTransfer);
    fireCardDrag("dragover", target, dataTransfer, clientY);
    fireCardDrag("drop", target, dataTransfer, clientY);
    fireCardDrag("dragend", source, dataTransfer);
  }

  async function renderRunningQueue(
    bridge: PiRuntimeBridge & Pick<InMemoryPiRuntimeBridge, "restoreSessionState">,
    extras?: Partial<SessionProjection>,
  ) {
    let projection = applySessionProjectionEvent(
      createSessionProjection({
        id: "active-session",
        projectId: "pig-docs",
        initialPrompt: "Keep working on the live run",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime-active",
        piSessionId: "pi-session-active",
        occurredAt: "2026-06-26T08:00:01.000Z",
      },
    );
    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      stage: "accepted",
      event: {
        id: "runtime-event-active-user",
        piSessionId: "pi-session-active",
        kind: "message",
        role: "user",
        body: "Keep working on the live run",
        timestamp: "2026-06-26T08:00:02.000Z",
      },
    });
    await bridge.restoreSessionState({
      piSessionId: "pi-session-active",
      runtimeId: "runtime-active",
      projectId: "pig-docs",
      cwd: "/Users/void/code/opensource/Pig/docs",
      status: "running",
      events: projection.runtimeEvents,
      updatedAt: projection.updatedAt,
    });
    render(
      <FixtureSessionsView
        projectId="pig-docs"
        runtimeBridge={bridge}
        sessionProjection={{ ...projection, ...extras }}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "active-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: { model: "gpt-5-codex", totalCostUsd: 0, totalTokens: 0 },
        }}
      />,
    );
  }

  it("reorders pending waiting-area cards by dragging and leaves withdrawn cards in place", async () => {
    const user = userEvent.setup();
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:10:00.000Z",
    });
    await renderRunningQueue(bridge);

    await user.type(screen.getByPlaceholderText("Queue the next task…"), "First follow-up");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(screen.getByPlaceholderText("Queue the next task…"), "Second follow-up");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const pendingQueue = await screen.findByTestId("queued-message-list");
    const cards = within(pendingQueue).getAllByTestId("chat-queued-message");
    expect(cards[0]).toHaveTextContent("First follow-up");
    expect(cards[1]).toHaveTextContent("Second follow-up");
    expect(cards[0]).toHaveAttribute("draggable", "true");

    dragQueuedCard(cards[1], cards[0]);

    await waitFor(() => {
      const reordered = within(pendingQueue).getAllByTestId("chat-queued-message");
      expect(reordered[0]).toHaveTextContent("Second follow-up");
      expect(reordered[1]).toHaveTextContent("First follow-up");
    });

    await user.click(
      within(pendingQueue).getAllByRole("button", { name: "Withdraw queued message" })[0]!,
    );
    expect(await within(pendingQueue).findByText("Withdrawn")).toBeInTheDocument();
    const afterWithdraw = within(pendingQueue).getAllByTestId("chat-queued-message");
    expect(afterWithdraw.find((card) => card.hasAttribute("data-withdrawn"))).not.toHaveAttribute(
      "draggable",
      "true",
    );
  });

  it("does not drag-reorder queued cards when follow-up mode is all", async () => {
    const user = userEvent.setup();
    const inner = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:10:00.000Z",
    });
    const reorderQueuedMessages = vi.fn(inner.reorderQueuedMessages.bind(inner));
    const bridge = { ...inner, reorderQueuedMessages };
    await renderRunningQueue(bridge, { followUpMode: "all" });

    await user.type(screen.getByPlaceholderText("Queue the next task…"), "First follow-up");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(screen.getByPlaceholderText("Queue the next task…"), "Second follow-up");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const pendingQueue = await screen.findByTestId("queued-message-list");
    const cards = within(pendingQueue).getAllByTestId("chat-queued-message");
    expect(cards[0]).toHaveAttribute("draggable", "false");
    expect(cards[1]).toHaveAttribute("draggable", "false");

    dragQueuedCard(cards[1]!, cards[0]!);

    expect(reorderQueuedMessages).not.toHaveBeenCalled();
    expect(within(pendingQueue).getAllByTestId("chat-queued-message")[0]).toHaveTextContent(
      "First follow-up",
    );
    expect(cards[0]).not.toHaveAttribute("data-drop-target");
  });

  it("syncs waiting-area statuses when withdraw returns ok:false", async () => {
    const user = userEvent.setup();
    const inner = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:10:00.000Z",
    });
    const bridge = {
      ...inner,
      withdrawQueuedMessage: async () => ({
        ok: false as const,
        error: "follow-up failed",
        queuedMessages: [
          {
            id: "queued-c",
            piSessionId: "pi-session-active",
            body: "C",
            status: "pending" as const,
            createdAt: "2026-06-26T08:10:00.000Z",
          },
          {
            id: "queued-a",
            piSessionId: "pi-session-active",
            body: "A",
            status: "withdrawn" as const,
            createdAt: "2026-06-26T08:10:00.000Z",
            withdrawnAt: "2026-06-26T08:10:01.000Z",
          },
          {
            id: "queued-b",
            piSessionId: "pi-session-active",
            body: "B",
            status: "withdrawn" as const,
            createdAt: "2026-06-26T08:10:00.000Z",
            withdrawnAt: "2026-06-26T08:10:01.000Z",
          },
        ],
      }),
    };
    await renderRunningQueue(bridge);

    await user.type(screen.getByPlaceholderText("Queue the next task…"), "A");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(screen.getByPlaceholderText("Queue the next task…"), "B");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(screen.getByPlaceholderText("Queue the next task…"), "C");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const pendingQueue = await screen.findByTestId("queued-message-list");
    await user.click(
      within(pendingQueue).getAllByRole("button", { name: "Withdraw queued message" })[0]!,
    );

    await waitFor(() => {
      const synced = within(pendingQueue).getAllByTestId("chat-queued-message");
      expect(synced.map((card) => card.textContent)).toEqual([
        expect.stringContaining("C"),
        expect.stringContaining("A"),
        expect.stringContaining("B"),
      ]);
      expect(synced[1]).toHaveAttribute("data-withdrawn");
      expect(synced[2]).toHaveAttribute("data-withdrawn");
    });
    expect(await screen.findByText("follow-up failed")).toBeInTheDocument();
  });

  it("syncs waiting-area order and statuses when reorder returns ok:false", async () => {
    const user = userEvent.setup();
    const inner = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:10:00.000Z",
    });
    const bridge = {
      ...inner,
      reorderQueuedMessages: async () => ({
        ok: false as const,
        error: "follow-up failed",
        queuedMessages: [
          {
            id: "queued-c",
            piSessionId: "pi-session-active",
            body: "C",
            status: "pending" as const,
            createdAt: "2026-06-26T08:10:00.000Z",
          },
          {
            id: "queued-a",
            piSessionId: "pi-session-active",
            body: "A",
            status: "pending" as const,
            createdAt: "2026-06-26T08:10:00.000Z",
          },
          {
            id: "queued-b",
            piSessionId: "pi-session-active",
            body: "B",
            status: "withdrawn" as const,
            createdAt: "2026-06-26T08:10:00.000Z",
            withdrawnAt: "2026-06-26T08:10:01.000Z",
          },
        ],
      }),
    };
    await renderRunningQueue(bridge);

    await user.type(screen.getByPlaceholderText("Queue the next task…"), "A");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(screen.getByPlaceholderText("Queue the next task…"), "B");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(screen.getByPlaceholderText("Queue the next task…"), "C");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const pendingQueue = await screen.findByTestId("queued-message-list");
    const cards = within(pendingQueue).getAllByTestId("chat-queued-message");
    dragQueuedCard(cards[1]!, cards[0]!);

    await waitFor(() => {
      const synced = within(pendingQueue).getAllByTestId("chat-queued-message");
      expect(synced.map((card) => card.textContent)).toEqual([
        expect.stringContaining("C"),
        expect.stringContaining("A"),
        expect.stringContaining("B"),
      ]);
      expect(synced[2]).toHaveAttribute("data-withdrawn");
    });
  });

  it("rolls waiting-area order back when reorder fails", async () => {
    const user = userEvent.setup();
    const inner = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:10:00.000Z",
    });
    const bridge = {
      ...inner,
      reorderQueuedMessages: async () => {
        throw new PiRuntimeBridgeError({
          stage: "reordering queued messages",
          message: "Pi rejected the reorder.",
        });
      },
    };
    await renderRunningQueue(bridge);

    await user.type(screen.getByPlaceholderText("Queue the next task…"), "First follow-up");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(screen.getByPlaceholderText("Queue the next task…"), "Second follow-up");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const pendingQueue = await screen.findByTestId("queued-message-list");
    const cards = within(pendingQueue).getAllByTestId("chat-queued-message");
    dragQueuedCard(cards[1]!, cards[0]!);

    await waitFor(() => {
      const restored = within(pendingQueue).getAllByTestId("chat-queued-message");
      expect(restored[0]).toHaveTextContent("First follow-up");
      expect(restored[1]).toHaveTextContent("Second follow-up");
    });
  });

  it("drops a card after the target when the pointer is in the lower half", async () => {
    const user = userEvent.setup();
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:10:00.000Z",
    });
    await renderRunningQueue(bridge);

    await user.type(screen.getByPlaceholderText("Queue the next task…"), "A");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(screen.getByPlaceholderText("Queue the next task…"), "B");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(screen.getByPlaceholderText("Queue the next task…"), "C");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const pendingQueue = await screen.findByTestId("queued-message-list");
    const cards = within(pendingQueue).getAllByTestId("chat-queued-message");
    dragQueuedCard(cards[0]!, cards[2]!, "after");

    await waitFor(() => {
      const reordered = within(pendingQueue).getAllByTestId("chat-queued-message");
      expect(reordered.map((card) => card.textContent)).toEqual([
        expect.stringContaining("B"),
        expect.stringContaining("C"),
        expect.stringContaining("A"),
      ]);
    });
  });

  it("locks the waiting area while a reorder is in flight", async () => {
    const user = userEvent.setup();
    const inner = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:10:00.000Z",
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = {
      ...inner,
      reorderQueuedMessages: async (input: { piSessionId: string; orderedIds: string[] }) => {
        await held;
        return inner.reorderQueuedMessages(input);
      },
    };
    await renderRunningQueue(bridge);

    await user.type(screen.getByPlaceholderText("Queue the next task…"), "A");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(screen.getByPlaceholderText("Queue the next task…"), "B");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const pendingQueue = await screen.findByTestId("queued-message-list");
    const cards = within(pendingQueue).getAllByTestId("chat-queued-message");
    dragQueuedCard(cards[1]!, cards[0]!);

    await waitFor(() => {
      for (const card of within(pendingQueue).getAllByTestId("chat-queued-message")) {
        expect(card).toHaveAttribute("draggable", "false");
      }
    });

    await act(async () => release());

    await waitFor(() => {
      const settled = within(pendingQueue).getAllByTestId("chat-queued-message");
      expect(settled.map((card) => card.textContent)).toEqual([
        expect.stringContaining("B"),
        expect.stringContaining("A"),
      ]);
      expect(settled[0]).toHaveAttribute("draggable", "true");
    });
  });

  it("shows an ephemeral assistant placeholder while a run has no assistant events yet", async () => {
    let projection = applySessionProjectionEvent(
      createSessionProjection({
        id: "starting-session",
        projectId: "pig-docs",
        initialPrompt: "Look at the current project",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime-starting",
        piSessionId: "pi-session-starting",
        occurredAt: "2026-06-26T08:00:01.000Z",
      },
    );

    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      stage: "accepted",
      event: {
        id: "runtime-event-starting-user",
        piSessionId: "pi-session-starting",
        kind: "message",
        role: "user",
        body: "Look at the current project",
        timestamp: "2026-06-26T08:00:02.000Z",
      },
    });

    render(
      <FixtureSessionsView
        clockNowMs={Date.parse("2026-06-26T08:00:03.000Z")}
        projectId="pig-docs"
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "starting-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    const liveColumn = await screen.findByTestId("live-session-column");
    const liveChat = await screen.findByLabelText("Live Chat messages");

    expect(within(liveChat).getByText("Look at the current project")).toBeInTheDocument();
    // Astryx streaming reveals text progressively inside per-chunk spans, so
    // assert on the subtree text instead of a single text node.
    await waitFor(() =>
      expect(liveChat).toHaveTextContent("Pi is contacting the model"),
    );
    expect(liveColumn.querySelectorAll('[data-slot="chat-message-assistant"]')).toHaveLength(1);
    expect(within(liveColumn).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("does not show Pi is working once the live trace has think activity", async () => {
    let projection = applySessionProjectionEvent(
      createSessionProjection({
        id: "thinking-session",
        projectId: "pig-docs",
        initialPrompt: "Look at the current code",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime-thinking",
        piSessionId: "pi-session-thinking",
        occurredAt: "2026-06-26T08:00:01.000Z",
      },
    );

    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      stage: "accepted",
      event: {
        id: "runtime-event-thinking-user",
        piSessionId: "pi-session-thinking",
        kind: "message",
        role: "user",
        body: "Look at the current code",
        timestamp: "2026-06-26T08:00:02.000Z",
      },
    });

    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      stage: "accepted",
      event: {
        id: "runtime-event-thinking",
        piSessionId: "pi-session-thinking",
        messageId: "pi-sdk:pi-session-thinking:assistant:0",
        kind: "thinking",
        role: "assistant",
        body: [
          "Identifying illegal human raises risk",
          "Validating raise amounts and state resets",
          "Confirming fold winner logic consistency",
        ].join("\n"),
        timestamp: "2026-06-26T08:00:03.000Z",
      },
    });

    render(
      <FixtureSessionsView
        clockNowMs={Date.parse("2026-06-26T08:00:04.000Z")}
        projectId="pig-docs"
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "thinking-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    const liveChat = await screen.findByLabelText("Live Chat messages");

    // The legacy pipeline mints no Message boundaries, so its trace has no Run
    // to phase and no anchor to measure: it settles at once, with the whole
    // thinking body behind an unnumbered header (ADR-0030 §"后果").
    expect(within(liveChat).getByRole("button", { name: /^Worked/ })).toBeInTheDocument();
    expect(liveChat).toHaveTextContent("Confirming fold winner logic consistency");
    expect(liveChat).toHaveTextContent("Identifying illegal human raises risk");
    expect(liveChat).not.toHaveTextContent("Pi is working");
  });

  it("surfaces a stalled first model response in the main chat", async () => {
    let projection = applySessionProjectionEvent(
      createSessionProjection({
        id: "starting-session",
        projectId: "pig-docs",
        initialPrompt: "Check whether DeepSeek responds",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime-starting",
        piSessionId: "pi-session-starting",
        occurredAt: "2026-06-26T08:00:01.000Z",
      },
    );

    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      stage: "accepted",
      event: {
        id: "runtime-event-starting-user",
        piSessionId: "pi-session-starting",
        kind: "message",
        role: "user",
        body: "Check whether DeepSeek responds",
        timestamp: "2026-06-26T08:00:02.000Z",
      },
    });

    render(
      <FixtureSessionsView
        clockNowMs={Date.parse("2026-06-26T08:00:18.000Z")}
        projectId="pig-docs"
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "starting-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "deepseek-v4-pro",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    const liveChat = await screen.findByLabelText("Live Chat messages");

    // Astryx streaming reveals text progressively inside per-chunk spans, so
    // assert on the subtree text; the reveal needs longer than the default 1s.
    await waitFor(
      () =>
        expect(liveChat).toHaveTextContent(
          "The provider has not returned a first chunk yet",
        ),
      { timeout: 3000 },
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("submits ordinary prompts to an idle Session instead of queuing them", async () => {
    const user = userEvent.setup();
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:12:00.000Z",
    });
    let projection = applySessionProjectionEvent(
      createSessionProjection({
        id: "waiting-session",
        projectId: "pig-docs",
        initialPrompt: "Review the first result",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime-waiting",
        piSessionId: "pi-session-waiting",
        occurredAt: "2026-06-26T08:00:01.000Z",
      },
    );

    projection = applySessionProjectionEvent(projection, {
      type: "runtime-state-resynced",
      state: {
        piSessionId: "pi-session-waiting",
        runtimeId: "runtime-waiting",
        projectId: "pig-docs",
        cwd: "/Users/void/code/opensource/Pig/docs",
        status: "idle",
        events: [
          {
            id: "runtime-event-initial",
            piSessionId: "pi-session-waiting",
            kind: "message",
            role: "user",
            body: "Review the first result",
            timestamp: "2026-06-26T08:00:02.000Z",
          },
          {
            id: "runtime-event-assistant",
            piSessionId: "pi-session-waiting",
            kind: "message",
            role: "assistant",
            body: "The first result is ready.",
            timestamp: "2026-06-26T08:00:03.000Z",
          },
        ],
        updatedAt: "2026-06-26T08:00:03.000Z",
      },
    });
    await bridge.restoreSessionState({
      piSessionId: "pi-session-waiting",
      runtimeId: "runtime-waiting",
      projectId: "pig-docs",
      cwd: "/Users/void/code/opensource/Pig/docs",
      status: "idle",
      events: projection.runtimeEvents,
      updatedAt: projection.updatedAt,
    });

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        runtimeBridge={bridge}
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "waiting-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Steer" })).not.toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("What do you want to know?"),
      "Continue from the idle Session",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    const liveChat = await screen.findByLabelText("Live Chat messages");

    expect(
      await within(liveChat).findByText("Continue from the idle Session"),
    ).toBeInTheDocument();
    expect(getFollowUpDraft("waiting-session")).toBeNull();
    expect(screen.queryByTestId("queued-message-list")).not.toBeInTheDocument();
  });

  it("keeps the composer available after a completed run for follow-up prompts", async () => {
    const user = userEvent.setup();
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:20:00.000Z",
    });
    const projection = {
      ...createSessionProjection({
        id: "completed-session",
        projectId: "pig-docs",
        initialPrompt: "Review the first result",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      status: "completed" as const,
      creationStage: "accepted" as const,
      runtimeId: "runtime-completed",
      piSessionId: "pi-session-completed",
      runtimeEvents: [
        {
          id: "runtime-event-initial",
          piSessionId: "pi-session-completed",
          kind: "message" as const,
          role: "user" as const,
          body: "Review the first result",
          timestamp: "2026-06-26T08:00:02.000Z",
        },
        {
          id: "runtime-event-assistant",
          piSessionId: "pi-session-completed",
          kind: "message" as const,
          role: "assistant" as const,
          body: "The first result is ready.",
          timestamp: "2026-06-26T08:00:03.000Z",
        },
      ],
      updatedAt: "2026-06-26T08:00:03.000Z",
    };
    await bridge.restoreSessionState({
      piSessionId: "pi-session-completed",
      runtimeId: "runtime-completed",
      projectId: "pig-docs",
      cwd: "/Users/void/code/opensource/Pig/docs",
      status: "completed",
      events: projection.runtimeEvents,
      updatedAt: projection.updatedAt,
    });

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        runtimeBridge={bridge}
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "completed-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Steer" })).not.toBeInTheDocument();
    await user.type(
      screen.getByPlaceholderText("What do you want to know?"),
      "Continue after completion",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    const liveChat = await screen.findByLabelText("Live Chat messages");

    expect(
      await within(liveChat).findByText("Continue after completion"),
    ).toBeInTheDocument();
    expect(getFollowUpDraft("completed-session")).toBeNull();
  });

  it("keeps both user bubbles and the in-flight run events of a follow-up prompt on the runtime-model path", async () => {
    const user = userEvent.setup();
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-07-02T10:00:10.000Z",
    });
    const agentListeners = new Map<
      string,
      Set<(entry: AgentRuntimeEventEntry) => void>
    >();
    let releasePromptEcho: (() => void) | null = null;
    // In-memory bridge plus the Agent Runtime Event stream, with the prompt
    // RPC held open so the test can deliver live run events inside the
    // round-trip window — the window handlePromptSubmit used to clobber with
    // its pre-await projection snapshot.
    const runtimeModelBridge: InMemoryPiRuntimeBridge = {
      ...bridge,
      subscribeToAgentEvents(piSessionId, listener) {
        const sessionListeners = agentListeners.get(piSessionId) ?? new Set();

        sessionListeners.add(listener);
        agentListeners.set(piSessionId, sessionListeners);

        return () => {
          sessionListeners.delete(listener);
        };
      },
      async sendInitialPrompt(input) {
        const accepted = await bridge.sendInitialPrompt(input);

        await new Promise<void>((resolve) => {
          releasePromptEcho = resolve;
        });

        return accepted;
      },
    };
    const emitAgentEvent = (entry: AgentRuntimeEventEntry) => {
      for (const listener of agentListeners.get("pi-session-followup") ?? []) {
        listener(entry);
      }
    };
    let projection: SessionProjection = {
      ...createSessionProjection({
        id: "followup-session",
        projectId: "pig-docs",
        initialPrompt: "First prompt",
        createdAt: "2026-07-02T10:00:00.000Z",
      }),
      creationStage: "accepted",
      runtimeId: "pi-sdk:followup-session",
      piSessionId: "pi-session-followup",
    };

    // Gateway-minted user echo of the opening prompt, mirrored into the model.
    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      event: {
        id: "user-echo-1",
        piSessionId: "pi-session-followup",
        kind: "message",
        role: "user",
        body: "First prompt",
        messageId: "pi-sdk:pi-session-followup:user:0",
        timestamp: "2026-07-02T10:00:00.500Z",
      },
    });

    const openingRunId = "pi-session-followup:run-1";
    const openingTurnId = `${openingRunId}:turn-1`;
    const openingAnswerId = `${openingTurnId}:msg-1`;

    for (const entry of [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "run",
          runId: openingRunId,
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "message",
          runId: openingRunId,
          turnId: openingTurnId,
          messageId: openingAnswerId,
          role: "assistant",
          phase: "end",
          parts: [
            {
              partId: `${openingAnswerId}:part-0`,
              partType: "text",
              body: "First answer",
            },
          ],
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: {
          type: "run",
          runId: openingRunId,
          phase: "end",
          trigger: "prompt",
          outcome: "completed",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
    ]) {
      projection = applySessionProjectionEvent(projection, {
        type: "agent-event-received",
        entry,
      });
    }

    await bridge.restoreSessionState({
      piSessionId: "pi-session-followup",
      runtimeId: "pi-sdk:followup-session",
      projectId: "pig-docs",
      cwd: "/Users/void/code/opensource/Pig/docs",
      status: "completed",
      events: projection.runtimeEvents,
      updatedAt: projection.updatedAt,
    });

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        runtimeBridge={runtimeModelBridge}
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "followup-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "fixture-model",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    // Run events own the Session, so the composer sends instead of queuing.
    expect(screen.queryByRole("button", { name: "Steer" })).not.toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("What do you want to know?"),
      "Second prompt",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The prompt RPC is parked mid-flight while the follow-up run streams and
    // completes inside the round-trip window.
    await waitFor(() => expect(releasePromptEcho).not.toBeNull());

    const followupRunId = "pi-session-followup:run-2";
    const followupTurnId = `${followupRunId}:turn-1`;
    const followupAnswerId = `${followupTurnId}:msg-1`;

    act(() => {
      for (const entry of [
        {
          seq: 4,
          timestamp: "2026-07-02T10:00:11.000Z",
          event: {
            type: "run",
            runId: followupRunId,
            phase: "start",
            trigger: "prompt",
            surface: "hidden",
            origin: "sdk",
          } as const,
        },
        {
          seq: 5,
          timestamp: "2026-07-02T10:00:12.000Z",
          event: {
            type: "message",
            runId: followupRunId,
            turnId: followupTurnId,
            messageId: followupAnswerId,
            role: "assistant",
            phase: "end",
            parts: [
              {
                partId: `${followupAnswerId}:part-0`,
                partType: "text",
                body: "Second answer",
              },
            ],
            surface: "chat",
            origin: "sdk",
          } as const,
        },
        {
          seq: 6,
          timestamp: "2026-07-02T10:00:13.000Z",
          event: {
            type: "run",
            runId: followupRunId,
            phase: "end",
            trigger: "prompt",
            outcome: "completed",
            surface: "hidden",
            origin: "sdk",
          } as const,
        },
      ]) {
        emitAgentEvent(entry);
      }
    });

    await act(async () => {
      releasePromptEcho?.();
    });

    const liveChat = await screen.findByLabelText("Live Chat messages");

    await waitFor(
      () => expect(liveChat).toHaveTextContent("First prompt"),
      { timeout: 3000 },
    );
    await waitFor(
      () => expect(liveChat).toHaveTextContent("First answer"),
      { timeout: 3000 },
    );
    // The user echo from the RPC return must survive the commit …
    await waitFor(
      () => expect(liveChat).toHaveTextContent("Second prompt"),
      { timeout: 3000 },
    );
    // … and so must the run events that landed inside the RPC window.
    await waitFor(
      () => expect(liveChat).toHaveTextContent("Second answer"),
      { timeout: 3000 },
    );
  });

  it("keeps the run events that land inside the Steer round-trip", async () => {
    const user = userEvent.setup();
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-07-02T10:00:10.000Z",
    });
    const agentListeners = new Map<
      string,
      Set<(entry: AgentRuntimeEventEntry) => void>
    >();
    let releaseSteer: (() => void) | null = null;
    // Same window as Stop: the steer RPC is parked so the Run's answer can
    // land inside it, and the commit must not fall back to the pre-await
    // projection snapshot.
    const steerRaceBridge: InMemoryPiRuntimeBridge = {
      ...bridge,
      subscribeToAgentEvents(piSessionId, listener) {
        const sessionListeners = agentListeners.get(piSessionId) ?? new Set();

        sessionListeners.add(listener);
        agentListeners.set(piSessionId, sessionListeners);

        return () => {
          sessionListeners.delete(listener);
        };
      },
      async steerFromQueue(input) {
        const steered = await bridge.steerFromQueue(input);

        await new Promise<void>((resolve) => {
          releaseSteer = resolve;
        });

        return steered;
      },
    };
    const emitAgentEvent = (entry: AgentRuntimeEventEntry) => {
      for (const listener of agentListeners.get("pi-session-steer-race") ?? []) {
        listener(entry);
      }
    };
    const runId = "pi-session-steer-race:run-1";
    const turnId = `${runId}:turn-1`;
    const messageId = `${turnId}:msg-1`;
    let projection: SessionProjection = {
      ...createSessionProjection({
        id: "steer-race-session",
        projectId: "pig-docs",
        initialPrompt: "First prompt",
        createdAt: "2026-07-02T10:00:00.000Z",
      }),
      creationStage: "accepted",
      runtimeId: "pi-sdk:steer-race-session",
      piSessionId: "pi-session-steer-race",
    };

    for (const entry of [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "run",
          runId,
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "start",
          parts: [],
          surface: "chat",
          origin: "sdk",
        } as const,
      },
    ]) {
      projection = applySessionProjectionEvent(projection, {
        type: "agent-event-received",
        entry,
      });
    }

    await bridge.restoreSessionState({
      piSessionId: "pi-session-steer-race",
      runtimeId: "pi-sdk:steer-race-session",
      projectId: "pig-docs",
      cwd: "/Users/void/code/opensource/Pig/docs",
      status: "running",
      events: projection.runtimeEvents,
      updatedAt: projection.updatedAt,
    });

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        runtimeBridge={steerRaceBridge}
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "steer-race-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "fixture-model",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    await user.type(
      await screen.findByPlaceholderText("Queue the next task…"),
      "Steer text",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    const pendingQueue = await screen.findByTestId("queued-message-list");

    await user.click(
      within(pendingQueue).getByRole("button", {
        name: "Steer the run with this message",
      }),
    );
    await waitFor(() => expect(releaseSteer).not.toBeNull());

    // The Run answers while the steer RPC is still in flight.
    act(() => {
      emitAgentEvent({
        seq: 3,
        timestamp: "2026-07-02T10:00:09.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "end",
          parts: [
            {
              partId: `${messageId}:part-0`,
              partType: "text",
              body: "Answer before the steer landed",
            },
          ],
          surface: "chat",
          origin: "sdk",
        },
      });
    });

    await act(async () => {
      releaseSteer?.();
    });

    const liveChat = await screen.findByLabelText("Live Chat messages");

    await waitFor(() => expect(liveChat).toHaveTextContent("Steer text"));
    // The answer streams in through the incremental renderer, so give it a beat.
    await waitFor(
      () => expect(liveChat).toHaveTextContent("Answer before the steer landed"),
      { timeout: 3000 },
    );
  });

  it("offers available models while cold without starting the Session to read the catalog", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_available_model_controls") return { models: [{ provider: "openai", modelId: "gpt-5.5", name: "GPT-5.5", thinkingLevels: ["off", "high"] }], selected: null };
      throw new Error(`Unexpected command ${command}`);
    });
    window.pace = { ...createMockApi(), invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"] };
    const projection: SessionProjection = { ...createSessionProjection({ id: "cold-model", projectId: "pig-docs", initialPrompt: "Saved history", createdAt: "2026-09-14T00:00:00.000Z" }),
      status: "completed", creationStage: "accepted", piSessionId: "pi", modelControls: { models: [], selected: { provider: "openai", modelId: "gpt-5.5", thinkingLevel: "high" } } };
    render(<FixtureSessionsView projectId="pig-docs" showDraft={false} sessionProjection={projection} runtimeBridge={createInMemoryPiRuntimeBridge()} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_available_model_controls", undefined));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Model and Thinking" }));
    expect(await screen.findByText("GPT-5.5", { exact: true })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("resume_session", expect.anything());
  });

  it("locks one cold submission and keeps its draft and history when preparation fails", async () => {
    const user = userEvent.setup();
    let reject!: (error: Error) => void;
    const send = vi.fn(() => new Promise<never>((_resolve, fail) => { reject = fail; }));
    const projection: SessionProjection = {
      ...createSessionProjection({ id: "cold-send", projectId: "pig-docs", initialPrompt: "Saved history", createdAt: "2026-09-14T00:00:00.000Z" }),
      status: "completed", creationStage: "accepted", runtimeId: "runtime", piSessionId: "pi-cold",
      runtimeEvents: [{ id: "old", piSessionId: "pi-cold", kind: "message", role: "assistant", body: "Saved answer", timestamp: "2026-09-14T00:00:00.000Z" }],
    };
    render(<FixtureSessionsView projectId="pig-docs" showDraft={false} sessionProjection={projection}
      runtimeBridge={{ ...createInMemoryPiRuntimeBridge(), sendInitialPrompt: send }} />);
    const input = screen.getByPlaceholderText("What do you want to know?");
    await user.type(input, "Continue");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(input).toBeDisabled();
    expect(screen.getByLabelText("Live Chat messages")).toHaveTextContent("Saved answer");
    await act(async () => reject(new Error("Extension initialization failed")));
    expect(await screen.findByText("Extension initialization failed")).toBeInTheDocument();
    expect(input).toHaveValue("Continue");
    expect(input).toBeEnabled();
    expect(screen.queryByTestId("runtime-fallback-banner")).not.toBeInTheDocument();
  });

  it("does not resubmit a pending prompt after switching away and back", async () => {
    const user = userEvent.setup();
    let resolve!: (value: Awaited<ReturnType<PiRuntimeBridge["sendInitialPrompt"]>>) => void;
    const send = vi.fn(() => new Promise<Awaited<ReturnType<PiRuntimeBridge["sendInitialPrompt"]>>>(done => { resolve = done; }));
    const runtimeBridge = { ...createInMemoryPiRuntimeBridge(), sendInitialPrompt: send };
    const session = (id: string): SessionProjection => ({
      ...createSessionProjection({ id, projectId: "pig-docs", initialPrompt: id, createdAt: "2026-09-14T00:00:00.000Z" }),
      status: "completed", creationStage: "accepted", runtimeId: id, piSessionId: `pi-${id}`,
    });
    const a = session("a");
    const b = session("b");
    const view = (projection: SessionProjection) => <FixtureSessionsView projectId="pig-docs" showDraft={false}
      sessionProjection={projection} runtimeBridge={runtimeBridge} />;
    const { rerender } = render(view(a));
    await user.type(screen.getByPlaceholderText("What do you want to know?"), "Continue A");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    rerender(view(b));
    await waitFor(() => expect(screen.getByPlaceholderText("What do you want to know?")).toHaveValue(""));
    rerender(view(a));
    await waitFor(() => expect(screen.getByPlaceholderText("What do you want to know?")).toHaveValue("Continue A"));
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(send).toHaveBeenCalledOnce();
    await act(async () => resolve({ accepted: true, piSessionId: "pi-a", event: {
      id: "accepted", piSessionId: "pi-a", kind: "message", role: "user", body: "Continue A", timestamp: "2026-09-14T00:01:00.000Z",
    } }));
    expect(screen.getByLabelText("Live Chat messages")).toHaveTextContent("Continue A");
  });

  it("reads a Session's history once and keeps following it while the user looks away", async () => {
    let resolveRead!: (state: PiSessionState) => void;
    const state = (piSessionId: string, events: PiRuntimeEvent[] = []): PiSessionState => ({
      piSessionId, runtimeId: "runtime", projectId: "pig-docs", cwd: "/repo", status: "completed",
      events, updatedAt: "2026-09-14T00:00:00.000Z",
    });
    const loadSession = vi.fn(({ piSessionId }: { piSessionId: string }) => piSessionId === "pi-a"
      ? new Promise<PiSessionState>((resolve) => { resolveRead = resolve; })
      : Promise.resolve(state(piSessionId)));
    const listeners = new Set<(event: PiRuntimeEvent) => void>();
    const runtimeBridge: PiRuntimeBridge = { ...createInMemoryPiRuntimeBridge(), loadSession,
      subscribeToEvents: (piSessionId, listener) => {
        if (piSessionId === "pi-a") listeners.add(listener);
        return () => { listeners.delete(listener); };
      } };
    const session = (id: string): SessionProjection => ({
      ...createSessionProjection({ id, projectId: "pig-docs", initialPrompt: id, createdAt: "2026-09-14T00:00:00.000Z" }),
      status: "completed", creationStage: "accepted", piSessionId: `pi-${id}`, runtimeId: "runtime",
    });
    const view = (sessionId: string) => <FixtureSessionsView projectId="pig-docs" showDraft={false}
      sessionId={sessionId} runtimeBridge={runtimeBridge} />;
    const { rerender } = render(view("a"), { store: storeWith(runtimeBridge, session("a"), session("b")) });

    expect(await screen.findByTestId("session-history-status")).toHaveTextContent("Loading history");
    await act(async () => resolveRead(state("pi-a", [{ id: "answer", piSessionId: "pi-a", kind: "message",
      role: "assistant", body: "Previous answer", timestamp: "2026-09-14T00:00:00.000Z" }])));
    expect(await screen.findByText("Previous answer")).toBeInTheDocument();
    expect(screen.queryByTestId("session-history-status")).not.toBeInTheDocument();

    rerender(view("b"));
    act(() => {
      for (const listener of listeners) {
        listener({ id: "background-answer", piSessionId: "pi-a", kind: "message",
          role: "assistant", body: "Completed while away", timestamp: "2026-09-14T00:01:00.000Z" });
        listener({ id: "background-done", piSessionId: "pi-a", kind: "status",
          body: "Done", timestamp: "2026-09-14T00:01:01.000Z" });
      }
    });
    expect(screen.queryByText("Completed while away")).not.toBeInTheDocument();

    rerender(view("a"));
    expect(await screen.findByText("Completed while away")).toBeInTheDocument();
    expect(loadSession.mock.calls.filter(([input]) => input.piSessionId === "pi-a")).toHaveLength(1);
  });

  it.each(["refresh", "reopen"])(
    "finishes a pending Session resume after a projection %s without duplicating the RPC",
    async (change) => {
      const bridge = createInMemoryPiRuntimeBridge();
      let resolveResume!: (state: PiSessionState) => void;
      const loadSession = vi.fn(() => new Promise<PiSessionState>((resolve) => {
        resolveResume = resolve;
      }));
      const resumingBridge = { ...bridge, loadSession };
      const selected = {
        provider: "openai",
        modelId: "gpt-5.5",
        thinkingLevel: "high" as const,
      };
      const projection: SessionProjection = {
        ...createSessionProjection({
          id: "pending-resume",
          projectId: "pig-docs",
          initialPrompt: "Resume with refreshed projection",
          createdAt: "2026-07-02T10:00:00.000Z",
        }),
        status: "completed",
        creationStage: "accepted",
        runtimeId: "runtime-pending",
        piSessionId: "pi-pending",
        sessionFile: "/sessions/pi-pending.jsonl",
        modelControls: { models: [], selected },
      };
      const view = (showDraft = false) => (
        <FixtureSessionsView
          projectId="pig-docs"
          runtimeBridge={resumingBridge}
          sessionProjection={{ ...projection }}
          showDraft={showDraft}
        />
      );
      const { rerender } = render(view());
      await waitFor(() => expect(loadSession).toHaveBeenCalledTimes(1));

      // A projection reload or a quick Draft round-trip must keep the pending result usable.
      if (change === "reopen") rerender(view(true));
      rerender(view());
      await act(async () => resolveResume({
        piSessionId: "pi-pending",
        runtimeId: "runtime-pending",
        projectId: "pig-docs",
        cwd: "/project",
        status: "completed",
        events: [],
        modelControls: {
          selected,
          models: [{
            provider: "openai",
            modelId: "gpt-5.5",
            name: "GPT-5.5",
            thinkingLevels: ["off", "high"],
          }],
        },
        updatedAt: projection.updatedAt,
      }));

      await waitFor(() => expect(screen.getByTestId("model-thinking-trigger")).toBeEnabled());
      expect(screen.getByTestId("model-thinking-trigger")).toHaveTextContent("GPT-5.5 · High");
      expect(loadSession).toHaveBeenCalledTimes(1);
    },
  );

  it("restores a per-Session Follow-up Draft without showing a Project selector", async () => {
    let projection = applySessionProjectionEvent(
      createSessionProjection({
        id: "waiting-session",
        projectId: "pig-docs",
        initialPrompt: "Review the first result",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime-waiting",
        piSessionId: "pi-session-waiting",
        occurredAt: "2026-06-26T08:00:01.000Z",
      },
    );

    projection = applySessionProjectionEvent(projection, {
      type: "runtime-state-resynced",
      state: {
        piSessionId: "pi-session-waiting",
        runtimeId: "runtime-waiting",
        projectId: "pig-docs",
        cwd: "/Users/void/code/opensource/Pig/docs",
        status: "idle",
        events: projection.runtimeEvents,
        updatedAt: "2026-06-26T08:00:03.000Z",
      },
    });
    saveFollowUpDraft("waiting-session", "Resume from the saved composer");

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "waiting-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    expect(await screen.findByPlaceholderText("What do you want to know?")).toHaveValue(
      "Resume from the saved composer",
    );
    expect(screen.queryByLabelText("Project")).not.toBeInTheDocument();
  });

  it("takes an injected block into the draft it already has, screenshot and all", async () => {
    // The browser surface hands the composer marked-up page annotations from
    // outside the chat column (#151). jsdom has no object URLs, and the
    // attachment path makes one for every image preview.
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => "blob:annotations",
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: () => {},
    });

    let projection = applySessionProjectionEvent(
      createSessionProjection({
        id: "annotated-session",
        projectId: "pig-docs",
        initialPrompt: "Review the preview",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime-annotated",
        piSessionId: "pi-session-annotated",
        occurredAt: "2026-06-26T08:00:01.000Z",
      },
    );

    projection = applySessionProjectionEvent(projection, {
      type: "runtime-state-resynced",
      state: {
        piSessionId: "pi-session-annotated",
        runtimeId: "runtime-annotated",
        projectId: "pig-docs",
        cwd: "/Users/void/code/opensource/Pig/docs",
        status: "idle",
        events: projection.runtimeEvents,
        updatedAt: "2026-06-26T08:00:03.000Z",
      },
    });
    saveFollowUpDraft("annotated-session", "Half a thought");

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "annotated-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    const composer = await screen.findByPlaceholderText("What do you want to know?");

    act(() => {
      injectIntoComposer({
        sessionId: "annotated-session",
        text: "Browser annotations from the embedded preview",
        files: [
          new File(["png"], "browser-annotations.png", { type: "image/png" }),
        ],
      });
      // Another Session's surface must not write into this composer.
      injectIntoComposer({ sessionId: "other-session", text: "Not for you" });
    });

    // Appended as its own block: whatever the user was already typing is the
    // point of landing in the draft rather than sending.
    await waitFor(() =>
      expect(composer).toHaveValue(
        "Half a thought\n\nBrowser annotations from the embedded preview",
      ),
    );
    // Persisted like any other draft, so leaving the Session does not lose it.
    expect(getFollowUpDraft("annotated-session")?.message).toBe(
      "Half a thought\n\nBrowser annotations from the embedded preview",
    );
    // The screenshot rides the existing attachment path: drawer preview, size
    // check and base64 encoding at submit all come with it.
    expect(await screen.findByAltText("browser-annotations.png")).toBeInTheDocument();
  });

  it("steers an active run as a Live Chat control event instead of a queued message", async () => {
    const user = userEvent.setup();
    const inner = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:10:00.000Z",
    });
    const steerFromQueue = vi.fn((input: { piSessionId: string; queuedMessageId: string }) =>
      inner.steerFromQueue(input),
    );
    const steerRun = vi.fn(inner.steerRun.bind(inner));
    const withdrawQueuedMessage = vi.fn(inner.withdrawQueuedMessage.bind(inner));
    const bridge = {
      ...inner,
      steerFromQueue,
      steerRun,
      withdrawQueuedMessage,
    };
    let projection = applySessionProjectionEvent(
      createSessionProjection({
        id: "active-session",
        projectId: "pig-docs",
        initialPrompt: "Keep working on the live run",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime-active",
        piSessionId: "pi-session-active",
        occurredAt: "2026-06-26T08:00:01.000Z",
      },
    );

    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      stage: "accepted",
      event: {
        id: "runtime-event-active-user",
        piSessionId: "pi-session-active",
        kind: "message",
        role: "user",
        body: "Keep working on the live run",
        timestamp: "2026-06-26T08:00:02.000Z",
      },
    });
    await bridge.restoreSessionState({
      piSessionId: "pi-session-active",
      runtimeId: "runtime-active",
      projectId: "pig-docs",
      cwd: "/Users/void/code/opensource/Pig/docs",
      status: "running",
      events: projection.runtimeEvents,
      updatedAt: projection.updatedAt,
    });

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        runtimeBridge={bridge}
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "active-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    const liveChat = await screen.findByLabelText("Live Chat messages");

    // Queue-first: the composer has no Steer button; submitting queues, and
    // the queued row carries the Steer action.
    expect(screen.queryByRole("button", { name: "Steer" })).not.toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("Queue the next task…"),
      "Avoid changing the archive model.",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    const pendingQueue = await screen.findByTestId("queued-message-list");

    await user.click(
      within(pendingQueue).getByRole("button", {
        name: "Steer the run with this message",
      }),
    );

    expect(steerFromQueue).toHaveBeenCalledTimes(1);
    expect(steerRun).not.toHaveBeenCalled();
    expect(withdrawQueuedMessage).not.toHaveBeenCalled();
    expect(await within(pendingQueue).findByText("Steered")).toBeInTheDocument();
    expect(within(pendingQueue).queryByText("Withdrawn")).not.toBeInTheDocument();
    expect(
      within(pendingQueue).queryByRole("button", {
        name: "Steer the run with this message",
      }),
    ).not.toBeInTheDocument();
    expect(await within(liveChat).findByText("Steer")).toBeInTheDocument();
    expect(
      within(liveChat).getByText("Avoid changing the archive model."),
    ).toBeInTheDocument();
  });

  it("keeps steer text editable and shows a recoverable error when steer fails", async () => {
    const user = userEvent.setup();
    const bridge = createInMemoryPiRuntimeBridge();
    let projection = applySessionProjectionEvent(
      createSessionProjection({
        id: "active-session",
        projectId: "pig-docs",
        initialPrompt: "Keep working on the live run",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime-active",
        piSessionId: "pi-session-active",
        occurredAt: "2026-06-26T08:00:01.000Z",
      },
    );

    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      stage: "accepted",
      event: {
        id: "runtime-event-active-user",
        piSessionId: "pi-session-active",
        kind: "message",
        role: "user",
        body: "Keep working on the live run",
        timestamp: "2026-06-26T08:00:02.000Z",
      },
    });
    await bridge.restoreSessionState({
      piSessionId: "pi-session-active",
      runtimeId: "runtime-active",
      projectId: "pig-docs",
      cwd: "/Users/void/code/opensource/Pig/docs",
      status: "running",
      events: projection.runtimeEvents,
      updatedAt: projection.updatedAt,
    });
    bridge.steerFromQueue = vi.fn().mockRejectedValue(
      new PiRuntimeBridgeError({
        stage: "steering queued message",
        message: "Pi rejected steer input.",
      }),
    );

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        runtimeBridge={bridge}
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "active-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    const input = screen.getByPlaceholderText("Queue the next task…");

    await user.type(input, "Keep this steer text");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const pendingQueue = await screen.findByTestId("queued-message-list");

    await user.click(
      within(pendingQueue).getByRole("button", {
        name: "Steer the run with this message",
      }),
    );

    // A failed steer surfaces the error and leaves the row queued and steerable.
    expect(await screen.findByText("Pi rejected steer input.")).toBeInTheDocument();
    expect(within(pendingQueue).getByText("Keep this steer text")).toBeInTheDocument();
    expect(
      within(pendingQueue).getByRole("button", {
        name: "Steer the run with this message",
      }),
    ).toBeInTheDocument();
  });

  it("renders Steered when the target was already processing before steer_from_queue returns", async () => {
    const user = userEvent.setup();
    const inner = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:10:00.000Z",
    });
    let releaseSteer: (() => void) | null = null;
    const bridge = {
      ...inner,
      async steerFromQueue(input: { piSessionId: string; queuedMessageId: string }) {
        await new Promise<void>((resolve) => {
          releaseSteer = resolve;
        });
        return {
          ok: true as const,
          queuedMessages: [
            {
              id: input.queuedMessageId,
              piSessionId: input.piSessionId,
              body: "Promote B",
              status: "steered" as const,
              createdAt: "2026-06-26T08:10:00.000Z",
              steeredAt: "2026-06-26T08:10:02.000Z",
            },
          ],
        };
      },
    };
    await renderRunningQueue(bridge);

    await user.type(screen.getByPlaceholderText("Queue the next task…"), "Promote B");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const pendingQueue = await screen.findByTestId("queued-message-list");
    const queuedId =
      within(pendingQueue).getByTestId("chat-queued-message").getAttribute("data-queued-message-id") ??
      "";
    await user.click(
      within(pendingQueue).getByRole("button", {
        name: "Steer the run with this message",
      }),
    );
    await waitFor(() => expect(releaseSteer).not.toBeNull());

    inner.consumeQueuedMessage(queuedId);
    await waitFor(() =>
      expect(
        within(pendingQueue).queryByRole("button", {
          name: "Steer the run with this message",
        }),
      ).not.toBeInTheDocument(),
    );

    await act(async () => {
      releaseSteer?.();
    });

    expect(await within(pendingQueue).findByText("Steered")).toBeInTheDocument();
  });

  it("syncs the waiting-area and shows the error when steer_from_queue returns ok:false", async () => {
    const user = userEvent.setup();
    const inner = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:10:00.000Z",
    });
    const bridge = {
      ...inner,
      steerFromQueue: async (input: { piSessionId: string; queuedMessageId: string }) => ({
        ok: false as const,
        error: "steer failed",
        queuedMessages: [
          {
            id: input.queuedMessageId,
            piSessionId: input.piSessionId,
            body: "Back in the follow-up queue",
            status: "pending" as const,
            createdAt: "2026-06-26T08:10:00.000Z",
          },
        ],
      }),
    };
    await renderRunningQueue(bridge);

    await user.type(
      screen.getByPlaceholderText("Queue the next task…"),
      "Back in the follow-up queue",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    const pendingQueue = await screen.findByTestId("queued-message-list");
    await user.click(
      within(pendingQueue).getByRole("button", {
        name: "Steer the run with this message",
      }),
    );

    expect(await screen.findByText("steer failed")).toBeInTheDocument();
    expect(within(pendingQueue).queryByText("Steered")).not.toBeInTheDocument();
    expect(
      within(pendingQueue).getByRole("button", {
        name: "Steer the run with this message",
      }),
    ).toBeInTheDocument();
  });

  it("opens a global Session Draft from New Chat without adding a Project row", async () => {
    const user = userEvent.setup();

    renderProjectSessions();

    const projectNavigation = await findProjectSessionsGroupByName("Pig");
    const trajectoryUsageNavigation = screen.getByRole("group", {
      name: "Trajectory and usage navigation",
    });
    const initialRows = getSidebarSessionRows(projectNavigation);

    await user.click(within(trajectoryUsageNavigation).getByRole("button", { name: "New Chat" }));

    const draftComposer = await screen.findByTestId("session-draft-composer");
    const emptyState = within(draftComposer).getByTestId("session-draft-empty-state");
    const draftTitle = within(draftComposer).getByRole("heading", {
      name: "Build something useful with Pace",
    });
    const shimmerText = within(draftTitle).getByText("Pace");
    const suggestionRoot = emptyState.querySelector('[data-slot="prompt-suggestion"]');
    const suggestionItems = emptyState.querySelector(
      '[data-slot="prompt-suggestion-items"]',
    );
    const suggestedPrompt = "Explain this repo's architecture";
    const suggestedLabels = [
      "Explain this repo's architecture",
      "Fix the failing test",
      "Add a CLI flag with docs",
      "Review my uncommitted changes",
    ];
    const suggestedAction = within(draftComposer).getByRole("button", {
      name: suggestedPrompt,
    });
    const draftPrompt = within(draftComposer).getByPlaceholderText(
      "Do anything with Pi",
    );
    const promptInput = draftPrompt.closest('[data-slot="prompt-input"]');
    // The composer surface is the Astryx ChatComposer shell now.
    const promptInputShell = promptInput?.querySelector(".astryx-chat-composer");
    const projectPicker = within(draftComposer).getByTestId(
      "session-draft-project-picker",
    );
    const projectPickerControl = within(projectPicker).getByTestId("project-picker");
    const projectPickerTrigger = within(projectPickerControl).getByTestId(
      "project-picker-trigger",
    );
    const projectPickerIcon = within(projectPickerControl).getByTestId(
      "project-picker-folder-icon",
    );
    const inlineProjectSelect = projectPicker.querySelector(".astryx-selector");
    const inlineProjectIndicator = projectPicker.querySelector(
      ".astryx-selector-indicator-icon",
    );
    const nativeProjectSelect = projectPicker.querySelector("select");

    expect(draftComposer).toHaveClass("items-center", "justify-center");
    // One width from the draft through the Live Session, so the handoff never
    // resizes the composer.
    expect(emptyState).toHaveClass("max-w-[44rem]");
    expect(draftComposer.closest(".card")).toBeNull();
    expect(suggestionRoot).toHaveClass("prompt-suggestion--pill");
    expect(suggestionItems).toHaveClass("prompt-suggestion__items--pill");
    expect(suggestionRoot?.querySelector(".prompt-suggestion__item-end-icon")).toBeNull();
    if (!promptInput || !promptInputShell || !suggestionRoot) {
      throw new Error("Session Draft composer layout is incomplete.");
    }
    expect(promptInputShell).toBeInTheDocument();
    expect(
      Boolean(
        promptInput.compareDocumentPosition(suggestionRoot) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    // Project is a draft-only input, so it sits above the composer and leaves
    // with the title; the composer's own Location row outlives the handoff.
    expect(
      Boolean(
        promptInput.compareDocumentPosition(projectPickerTrigger) &
          Node.DOCUMENT_POSITION_PRECEDING,
      ),
    ).toBe(true);
    expect(
      Boolean(
        projectPickerTrigger.compareDocumentPosition(suggestionRoot) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(projectPicker).toHaveClass("w-full", "justify-center");
    expect(projectPickerControl).not.toHaveClass("w-[9rem]");
    expect(projectPickerControl).not.toHaveClass(
      "w-[clamp(7rem,calc(var(--project-picker-label-ch)*1ch+4.75rem),16rem)]",
    );
    expect(projectPickerControl).not.toHaveAttribute("style");
    expect(projectPickerControl).toContainElement(projectPickerTrigger);
    expect(projectPickerIcon).toHaveAttribute("aria-hidden", "true");
    expect(projectPickerIcon).toHaveClass("text-muted");
    expect(projectPickerTrigger).toHaveTextContent("No project");
    expect(
      within(projectPickerControl).getByRole("combobox", {
        name: /Project/,
      }),
    ).toBeInTheDocument();
    expect(inlineProjectSelect).toBeInTheDocument();
    expect(inlineProjectIndicator).toBeInTheDocument();
    expect(nativeProjectSelect).not.toBeInTheDocument();
    expect(
      within(suggestedAction).getByTestId("session-draft-suggestion-icon"),
    ).toBeInTheDocument();
    expect(shimmerText).toHaveAttribute("data-slot", "text-shimmer");
    expect(shimmerText).toHaveClass("text-shimmer", "text-shimmer--brand");
    expect(shimmerText).toHaveAttribute("data-tone", "brand");
    for (const label of suggestedLabels) {
      expect(
        within(draftComposer).getByRole("button", { name: label }),
      ).toBeInTheDocument();
    }
    expect(suggestionRoot).toHaveClass("max-w-[35rem]");
    expect(
      within(draftComposer).queryByText(
        "Start with a prompt, add files, or pick a suggestion to shape the first response.",
      ),
    ).not.toBeInTheDocument();
    expect(draftTitle).toHaveClass("text-center");
    // The Selector label is only exposed to assistive tech, never as a
    // visible caption above the picker.
    expect(within(draftComposer).getByText("Project")).toHaveClass(
      "astryx-field-label",
    );
    expect(
      within(draftComposer).queryByText(
        "Start a new Pi Session from a focused prompt.",
      ),
    ).not.toBeInTheDocument();
    expect(within(draftComposer).queryByText("Session Draft")).not.toBeInTheDocument();
    expect(draftPrompt).not.toHaveClass("font-medium");
    expect(projectPickerTrigger).not.toHaveClass("font-medium");
    expect(getSessionDraft()).toMatchObject({
      projectId: "chat",
      prompt: "",
    });

    await user.click(suggestedAction);

    expect(draftPrompt).toHaveValue(suggestedPrompt);
    expect(getSessionDraft()).toMatchObject({
      projectId: "chat",
      prompt: suggestedPrompt,
    });
    expect(getSidebarSessionRows(projectNavigation)).toHaveLength(
      initialRows.length,
    );
    expect(
      within(projectNavigation).queryByRole("button", { name: "New Chat" }),
    ).not.toBeInTheDocument();
    expect(within(projectNavigation).queryByText("Session Draft")).not.toBeInTheDocument();

    await user.click(projectPickerTrigger);

    expectAdaptiveInlineSelectPopover(getOpenSelectorListbox());
    expectInlineSelectOptionIsAstryxOption(
      await screen.findByRole("option", { name: "No project" }),
    );
    expectInlineSelectOptionLabelMatchesCompactMenu(
      await screen.findByRole("option", { name: "No project" }),
      "No project",
    );
  });

  it("clears target validation when another control selects a valid chat target", async () => {
    const user = userEvent.setup();
    saveSessionDraft(null, "Keep this draft while choosing its target");
    renderProjectSessions("/projects/pig/sessions?view=draft");

    await user.click(await screen.findByRole("button", { name: "Send" }));
    const composer = screen.getByTestId("session-draft-composer");
    expect(within(composer).getByText("Choose a project or select No project to continue.")).toBeInTheDocument();

    act(() => { setSessionDraftTarget("chat"); });

    await waitFor(() => {
      expect(within(composer).queryByText("Choose a project or select No project to continue.")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("project-picker-trigger")).toHaveTextContent("No project");
    expect(screen.getByPlaceholderText("Do anything with Pi")).toHaveValue(
      "Keep this draft while choosing its target",
    );
  });

  it("only shows the draft composer when draft view is selected", async () => {
    saveSessionDraft("pig", "Keep this draft available");

    renderProjectSessions("/projects/pig/sessions");

    const liveColumn = await screen.findByTestId("live-session-column");

    expect(within(liveColumn).queryByTestId("session-draft-composer")).not.toBeInTheDocument();
    // Session hydration settles asynchronously after the column mounts.
    expect(
      (await within(liveColumn).findAllByText("Agent Workspace shell")).length,
    ).toBeGreaterThan(0);
    expect(
      within(liveColumn).getByPlaceholderText("Queue the next task…"),
    ).toBeInTheDocument();
  });

  it("hides the previous session dock when opening a project chat draft", async () => {
    const user = userEvent.setup();
    renderProjectSessions();
    await user.click(await screen.findByRole("button", { name: "Session dock" }));
    expect(await screen.findByTestId("session-dock")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New Chat for Pig" }));
    expect(await screen.findByTestId("session-draft-composer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Session dock" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-dock")).not.toBeInTheDocument();
  });

  it("offers an optional project and hides execution choices for a new chat", async () => {
    const user = userEvent.setup();
    renderProjectSessions();
    const navigation = await screen.findByRole("group", { name: "Trajectory and usage navigation" });
    await user.click(within(navigation).getByRole("button", { name: /^New (Chat|Session)$/ }));

    expect(screen.queryByRole("button", { name: "Session dock" })).not.toBeInTheDocument();
    expect(screen.getByTestId("project-picker-trigger")).toHaveTextContent("No project");
    expect(screen.queryByTestId("checkout-strategy-trigger")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("project-picker-trigger"));
    expect(screen.getByRole("option", { name: /No project/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Select Project" })).not.toBeInTheDocument();
  });

  it("restores the same global draft after repeated New Chat clicks and reload", async () => {
    const user = userEvent.setup();
    const firstRender = renderProjectSessions();

    await user.click(await screen.findByRole("button", { name: "New Chat" }));
    fireEvent.change(screen.getByPlaceholderText("Do anything with Pi"), {
      target: { value: "Keep this initial prompt" },
    });

    expect(getSessionDraft()).toMatchObject({
      projectId: "chat",
      prompt: "Keep this initial prompt",
    });

    await user.click(screen.getByRole("button", { name: "New Chat" }));

    expect(screen.getByPlaceholderText("Do anything with Pi")).toHaveValue(
      "Keep this initial prompt",
    );

    firstRender.unmount();
    renderProjectSessions("/projects/pig/sessions?view=draft");

    expect(await screen.findByPlaceholderText("Do anything with Pi")).toHaveValue(
      "Keep this initial prompt",
    );
  });

  it("lists only visible models and opens Models settings over the workspace", async () => {
    const user = userEvent.setup();
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_session_projections") {
        return [];
      }

      if (command === "list_provider_auth_status") {
        return {
          agentDir: "",
          authPath: "",
          configuredCount: 1,
          providers: [],
        };
      }

      if (command === "list_available_model_controls") {
        return {
          models: [
            {
              provider: "deepseek",
              modelId: "deepseek-chat",
              name: "DeepSeek Chat",
              thinkingLevels: ["off"],
            },
            {
              provider: "openai-codex",
              modelId: "gpt-5.6-sol",
              name: "GPT-5.6 SOL",
              thinkingLevels: ["off", "low", "medium", "high"],
            },
          ],
          selected: {
            provider: "deepseek",
            modelId: "deepseek-chat",
            thinkingLevel: "off",
          },
        };
      }

      if (command === "get_config_inventory") {
        return {
          skills: [],
          extensions: [],
          packages: [],
          promptTemplates: [],
        };
      }

      throw new Error(`unexpected backend command ${command}`);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };
    saveLastModelSelection({
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
    });
    saveVisibleModels([{ provider: "openai-codex", modelId: "gpt-5.6-sol" }]);
    saveSessionDraft(pigProjectPath, "");

    const { router } = renderProjectSessions("/projects/pig/sessions?view=draft");

    await user.click(await screen.findByTestId("model-thinking-trigger"));

    const modelList = await screen.findByTestId("model-thinking-model-list");

    expect(within(modelList).getByText("GPT-5.6 SOL")).toBeInTheDocument();
    expect(within(modelList).queryByText("DeepSeek Chat")).not.toBeInTheDocument();

    await user.click(screen.getByText("Add Models"));

    await waitFor(() => expect(router.state.location.search).toMatchObject({ view: "draft", settings: "models" }));
    expect(router.state.location.pathname).toContain("/sessions");
    expect(screen.getByTestId("model-thinking-trigger")).toBeInTheDocument();
  });

  it("submits the draft through Session Creation, clears the draft, and shows the first runtime event", async () => {
    const user = userEvent.setup();
    const onDraftSubmit = vi.fn();

    saveSessionDraft("pig-docs", "Summarize the docs ADR");
    render(
      <FixtureSessionsView
        projectId="pig-docs"
        showDraft
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "session-docs-review",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
        onDraftSubmit={onDraftSubmit}
        sessionCreator={(input) =>
          createSessionFromDraft({
            ...input,
            bridge: createInMemoryPiRuntimeBridge({
              now: () => "2026-06-26T08:00:03.000Z",
            }),
            idFactory: () => "session-created",
            now: () => "2026-06-26T08:00:00.000Z",
          })
        }
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onDraftSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutMode: "local",
        projectId: "pig-docs",
        prompt: "Summarize the docs ADR",
      }),
    );
    await waitFor(() => expect(getSessionDraft("pig-docs")).toBeNull());
    expect(screen.queryByTestId("session-draft-composer")).not.toBeInTheDocument();
    expect(screen.getAllByText("Summarize the docs ADR").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Live Chat messages")).toBeInTheDocument();
  });

  it("retargets the global Session Draft from the composer without clearing text", async () => {
    const user = userEvent.setup();

    addProjectToRegistry(pigProjectPath, {
      now: () => "2026-06-30T08:00:00.000Z",
    });
    addProjectToRegistry(studyProjectPath, {
      now: () => "2026-06-30T09:00:00.000Z",
    });
    saveSessionDraft(pigProjectPath, "Keep this prompt while switching target");
    render(
      <FixtureSessionsView
        projectId={pigProjectPath}
        showDraft
        workspace={{
          id: pigProjectPath,
          name: "Pig",
          projectRoot: pigProjectPath,
          repoRoot: pigProjectPath,
          selectedSessionId: "session-docs-review",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: pigProjectPath,
            runtimeCwd: pigProjectPath,
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    const promptInput = await screen.findByPlaceholderText("Do anything with Pi");
    const projectPickerTrigger = screen.getByTestId("project-picker-trigger");
    const projectPickerControl = screen.getByTestId("project-picker");

    expect(promptInput).toHaveValue("Keep this prompt while switching target");
    expect(projectPickerTrigger).toHaveTextContent("Pig");
    expect(projectPickerControl).not.toHaveAttribute("style");

    await chooseProjectFromPicker(user, "study");

    expect(promptInput).toHaveValue("Keep this prompt while switching target");
    expect(projectPickerTrigger).toHaveTextContent("study");
    expect(getSessionDraft()).toMatchObject({
      projectId: studyProjectPath,
      prompt: "Keep this prompt while switching target",
    });
  });

  it("submits registry Project drafts without inventing a repoRoot", async () => {
    const user = userEvent.setup();
    type CapturedProject = {
      id: string;
      repoRoot?: string;
      projectRoot: string;
    };
    let capturedProject: CapturedProject | null = null;

    addProjectToRegistry(studyProjectPath, {
      now: () => "2026-06-30T09:00:00.000Z",
    });
    saveSessionDraft(studyProjectPath, "Run notes outside Git");
    render(
      <FixtureSessionsView
        projectId={studyProjectPath}
        showDraft
        workspace={{
          id: studyProjectPath,
          name: "study",
          projectRoot: studyProjectPath,
          repoRoot: studyProjectPath,
          selectedSessionId: "session-study-review",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: studyProjectPath,
            runtimeCwd: studyProjectPath,
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
        sessionCreator={async (input) => {
          capturedProject = input.project;

          return {
            ok: false,
            clearDraft: false,
            projection: createSessionProjection({
              id: "session-study-created",
              projectId: input.project.id,
              initialPrompt: input.draft.prompt,
              createdAt: "2026-06-30T08:00:00.000Z",
            }),
          };
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(capturedProject).toMatchObject({
        id: studyProjectPath,
        projectRoot: studyProjectPath,
      });
    });
    expect((capturedProject as CapturedProject | null)?.repoRoot).toBeUndefined();
  });

  it("blocks Session Draft submit when the restored target Project is missing", async () => {
    const user = userEvent.setup();
    const onDraftSubmit = vi.fn();

    addProjectToRegistry(pigProjectPath, {
      now: () => "2026-06-30T08:00:00.000Z",
    });
    saveSessionDraft("/Users/void/DeletedProject", "Keep text after target removal");
    render(
      <FixtureSessionsView
        projectId={pigProjectPath}
        showDraft
        workspace={{
          id: pigProjectPath,
          name: "Pig",
          projectRoot: pigProjectPath,
          repoRoot: pigProjectPath,
          selectedSessionId: "session-docs-review",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: pigProjectPath,
            runtimeCwd: pigProjectPath,
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
        onDraftSubmit={onDraftSubmit}
      />,
    );

    expect(await screen.findByPlaceholderText("Do anything with Pi")).toHaveValue(
      "Keep text after target removal",
    );
    expect(screen.getByTestId("project-picker-trigger")).toHaveTextContent(
      "Choose a project",
    );

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onDraftSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Choose a project or select No project to continue.")).toBeInTheDocument();
    expect(getSessionDraft()).toMatchObject({
      projectId: null,
      prompt: "Keep text after target removal",
    });
  });

  it("queues follow-up input after creating a default active Session", async () => {
    const user = userEvent.setup();

    saveSessionDraft("pig-docs", "Start an active browser-backed Session");
    render(
      <FixtureSessionsView
        projectId="pig-docs"
        showDraft
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "session-docs-review",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await within(screen.getByTestId("live-session-column")).findByRole("button", {
        name: "Stop",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Queue is the default while Pi is running."),
    ).not.toBeInTheDocument();

    const liveColumn = screen.getByTestId("live-session-column");

    await user.type(
      within(liveColumn).getByPlaceholderText("Queue the next task…"),
      "Queue this follow-up after creation",
    );
    await user.click(within(liveColumn).getByRole("button", { name: "Send" }));

    const pendingQueue = await screen.findByTestId("queued-message-list");

    expect(
      within(pendingQueue).getByText("Queue this follow-up after creation"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Live Chat messages")).queryByText(
        "Queue this follow-up after creation",
      ),
    ).not.toBeInTheDocument();
  });

  it("defaults Session Draft checkout to local and still creates a managed worktree when chosen", async () => {
    const user = userEvent.setup();
    const createdWorktrees: string[] = [];
    const checkoutManager = createExecutionCheckoutManager({
      worktreesRoot: "/tmp/pig-worktrees",
      gitClient: {
        async isGitRepository() {
          return true;
        },
        async addDetachedWorktree({ checkoutRoot }) {
          createdWorktrees.push(checkoutRoot);
        },
      },
    });
    let activeProjection = applySessionProjectionEvent(
      createSessionProjection({
        id: "active-session",
        projectId: "pig-docs",
        initialPrompt: "Keep the existing Session active",
        createdAt: "2026-06-27T08:00:00.000Z",
      }),
      {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime-active",
        piSessionId: "pi-session-active",
        occurredAt: "2026-06-27T08:00:01.000Z",
      },
    );

    activeProjection = applySessionProjectionEvent(activeProjection, {
      type: "runtime-event-received",
      stage: "accepted",
      event: {
        id: "runtime-event-active-user",
        piSessionId: "pi-session-active",
        kind: "message",
        role: "user",
        body: "Keep the existing Session active",
        timestamp: "2026-06-27T08:00:02.000Z",
      },
    });
    saveSessionDraft("pig-docs", "Run in an isolated background checkout");
    const store = storeWith(createInMemoryPiRuntimeBridge(), activeProjection);
    render(
      <FixtureSessionsView
        checkoutManager={checkoutManager}
        projectId="pig-docs"
        showDraft
        sessionId="active-session"
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/packages/web",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "active-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/packages/web",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
      { store },
    );

    expect(screen.getByTestId("checkout-strategy-trigger")).toHaveTextContent(
      "Project folder",
    );
    await user.click(screen.getByTestId("checkout-strategy-trigger"));
    const localCheckoutOption = await screen.findByRole("option", { name: /Project folder/ });
    const worktreeCheckoutOption = await screen.findByRole("option", {
      name: /Git worktree/,
    });

    expect(
      within(localCheckoutOption).getByTestId("checkout-strategy-local-icon"),
    ).toHaveClass("pigui-compact-menu-item-icon");
    expect(worktreeCheckoutOption).toBeInTheDocument();
    expectInlineSelectOptionIsAstryxOption(worktreeCheckoutOption);
    expectInlineSelectOptionLabelMatchesCompactMenu(
      worktreeCheckoutOption,
      "Git worktree",
    );
    expectAdaptiveInlineSelectPopover(getOpenSelectorListbox());
    await user.click(worktreeCheckoutOption);

    await user.click(screen.getByRole("button", { name: "Send" }));

    const createdProjection = await waitFor(() => {
      const latest = store.list().find((projection) => projection.id !== "active-session");

      expect(latest?.initialPrompt).toBe("Run in an isolated background checkout");
      expect(latest?.checkout?.mode).toBe("managed-worktree");

      return latest;
    });

    expect(createdProjection?.checkout?.executionCheckoutRoot).toMatch(
      /^\/tmp\/pig-worktrees\/session-/,
    );
    expect(createdProjection?.checkout?.runtimeCwd).toBe(
      `${createdProjection?.checkout?.executionCheckoutRoot}/packages/web`,
    );
    expect(createdWorktrees).toHaveLength(1);
  });

  it("lets users choose a local checkout even when another Session is active", async () => {
    const user = userEvent.setup();
    const createdWorktrees: string[] = [];
    const checkoutManager = createExecutionCheckoutManager({
      worktreesRoot: "/tmp/pig-worktrees",
      gitClient: {
        async isGitRepository() {
          return true;
        },
        async addDetachedWorktree({ checkoutRoot }) {
          createdWorktrees.push(checkoutRoot);
        },
      },
    });
    let activeProjection = applySessionProjectionEvent(
      createSessionProjection({
        id: "active-session",
        projectId: "pig-docs",
        initialPrompt: "Keep the existing Session active",
        createdAt: "2026-06-27T08:00:00.000Z",
      }),
      {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: "runtime-active",
        piSessionId: "pi-session-active",
        occurredAt: "2026-06-27T08:00:01.000Z",
      },
    );

    activeProjection = applySessionProjectionEvent(activeProjection, {
      type: "runtime-event-received",
      stage: "accepted",
      event: {
        id: "runtime-event-active-user",
        piSessionId: "pi-session-active",
        kind: "message",
        role: "user",
        body: "Keep the existing Session active",
        timestamp: "2026-06-27T08:00:02.000Z",
      },
    });
    saveSessionDraft("pig-docs", "Run beside an active Session in place");
    const store = storeWith(createInMemoryPiRuntimeBridge(), activeProjection);
    render(
      <FixtureSessionsView
        checkoutManager={checkoutManager}
        projectId="pig-docs"
        showDraft
        sessionId="active-session"
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/packages/web",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "active-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/packages/web",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
      { store },
    );

    expect(screen.getByTestId("checkout-strategy-trigger")).toHaveTextContent(
      "Project folder",
    );

    await user.click(screen.getByTestId("checkout-strategy-trigger"));
    await user.click(await screen.findByRole("option", { name: /Project folder/ }));

    const checkoutStrategyTrigger = screen.getByTestId("checkout-strategy-trigger");

    expect(checkoutStrategyTrigger).toHaveTextContent("Project folder");
    expect(
      within(checkoutStrategyTrigger).getByTestId("checkout-strategy-local-icon"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));

    const createdProjection = await waitFor(() => {
      const latest = store.list().find((projection) => projection.id !== "active-session");

      expect(latest?.initialPrompt).toBe("Run beside an active Session in place");
      expect(latest?.checkout?.mode).toBe("foreground-local");

      return latest;
    });

    expect(createdProjection?.checkout?.executionCheckoutRoot).toBe(
      "/Users/void/code/opensource/Pig",
    );
    expect(createdProjection?.checkout?.runtimeCwd).toBe(
      "/Users/void/code/opensource/Pig/packages/web",
    );
    expect(createdWorktrees).toHaveLength(0);
  });

  it("forks a user message into a managed worktree and pre-fills the new composer", async () => {
    const user = userEvent.setup();
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-07-03T12:10:00.000Z",
    });
    const createdWorktrees: string[] = [];
    const checkoutManager = createExecutionCheckoutManager({
      worktreesRoot: "/tmp/pig-worktrees",
      gitClient: {
        async isGitRepository() {
          return true;
        },
        async addDetachedWorktree({ checkoutRoot }) {
          createdWorktrees.push(checkoutRoot);
        },
      },
    });
    const sourceProjection: SessionProjection = {
      ...createSessionProjection({
        id: "source-session",
        projectId: "pig-docs",
        initialPrompt: "Earlier user",
        createdAt: "2026-07-03T12:00:00.000Z",
      }),
      status: "completed",
      creationStage: "accepted",
      runtimeId: "pi-sdk:source-session",
      piSessionId: "pi-session-source",
      sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-source.jsonl",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      runtimeEvents: [
        {
          id: "evt-source-user",
          piSessionId: "pi-session-source",
          kind: "message",
          role: "user",
          body: "Revise this branch",
          messageId: "pi-sdk:pi-session-source:user:1",
          piEntryId: "pi-entry-user-2",
          timestamp: "2026-07-03T12:00:01.000Z",
        },
      ],
      updatedAt: "2026-07-03T12:00:01.000Z",
    };

    const forkSession = vi.fn(
      async (input: ForkSessionInput): Promise<ForkSessionResult> => ({
        selectedText: "Revise this branch",
        state: {
          piSessionId: "pi-session-forked",
          runtimeId: `pi-sdk:${input.sessionId}`,
          projectId: input.projectId,
          cwd: input.cwd,
          status: "idle",
          sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-forked.jsonl",
          events: [
            {
              id: "evt-fork-marker",
              piSessionId: "pi-session-forked",
              kind: "message",
              role: "user",
              body: "Earlier user",
              piEntryId: "pi-entry-user-1",
              timestamp: "2026-07-03T12:10:00.000Z",
            },
          ],
          updatedAt: "2026-07-03T12:10:00.000Z",
        },
      }),
    );

    bridge.forkSession = forkSession;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    // Stands in for the page, which moves its selection to the fork.
    function ForkHarness() {
      const [sessionId, setSessionId] = useState(sourceProjection.id);

      return (
      <FixtureSessionsView
        checkoutManager={checkoutManager}
        projectId="pig-docs"
        runtimeBridge={bridge}
        sessionId={sessionId}
        onSessionCreationStarted={(projection) => setSessionId(projection.id)}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "source-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />
      );
    }
    const store = storeWith(bridge, sourceProjection);
    render(<ForkHarness />, { store });

    const sourceMessage = (await screen.findByText("Revise this branch")).closest(
      '[data-slot="chat-message-user"]',
    );
    const sourceActions = sourceMessage?.querySelector(
      '[data-slot="chat-message-actions"]',
    );

    expect(sourceActions).toBeInTheDocument();

    await user.click(
      within(sourceActions as HTMLElement).getByRole("button", { name: "Fork from message" }),
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Fork this message into a new Session?"),
    );
    const forkInput = forkSession.mock.calls[0]?.[0];

    if (!forkInput) {
      throw new Error("forkSession was not called.");
    }

    expect(forkInput).toMatchObject({
      projectId: "pig-docs",
      sourcePiSessionId: "pi-session-source",
      sourceSessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-source.jsonl",
      piEntryId: "pi-entry-user-2",
      cwd: expect.stringMatching(/^\/tmp\/pig-worktrees\/session-/),
      checkout: expect.objectContaining({
        mode: "managed-worktree",
        runtimeCwd: expect.stringMatching(/^\/tmp\/pig-worktrees\/session-.*\/docs$/),
      }),
    });
    expect(createdWorktrees).toHaveLength(1);

    const forkedProjection = await waitFor(() => {
      const latest = store.list().find((projection) => projection.id !== sourceProjection.id);

      expect(latest?.piSessionId).toBe("pi-session-forked");
      expect(latest?.checkout?.mode).toBe("managed-worktree");

      return latest!;
    });

    expect(getFollowUpDraft(forkedProjection.id)?.message).toBe("Revise this branch");
    expect(screen.getByPlaceholderText("What do you want to know?")).toHaveValue(
      "Revise this branch",
    );
  });

  it("does not fork a user message when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-07-03T12:10:00.000Z",
    });
    const createdWorktrees: string[] = [];
    const checkoutManager = createExecutionCheckoutManager({
      worktreesRoot: "/tmp/pig-worktrees",
      gitClient: {
        async isGitRepository() {
          return true;
        },
        async addDetachedWorktree({ checkoutRoot }) {
          createdWorktrees.push(checkoutRoot);
        },
      },
    });
    const sourceProjection: SessionProjection = {
      ...createSessionProjection({
        id: "source-session",
        projectId: "pig-docs",
        initialPrompt: "Earlier user",
        createdAt: "2026-07-03T12:00:00.000Z",
      }),
      status: "completed",
      creationStage: "accepted",
      runtimeId: "pi-sdk:source-session",
      piSessionId: "pi-session-source",
      sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-source.jsonl",
      checkout: {
        mode: "foreground-local",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      runtimeEvents: [
        {
          id: "evt-source-user",
          piSessionId: "pi-session-source",
          kind: "message",
          role: "user",
          body: "Revise this branch",
          messageId: "pi-sdk:pi-session-source:user:1",
          piEntryId: "pi-entry-user-2",
          timestamp: "2026-07-03T12:00:01.000Z",
        },
      ],
      updatedAt: "2026-07-03T12:00:01.000Z",
    };
    const forkSession = vi.fn(
      async (input: ForkSessionInput): Promise<ForkSessionResult> => ({
        selectedText: "Revise this branch",
        state: {
          piSessionId: "pi-session-forked",
          runtimeId: `pi-sdk:${input.sessionId}`,
          projectId: input.projectId,
          cwd: input.cwd,
          status: "idle",
          sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-forked.jsonl",
          events: [],
          updatedAt: "2026-07-03T12:10:00.000Z",
        },
      }),
    );

    bridge.forkSession = forkSession;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    const store = storeWith(bridge, sourceProjection);
    render(
      <FixtureSessionsView
        checkoutManager={checkoutManager}
        projectId="pig-docs"
        runtimeBridge={bridge}
        sessionId={sourceProjection.id}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "source-session",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
      { store },
    );

    const sourceMessage = (await screen.findByText("Revise this branch")).closest(
      '[data-slot="chat-message-user"]',
    );
    const sourceActions = sourceMessage?.querySelector(
      '[data-slot="chat-message-actions"]',
    );

    expect(sourceActions).toBeInTheDocument();

    await user.click(
      within(sourceActions as HTMLElement).getByRole("button", { name: "Fork from message" }),
    );
    await Promise.resolve();

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Fork this message into a new Session?"),
    );
    expect(forkSession).not.toHaveBeenCalled();
    expect(createdWorktrees).toHaveLength(0);
    expect(store.list()).toEqual([sourceProjection]);
    expect(window.localStorage.getItem("pigui.followUpDrafts.v1")).toBeNull();
  });

  it("keeps draft text visible and shows failure detail when Session Creation fails", async () => {
    const user = userEvent.setup();
    const onSessionCreated = vi.fn();

    saveSessionDraft("pig-docs", "Summarize the docs ADR");
    render(
      <FixtureSessionsView
        projectId="pig-docs"
        showDraft
        onSessionCreated={onSessionCreated}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: "session-docs-review",
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "gpt-5-codex",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
        sessionCreator={(input) =>
          createSessionFromDraft({
            ...input,
            bridge: createInMemoryPiRuntimeBridge({
              failAt: "send-initial-prompt",
              failureMessage: "Pi rejected the initial prompt",
            }),
            idFactory: () => "session-failed",
            now: () => "2026-06-26T08:00:00.000Z",
          })
        }
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Session creation failed")).toBeInTheDocument();
    expect(screen.getByText("sending prompt")).toBeInTheDocument();
    expect(screen.getByText("Pi rejected the initial prompt")).toBeInTheDocument();
    expect(getSessionDraft("pig-docs")?.prompt).toBe("Summarize the docs ADR");
    expect(screen.getByPlaceholderText("Do anything with Pi")).toHaveValue(
      "Summarize the docs ADR",
    );
    expect(onSessionCreated).not.toHaveBeenCalled();
  });

  it("renders Live Chat and trace from the structured runtime model when run events own the session", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-model",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const runId = "pi-session-model:run-1";
    const turnId = `${runId}:turn-1`;
    const abandonedId = `${turnId}:msg-1`;
    const answerId = `${turnId}:msg-2`;
    let projection: SessionProjection = {
      ...createSessionProjection({
        id: "session-model",
        projectId: "pig-docs",
        initialPrompt: "Ship the slice",
        createdAt: "2026-07-02T10:00:00.000Z",
      }),
      creationStage: "accepted",
      runtimeId: "pi-sdk:session-model",
      piSessionId: "pi-session-model",
    };

    // Gateway-minted user echo arrives on the legacy stream and is mirrored.
    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      event: {
        id: "user-echo-1",
        piSessionId: "pi-session-model",
        kind: "message",
        role: "user",
        body: "Ship the slice",
        messageId: "pi-sdk:pi-session-model:user:0",
        timestamp: "2026-07-02T10:00:00.500Z",
      },
    });

    const agentEntries = [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "run",
          runId,
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId: abandonedId,
          role: "assistant",
          phase: "end",
          abandoned: true,
          parts: [
            { partId: `${abandonedId}:part-0`, partType: "text", body: "Partial answer before retry" },
          ],
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId: answerId,
          partId: `${answerId}:part-0`,
          partType: "thinking",
          phase: "end",
          bodyMode: "snapshot",
          body: "Inspect the repo first.",
          surface: "trace",
          origin: "sdk",
        } as const,
      },
      {
        seq: 4,
        timestamp: "2026-07-02T10:00:03.500Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId: answerId,
          partId: `${answerId}:part-1`,
          partType: "tool_call",
          phase: "end",
          bodyMode: "snapshot",
          body: '{"path":"AGENTS.md"}',
          toolCallId: "call-1",
          surface: "trace",
          origin: "sdk",
        } as const,
      },
      {
        seq: 5,
        timestamp: "2026-07-02T10:00:04.000Z",
        event: {
          type: "tool",
          runId,
          turnId,
          toolCallId: "call-1",
          phase: "end",
          name: "read_file",
          args: { path: "AGENTS.md" },
          result: { ok: true },
          isError: false,
          surface: "trace",
          origin: "sdk",
        } as const,
      },
      {
        seq: 6,
        timestamp: "2026-07-02T10:00:05.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId: answerId,
          role: "assistant",
          phase: "end",
          parts: [
            { partId: `${answerId}:part-0`, partType: "thinking", body: "Inspect the repo first." },
            {
              partId: `${answerId}:part-1`,
              partType: "tool_call",
              body: '{"path":"AGENTS.md"}',
              toolCallId: "call-1",
            },
            { partId: `${answerId}:part-2`, partType: "text", body: "The slice is shipped." },
          ],
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 7,
        timestamp: "2026-07-02T10:00:06.000Z",
        event: {
          type: "run",
          runId,
          phase: "end",
          trigger: "prompt",
          outcome: "completed",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
    ];

    for (const entry of agentEntries) {
      projection = applySessionProjectionEvent(projection, {
        type: "agent-event-received",
        entry,
      });
    }

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    expect(screen.getByText("Ship the slice")).toBeInTheDocument();
    expect(screen.getByText("The slice is shipped.")).toBeInTheDocument();
    // Abandoned retry partials never render as chat answers.
    expect(screen.queryByText("Partial answer before retry")).not.toBeInTheDocument();
    // The settled burst reads as what it did, with the call's args behind it.
    expect(screen.getByText("Read AGENTS.md")).toBeInTheDocument();
    expect(screen.getByText('{"path":"AGENTS.md"}')).not.toBeVisible();
    expect(screen.getByText("Inspect the repo first.")).toBeInTheDocument();
  });

  it("leaves no empty assistant bubble when a failed run's only model call was abandoned", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-model",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const runId = "pi-session-model:run-1";
    const turnId = `${runId}:turn-1`;
    const abandonedId = `${turnId}:msg-1`;
    let projection: SessionProjection = {
      ...createSessionProjection({
        id: "session-model",
        projectId: "pig-docs",
        initialPrompt: "Ship it",
        createdAt: "2026-07-02T10:00:00.000Z",
      }),
      creationStage: "accepted",
      runtimeId: "pi-sdk:session-model",
      piSessionId: "pi-session-model",
    };

    // The retry threw away the run's only Message and then failed outright, so
    // the Chain of Thought has nothing to show. The failure is the error
    // bubble's to tell; a second, empty bubble above it is just a gap.
    for (const entry of [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "run",
          runId,
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId: abandonedId,
          role: "assistant",
          phase: "start",
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: { type: "status", runId, code: "retrying", surface: "trace", origin: "sdk" } as const,
      },
      {
        seq: 4,
        timestamp: "2026-07-02T10:00:03.500Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId: abandonedId,
          role: "assistant",
          phase: "end",
          abandoned: true,
          parts: [{ partId: `${abandonedId}:part-0`, partType: "text", body: "Par" }],
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 5,
        timestamp: "2026-07-02T10:00:04.000Z",
        event: {
          type: "status",
          runId,
          code: "retry_failed",
          surface: "trace",
          origin: "sdk",
        } as const,
      },
      {
        seq: 6,
        timestamp: "2026-07-02T10:00:04.500Z",
        event: {
          type: "error",
          runId,
          code: "provider_error",
          body: "The provider dropped the connection.",
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 7,
        timestamp: "2026-07-02T10:00:05.000Z",
        event: {
          type: "run",
          runId,
          phase: "end",
          trigger: "prompt",
          outcome: "failed",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
    ]) {
      projection = applySessionProjectionEvent(projection, {
        type: "agent-event-received",
        entry,
      });
    }

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");
    const assistantMessages = liveChat.querySelectorAll<HTMLElement>(
      '[data-slot="chat-message-assistant"]',
    );

    expect(assistantMessages).toHaveLength(1);
    expect(within(assistantMessages[0]).getByText("Run failed")).toBeInTheDocument();
    expect(
      within(assistantMessages[0]).getByText("The provider dropped the connection."),
    ).toBeInTheDocument();
  });

  it("renders a context_change as a centered notice instead of an assistant bubble", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-model",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const runId = "pi-session-model:run-1";
    const turnId = `${runId}:turn-1`;
    const changeId = `${turnId}:msg-1`;
    const answerId = `${turnId}:msg-2`;
    let projection: SessionProjection = {
      ...createSessionProjection({
        id: "session-model",
        projectId: "pig-docs",
        initialPrompt: "Ship it",
        createdAt: "2026-07-02T10:00:00.000Z",
      }),
      creationStage: "accepted",
      runtimeId: "pi-sdk:session-model",
      piSessionId: "pi-session-model",
    };

    for (const entry of [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "run",
          runId,
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "context_change",
          runId,
          turnId,
          messageId: changeId,
          surface: "chat",
          origin: "sdk",
          sectionsChanged: ["skills"],
          sectionsRemoved: [],
          toolsAdded: ["write"],
          toolsRemoved: ["bash"],
        } as const,
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId: answerId,
          role: "assistant",
          phase: "end",
          parts: [{ partId: `${answerId}:part-0`, partType: "text", body: "Shipped." }],
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 4,
        timestamp: "2026-07-02T10:00:04.000Z",
        event: {
          type: "run",
          runId,
          phase: "end",
          trigger: "prompt",
          outcome: "completed",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
    ]) {
      projection = applySessionProjectionEvent(projection, {
        type: "agent-event-received",
        entry,
      });
    }

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");
    expect(within(liveChat).getByRole("status")).toHaveTextContent(
      "Tools changed: +write, −bash · Prompt updated: skills",
    );
    expect(within(liveChat).getByText("Shipped.")).toBeInTheDocument();
    expect(liveChat.querySelectorAll('[data-slot="chat-message-assistant"]')).toHaveLength(1);
  });

  it("discloses a measured model call on a plain answer that leaves no trace steps behind", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-model",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const runId = "pi-session-model:run-1";
    const turnId = `${runId}:turn-1`;
    const answerId = `${turnId}:msg-1`;
    let projection: SessionProjection = {
      ...createSessionProjection({
        id: "session-model",
        projectId: "pig-docs",
        initialPrompt: "Ship it",
        createdAt: "2026-07-02T10:00:00.000Z",
      }),
      creationStage: "accepted",
      runtimeId: "pi-sdk:session-model",
      piSessionId: "pi-session-model",
    };

    // A non-reasoning model: one call, one text part, no thinking, no tools —
    // so the old last-minus-first-step heuristic had nothing to measure.
    for (const entry of [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "run",
          runId,
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId: answerId,
          role: "assistant",
          phase: "start",
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:07.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId: answerId,
          role: "assistant",
          phase: "end",
          parts: [{ partId: `${answerId}:part-0`, partType: "text", body: "Shipped." }],
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 4,
        timestamp: "2026-07-02T10:00:07.000Z",
        event: {
          type: "run",
          runId,
          phase: "end",
          trigger: "prompt",
          outcome: "completed",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
    ]) {
      projection = applySessionProjectionEvent(projection, {
        type: "agent-event-received",
        entry,
      });
    }

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");
    const assistantMessage = liveChat.querySelector<HTMLElement>(
      '[data-slot="chat-message-assistant"]',
    );

    expect(within(assistantMessage!).getByText("Shipped.")).toBeInTheDocument();
    expect(within(assistantMessage!).getByText("Worked for 5s")).toBeInTheDocument();
    // Nothing to expand behind the summary, so it must not pose as a control.
    expect(
      within(assistantMessage!).queryByRole("button", { name: "Worked for 5s" }),
    ).not.toBeInTheDocument();
  });

  it("measures the wait from the run's first model call to the answer, tool time included", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-model",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const runId = "pi-session-model:run-1";
    const firstId = `${runId}:turn-1:msg-1`;
    const secondId = `${runId}:turn-2:msg-1`;
    let projection: SessionProjection = {
      ...createSessionProjection({
        id: "session-model",
        projectId: "pig-docs",
        initialPrompt: "Ship it",
        createdAt: "2026-07-02T10:00:00.000Z",
      }),
      creationStage: "accepted",
      runtimeId: "pi-sdk:session-model",
      piSessionId: "pi-session-model",
    };

    // Two calls in one Active Run: 9s then 2s, with 4s of work between them
    // that belongs to no call. One anchor spans the lot — 10:00:01 to the
    // second call's answer — because that is what the user waited through
    // (ADR-0030 §6); summing the calls alone would drop those 4s.
    for (const entry of [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:00.000Z",
        event: {
          type: "run",
          runId,
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "message",
          runId,
          turnId: `${runId}:turn-1`,
          messageId: firstId,
          role: "assistant",
          phase: "start",
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:09.000Z",
        event: {
          type: "message_part",
          runId,
          turnId: `${runId}:turn-1`,
          messageId: firstId,
          partId: `${firstId}:part-0`,
          partType: "thinking",
          phase: "end",
          bodyMode: "snapshot",
          body: "Read the ADR first.",
          surface: "trace",
          origin: "sdk",
        } as const,
      },
      {
        seq: 4,
        timestamp: "2026-07-02T10:00:10.000Z",
        event: {
          type: "message",
          runId,
          turnId: `${runId}:turn-1`,
          messageId: firstId,
          role: "assistant",
          phase: "end",
          parts: [
            { partId: `${firstId}:part-0`, partType: "thinking", body: "Read the ADR first." },
          ],
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 5,
        timestamp: "2026-07-02T10:00:14.000Z",
        event: {
          type: "message",
          runId,
          turnId: `${runId}:turn-2`,
          messageId: secondId,
          role: "assistant",
          phase: "start",
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 6,
        timestamp: "2026-07-02T10:00:16.000Z",
        event: {
          type: "message",
          runId,
          turnId: `${runId}:turn-2`,
          messageId: secondId,
          role: "assistant",
          phase: "end",
          parts: [{ partId: `${secondId}:part-0`, partType: "text", body: "Shipped." }],
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 7,
        timestamp: "2026-07-02T10:00:16.000Z",
        event: {
          type: "run",
          runId,
          phase: "end",
          trigger: "prompt",
          outcome: "completed",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
    ]) {
      projection = applySessionProjectionEvent(projection, {
        type: "agent-event-received",
        entry,
      });
    }

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");
    const assistantMessages = liveChat.querySelectorAll<HTMLElement>(
      '[data-slot="chat-message-assistant"]',
    );

    expect(assistantMessages).toHaveLength(1);
    expect(within(assistantMessages[0]).getByText("Worked for 15s")).toBeInTheDocument();
  });

  it("renders image parts from a Gateway-minted user echo", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-model",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const runId = "pi-session-model:run-1";
    let projection: SessionProjection = {
      ...createSessionProjection({
        id: "session-model",
        projectId: "pig-docs",
        initialPrompt: "Look at this",
        createdAt: "2026-07-02T10:00:00.000Z",
      }),
      creationStage: "accepted",
      runtimeId: "pi-sdk:session-model",
      piSessionId: "pi-session-model",
    };

    projection = applySessionProjectionEvent(projection, {
      type: "runtime-event-received",
      event: {
        id: "user-echo-1",
        piSessionId: "pi-session-model",
        kind: "message",
        role: "user",
        body: "Look at this",
        messageId: "pi-sdk:pi-session-model:user:0",
        images: [{ mimeType: "image/png", data: "abc", name: "shot.png" }],
        timestamp: "2026-07-02T10:00:00.500Z",
      },
    });
    projection = applySessionProjectionEvent(projection, {
      type: "agent-event-received",
      entry: {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "run",
          runId,
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        },
      },
    });

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    expect(screen.getByText("Look at this")).toBeInTheDocument();
    expect(screen.getByAltText("shot.png")).toHaveAttribute(
      "src",
      "data:image/png;base64,abc",
    );
  });

  it("collapses structured runtime turn messages and attaches their trace to the final assistant answer", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-model",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const runId = "pi-session-model:run-1";
    const turnOneId = `${runId}:turn-1`;
    const turnTwoId = `${runId}:turn-2`;
    const finalTurnId = `${runId}:turn-3`;
    const inspectMessageId = `${turnOneId}:msg-1`;
    const readMessageId = `${turnTwoId}:msg-1`;
    const answerMessageId = `${finalTurnId}:msg-1`;
    let projection: SessionProjection = {
      ...createSessionProjection({
        id: "session-model",
        projectId: "pig-docs",
        initialPrompt: "Inspect the repo",
        createdAt: "2026-07-02T10:00:00.000Z",
      }),
      creationStage: "accepted",
      runtimeId: "pi-sdk:session-model",
      piSessionId: "pi-session-model",
    };

    const agentEntries = [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "run",
          runId,
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "message",
          runId,
          turnId: turnOneId,
          messageId: inspectMessageId,
          role: "assistant",
          phase: "end",
          parts: [
            {
              partId: `${inspectMessageId}:part-0`,
              partType: "thinking",
              body: "Plan the repository inspection.",
            },
            {
              partId: `${inspectMessageId}:part-1`,
              partType: "tool_call",
              body: "{\"command\":\"ls -la\"}",
              toolCallId: "call-list",
            },
          ],
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: {
          type: "tool",
          runId,
          turnId: turnOneId,
          toolCallId: "call-list",
          phase: "end",
          name: "shell",
          args: { command: "ls -la" },
          result: "listed files",
          isError: false,
          surface: "trace",
          origin: "sdk",
        } as const,
      },
      {
        seq: 4,
        timestamp: "2026-07-02T10:00:04.000Z",
        event: {
          type: "message",
          runId,
          turnId: turnTwoId,
          messageId: readMessageId,
          role: "assistant",
          phase: "end",
          parts: [
            {
              partId: `${readMessageId}:part-0`,
              partType: "thinking",
              body: "Read the main instructions next.",
            },
            {
              partId: `${readMessageId}:part-1`,
              partType: "text",
              body: "Intermediate progress should not become a separate answer.",
            },
            {
              partId: `${readMessageId}:part-2`,
              partType: "tool_call",
              body: "{\"path\":\"AGENTS.md\"}",
              toolCallId: "call-read",
            },
          ],
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 5,
        timestamp: "2026-07-02T10:00:05.000Z",
        event: {
          type: "tool",
          runId,
          turnId: turnTwoId,
          toolCallId: "call-read",
          phase: "end",
          name: "read_file",
          args: { path: "AGENTS.md" },
          result: "agent instructions loaded",
          isError: false,
          surface: "trace",
          origin: "sdk",
        } as const,
      },
      {
        seq: 6,
        timestamp: "2026-07-02T10:00:06.000Z",
        event: {
          type: "message",
          runId,
          turnId: finalTurnId,
          messageId: answerMessageId,
          role: "assistant",
          phase: "end",
          parts: [
            {
              partId: `${answerMessageId}:part-0`,
              partType: "thinking",
              body: "Summarize the inspection.",
            },
            {
              partId: `${answerMessageId}:part-1`,
              partType: "text",
              body: "This repository is ready to inspect.",
            },
          ],
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 7,
        timestamp: "2026-07-02T10:00:07.000Z",
        event: {
          type: "run",
          runId,
          phase: "end",
          trigger: "prompt",
          outcome: "completed",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
    ];

    for (const entry of agentEntries) {
      projection = applySessionProjectionEvent(projection, {
        type: "agent-event-received",
        entry,
      });
    }

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");
    const assistantMessages = liveChat.querySelectorAll<HTMLElement>(
      '[data-slot="chat-message-assistant"]',
    );

    expect(assistantMessages).toHaveLength(1);
    expect(within(assistantMessages[0]).getByTestId("markdown-renderer")).toHaveTextContent(
      "This repository is ready to inspect.",
    );
    // Not a second bubble: mid-run text is Interim Output and takes its place
    // in the step list, between that Turn's thinking and its tool call.
    expect(
      within(assistantMessages[0])
        .getByText("Intermediate progress should not become a separate answer.")
        .closest('[data-slot="chat-interim-output"]'),
    ).toBeInTheDocument();
    expect(
      within(assistantMessages[0]).getByText("Plan the repository inspection."),
    ).toBeInTheDocument();
    expect(
      within(assistantMessages[0]).getByText("Read the main instructions next."),
    ).toBeInTheDocument();
    expect(
      within(assistantMessages[0]).getByText("Summarize the inspection."),
    ).toBeInTheDocument();
    expect(within(assistantMessages[0]).getByText("Ran ls -la")).toBeInTheDocument();
    // Tool output stays behind the step rows until one is opened.
    expect(within(assistantMessages[0]).getByText("listed files")).not.toBeVisible();
    expect(within(assistantMessages[0]).getByText("Read AGENTS.md")).toBeInTheDocument();
    expect(within(assistantMessages[0]).getByText("agent instructions loaded")).not.toBeVisible();
  });

  it("folds consecutive tool calls into one step that expands to a row per call", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-group",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const runId = "pi-session-group:run-1";
    const turnId = `${runId}:turn-1`;
    const messageId = `${turnId}:msg-1`;
    let projection: SessionProjection = {
      ...createSessionProjection({
        id: "session-group",
        projectId: "pig-docs",
        initialPrompt: "Run the checks",
        createdAt: "2026-07-02T10:00:00.000Z",
      }),
      creationStage: "accepted",
      runtimeId: "pi-sdk:session-group",
      piSessionId: "pi-session-group",
    };

    const agentEntries = [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "run",
          runId,
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "end",
          parts: [
            {
              partId: `${messageId}:part-0`,
              partType: "tool_call",
              body: '{"path":"AGENTS.md"}',
              toolCallId: "call-read",
            },
            {
              partId: `${messageId}:part-1`,
              partType: "tool_call",
              body: '{"command":"grep -rn TODO"}',
              toolCallId: "call-grep",
            },
            {
              partId: `${messageId}:part-2`,
              partType: "text",
              body: "Checks are done.",
            },
          ],
          surface: "chat",
          origin: "sdk",
        } as const,
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: {
          type: "tool",
          runId,
          turnId,
          toolCallId: "call-read",
          phase: "start",
          name: "read_file",
          args: { path: "AGENTS.md" },
          surface: "trace",
          origin: "sdk",
        } as const,
      },
      {
        seq: 4,
        timestamp: "2026-07-02T10:00:04.000Z",
        event: {
          type: "tool",
          runId,
          turnId,
          toolCallId: "call-read",
          phase: "end",
          name: "read_file",
          result: "agent instructions loaded",
          isError: false,
          surface: "trace",
          origin: "sdk",
        } as const,
      },
      {
        seq: 5,
        timestamp: "2026-07-02T10:00:04.500Z",
        event: {
          type: "tool",
          runId,
          turnId,
          toolCallId: "call-grep",
          phase: "start",
          name: "shell",
          args: { command: "grep -rn TODO" },
          surface: "trace",
          origin: "sdk",
        } as const,
      },
      {
        seq: 6,
        timestamp: "2026-07-02T10:00:04.545Z",
        event: {
          type: "tool",
          runId,
          turnId,
          toolCallId: "call-grep",
          phase: "end",
          name: "shell",
          result: "grep: no matches",
          isError: true,
          surface: "trace",
          origin: "sdk",
        } as const,
      },
      {
        seq: 7,
        timestamp: "2026-07-02T10:00:05.000Z",
        event: {
          type: "run",
          runId,
          phase: "end",
          trigger: "prompt",
          outcome: "completed",
          surface: "hidden",
          origin: "sdk",
        } as const,
      },
    ];

    for (const entry of agentEntries) {
      projection = applySessionProjectionEvent(projection, {
        type: "agent-event-received",
        entry,
      });
    }

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");
    const assistantMessage = liveChat.querySelector<HTMLElement>(
      '[data-slot="chat-message-assistant"]',
    );

    // The burst is one step row that says what the batch did and how it went;
    // "the last tool name and a number" would read two calls as one.
    const steps = assistantMessage!.querySelectorAll('[data-slot="chat-tool-step"]');
    expect(steps).toHaveLength(1);
    expect(steps[0]).toHaveTextContent("Read 1 file, ran 1 command");
    expect(steps[0]).toHaveTextContent("1 failed");

    // Expanding gives each call its own production row, never the multi-tool
    // summary form of ChatToolGroup (ADR-0030 §"后果").
    const groups = steps[0].querySelectorAll('[data-slot="chat-tool-group"]');
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveAttribute("data-tool-count", "1");
    expect(groups[0]).toHaveTextContent("read_file");
    expect(groups[0]).toHaveTextContent("AGENTS.md");
    expect(groups[0]).toHaveTextContent("1.0s");
    expect(groups[1]).toHaveTextContent("shell");
    expect(groups[1]).toHaveTextContent("grep -rn TODO");
    // Astryx suppresses duration on errored rows; 45ms is unit-tested instead.

    // isError maps to the error status (a11y error text is rendered).
    expect(within(assistantMessage!).getByText(/grep: no matches/)).toBeInTheDocument();
  });

  it("renders completed Projection data with follow-up composer and without a runtime-unavailable warning", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-docs-review",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const projection = {
      id: "session-1",
      projectId: "pig-docs",
      initialPrompt: "Create a real Pi RPC-backed session",
      title: null,
      cwd: "/Users/void/code/opensource/Pig/docs",
      status: "completed" as const,
      creationStage: "accepted" as const,
      checkout: {
        mode: "foreground-local" as const,
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-rpc",
      sessionFile: null,
      runtimeEvents: [
        {
          id: "runtime-event-user",
          piSessionId: "pi-session-rpc",
          kind: "message" as const,
          role: "user" as const,
          body: "Create a real Pi RPC-backed session",
          timestamp: "2026-06-26T08:00:00.000Z",
        },
        {
          id: "runtime-event-assistant",
          piSessionId: "pi-session-rpc",
          kind: "message" as const,
          role: "assistant" as const,
          body: "Live session is ready.",
          timestamp: "2026-06-26T08:00:04.000Z",
        },
        {
          id: "runtime-event-tool",
          piSessionId: "pi-session-rpc",
          kind: "tool-call" as const,
          title: "read",
          body: "{\"path\":\"AGENTS.md\"}",
          timestamp: "2026-06-26T08:00:05.000Z",
        },
      ],
      runtimeModel: createSessionRuntimeModel(),
      queuedMessages: [],
      pendingConsumedIds: {},
      summary: {
        provider: "openai",
        model: "gpt-5-codex",
        totalTokens: 1280,
        totalCostUsd: 0.012345,
      },
      modelControls: null,
      contextUsage: null,
      stale: false,
      staleReason: null,
      failure: null,
      unreadResult: false,
      archivedAt: null,
      createdAt: "2026-06-26T08:00:00.000Z",
      updatedAt: "2026-06-26T08:00:05.000Z",
    };

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    expect(screen.queryByTestId("runtime-fallback-banner")).not.toBeInTheDocument();
    expect(screen.getByText("Create a real Pi RPC-backed session")).toBeInTheDocument();
    expect(screen.getByText("Live session is ready.")).toBeInTheDocument();
    expect(screen.getByText("Read AGENTS.md")).toBeInTheDocument();
    expect(screen.getByText("{\"path\":\"AGENTS.md\"}")).not.toBeVisible();
    expect(screen.getByPlaceholderText("What do you want to know?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    // Single column too: Chat centers itself, so no outer max-width box may
    // pull its scrollbar away from the window edge.
    expect(
      screen.getByLabelText("Live Chat messages").closest(".max-w-\\[96rem\\]"),
    ).toBeNull();
  });

  it("shows the runtime-unavailable warning for stale Projection data without hiding the composer", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-docs-review",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const projection = {
      ...createSessionProjection({
        id: "session-1",
        projectId: "pig-docs",
        initialPrompt: "Continue a stale session",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      status: "running" as const,
      stale: true,
      staleReason: "runtime event stream disconnected",
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-rpc",
      updatedAt: "2026-06-26T08:00:05.000Z",
    };

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    expect(screen.getByTestId("runtime-fallback-banner")).toHaveTextContent(
      "Runtime unavailable",
    );
    expect(screen.getByTestId("full-chat-composer")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Queue the next task…")).toBeInTheDocument();
  });

  it("updates an open live session's model list when the catalog refresh arrives", async () => {
    window.pace = {
      invoke: vi.fn(async () => {
        throw new Error("unexpected invoke");
      }) as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };
    const user = userEvent.setup();
    const sonnet = {
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      thinkingLevels: ["off" as const, "high" as const],
    };
    const projection = {
      ...createSessionProjection({
        id: "session-catalog-refresh",
        projectId: "pig-docs",
        initialPrompt: "Keep this session",
        createdAt: "2026-09-22T00:00:00.000Z",
      }),
      status: "completed" as const,
      creationStage: "accepted" as const,
      runtimeId: "pi-sdk:session-catalog-refresh",
      piSessionId: "pi-catalog-refresh",
      modelControls: {
        models: [sonnet],
        selected: { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "high" as const },
      },
    };
    const bridge = createInMemoryPiRuntimeBridge();
    render(
      <FixtureSessionsView
        projectId="pig-docs"
        runtimeBridge={bridge}
        sessionProjection={projection}
      />,
    );
    expect(screen.getByTestId("model-thinking-trigger")).toHaveTextContent("Claude Sonnet 4");

    act(() => {
      bridge.pushModelControls("pi-catalog-refresh", {
        models: [
          sonnet,
          {
            provider: "openai",
            modelId: "gpt-4.1",
            name: "GPT-4.1",
            thinkingLevels: ["off"],
          },
        ],
        selected: { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "high" },
      });
    });

    await user.click(screen.getByTestId("model-thinking-trigger"));
    const list = await screen.findByTestId("model-thinking-model-list");
    expect(within(list).getByText("Claude Sonnet 4")).toBeInTheDocument();
    expect(within(list).getByText("GPT-4.1")).toBeInTheDocument();
  });

  it("uses one composer control for the model list and capability-driven Thinking slider", async () => {
    const user = userEvent.setup();
    const models = [
      {
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        thinkingLevels: ["off" as const, "low" as const, "medium" as const, "high" as const],
      },
      {
        provider: "anthropic",
        modelId: "claude-haiku-4",
        name: "Claude Haiku 4",
        thinkingLevels: ["off" as const, "low" as const],
      },
    ];
    const configureModel = vi.fn(async (selection) => ({
      models,
      selected: { ...selection },
    }));
    const bridge = {
      ...createInMemoryPiRuntimeBridge(),
      configureModel,
    };
    const projection = {
      ...createSessionProjection({
        id: "session-model-controls",
        projectId: "pig-docs",
        initialPrompt: "Configure the next run",
        createdAt: "2026-07-19T10:00:00.000Z",
      }),
      cwd: "/Users/void/code/opensource/Pig/docs",
      status: "completed" as const,
      creationStage: "accepted" as const,
      runtimeId: "pi-sdk:session-model-controls",
      piSessionId: "pi-session-model-controls",
      modelControls: {
        models,
        selected: {
          provider: "anthropic",
          modelId: "claude-sonnet-4",
          thinkingLevel: "high" as const,
        },
      },
    };

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        runtimeBridge={bridge}
        sessionProjection={projection}
        workspace={{
          id: "pig-docs",
          name: "Pig Docs",
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          repoRoot: "/Users/void/code/opensource/Pig",
          selectedSessionId: projection.id,
          liveMessages: [],
          runTimeline: [],
          checkout: {
            mode: "Foreground local checkout",
            root: "/Users/void/code/opensource/Pig",
            runtimeCwd: "/Users/void/code/opensource/Pig/docs",
          },
          summary: {
            model: "claude-sonnet-4",
            totalCostUsd: 0,
            totalTokens: 0,
          },
        }}
      />,
    );

    const trigger = screen.getByTestId("model-thinking-trigger");

    expect(trigger).toHaveTextContent("Claude Sonnet 4 · High");
    await user.click(trigger);
    const popover = await screen.findByTestId("model-thinking-popover");

    expect(screen.getByRole("dialog")).toContainElement(popover);
    expect(
      screen.getByRole("textbox", { name: "Search models" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Add Models")).toBeInTheDocument();

    // Selecting another model commits it with the nearest thinking level and
    // opens its options flyout (vertical Reasoning list).
    await user.click(screen.getByText("Claude Haiku 4"));

    await waitFor(() => {
      expect(configureModel).toHaveBeenCalledWith({
        sessionId: "session-model-controls",
        piSessionId: "pi-session-model-controls",
        provider: "anthropic",
        modelId: "claude-haiku-4",
        thinkingLevel: "low",
      });
    });
    expect(trigger).toHaveTextContent("Claude Haiku 4 · Low");

    const flyout = await screen.findByRole("group", {
      name: "Claude Haiku 4 options",
    });

    expect(flyout).toBeInTheDocument();
    expect(within(flyout).getByText("Reasoning")).toBeInTheDocument();
    expect(within(flyout).getByText("Low")).toBeInTheDocument();

    // Picking a reasoning level from the flyout commits model + level.
    await user.click(screen.getByText("Off"));

    await waitFor(() => {
      expect(configureModel).toHaveBeenCalledWith({
        sessionId: "session-model-controls",
        piSessionId: "pi-session-model-controls",
        provider: "anthropic",
        modelId: "claude-haiku-4",
        thinkingLevel: "off",
      });
    });
    expect(trigger).toHaveTextContent("Claude Haiku 4 · Off");
    expect(getLastModelSelection()).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-4",
      thinkingLevel: "off",
    });

    // Search narrows the flat list.
    await user.type(
      screen.getByRole("textbox", { name: "Search models" }),
      "sonnet",
    );
    expect(screen.getByText("Claude Sonnet 4")).toBeInTheDocument();
    expect(screen.queryByText("Claude Haiku 4")).not.toBeInTheDocument();
  });

  it("renders one assistant bubble for read-only streaming updates with the same message identity", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-docs-review",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const projection = {
      ...createSessionProjection({
        id: "session-1",
        projectId: "pig-docs",
        initialPrompt: "测试一下",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      status: "completed" as const,
      creationStage: "accepted" as const,
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-rpc",
      runtimeEvents: [
        {
          id: "runtime-event-assistant-1",
          piSessionId: "pi-session-rpc",
          messageId: "pi-sdk:pi-session-rpc:assistant:0",
          kind: "message" as const,
          role: "assistant" as const,
          body: "我们",
          timestamp: "2026-06-26T08:00:01.000Z",
        },
        {
          id: "runtime-event-assistant-2",
          piSessionId: "pi-session-rpc",
          messageId: "pi-sdk:pi-session-rpc:assistant:0",
          kind: "message" as const,
          role: "assistant" as const,
          body: "我们被",
          timestamp: "2026-06-26T08:00:02.000Z",
        },
        {
          id: "runtime-event-assistant-3",
          piSessionId: "pi-session-rpc",
          messageId: "pi-sdk:pi-session-rpc:assistant:0",
          kind: "message" as const,
          role: "assistant" as const,
          body: "我们被要求",
          timestamp: "2026-06-26T08:00:03.000Z",
        },
      ],
      updatedAt: "2026-06-26T08:00:03.000Z",
    };

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");

    expect(liveChat.querySelectorAll('[data-slot="chat-message-assistant"]')).toHaveLength(1);
    expect(within(liveChat).getByText("我们被要求")).toBeInTheDocument();
    expect(within(liveChat).getByTestId("markdown-renderer")).toHaveTextContent("我们被要求");
    expect(within(liveChat).queryByTestId("stream-markdown-renderer")).not.toBeInTheDocument();
    expect(within(liveChat).queryByText("我们")).not.toBeInTheDocument();
    expect(within(liveChat).queryByText("我们被")).not.toBeInTheDocument();
  });

  it("collapses adjacent read-only duplicate assistant messages without message identity", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-docs-review",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const duplicateBody =
      "收到，流式消息测试正常。当前可以正常接收流式响应。你那边看到消息是逐步出现的吗？";
    const projection = {
      ...createSessionProjection({
        id: "session-1",
        projectId: "pig-docs",
        initialPrompt: "测试一下",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      status: "completed" as const,
      creationStage: "accepted" as const,
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-rpc",
      runtimeEvents: [
        {
          id: "runtime-event-assistant-1",
          piSessionId: "pi-session-rpc",
          kind: "message" as const,
          role: "assistant" as const,
          body: duplicateBody,
          timestamp: "2026-06-26T08:00:01.000Z",
        },
        {
          id: "runtime-event-assistant-2",
          piSessionId: "pi-session-rpc",
          kind: "message" as const,
          role: "assistant" as const,
          body: duplicateBody,
          timestamp: "2026-06-26T08:00:02.000Z",
        },
        {
          id: "runtime-event-assistant-3",
          piSessionId: "pi-session-rpc",
          kind: "message" as const,
          role: "assistant" as const,
          body: duplicateBody,
          timestamp: "2026-06-26T08:00:03.000Z",
        },
      ],
      updatedAt: "2026-06-26T08:00:03.000Z",
    };

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");

    expect(liveChat.querySelectorAll('[data-slot="chat-message-assistant"]')).toHaveLength(1);
    expect(within(liveChat).getAllByText(duplicateBody)).toHaveLength(1);
    expect(within(liveChat).getByTestId("markdown-renderer")).toHaveTextContent(duplicateBody);
  });

  it("collapses adjacent duplicate assistant messages even when they have different event identities", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-docs-review",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const duplicateBody = "你好！有什么可以帮你的吗？";
    const projection = {
      ...createSessionProjection({
        id: "session-1",
        projectId: "pig-docs",
        initialPrompt: "你好",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      status: "completed" as const,
      creationStage: "accepted" as const,
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-rpc",
      runtimeEvents: [
        {
          id: "runtime-event-assistant-1",
          piSessionId: "pi-session-rpc",
          messageId: "pi-sdk:pi-session-rpc:assistant:0",
          kind: "message" as const,
          role: "assistant" as const,
          body: duplicateBody,
          timestamp: "2026-06-26T08:00:01.000Z",
        },
        {
          id: "runtime-event-assistant-2",
          piSessionId: "pi-session-rpc",
          messageId: "pi-sdk:pi-session-rpc:assistant:1",
          kind: "message" as const,
          role: "assistant" as const,
          body: duplicateBody,
          timestamp: "2026-06-26T08:00:02.000Z",
        },
        {
          id: "runtime-event-assistant-3",
          piSessionId: "pi-session-rpc",
          messageId: "pi-sdk:pi-session-rpc:assistant:2",
          kind: "message" as const,
          role: "assistant" as const,
          body: duplicateBody,
          timestamp: "2026-06-26T08:00:03.000Z",
        },
      ],
      updatedAt: "2026-06-26T08:00:03.000Z",
    };

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");

    expect(liveChat.querySelectorAll('[data-slot="chat-message-assistant"]')).toHaveLength(1);
    expect(within(liveChat).getAllByText(duplicateBody)).toHaveLength(1);
  });

  it("collapses intermediate assistant run messages into the final answer bubble", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-docs-review",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const projection = {
      ...createSessionProjection({
        id: "session-1",
        projectId: "pig-docs",
        initialPrompt: "测试 DeepSeek 的服务恢复没有",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      status: "completed" as const,
      creationStage: "accepted" as const,
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-sdk",
      runtimeEvents: [
        {
          id: "runtime-event-assistant-1",
          piSessionId: "pi-session-sdk",
          messageId: "pi-sdk:pi-session-sdk:assistant:0",
          kind: "message" as const,
          role: "assistant" as const,
          body: "我来帮你测试 DeepSeek 的服务状态。",
          timestamp: "2026-06-26T08:00:01.000Z",
        },
        {
          id: "runtime-event-thinking-1",
          piSessionId: "pi-session-sdk",
          messageId: "pi-sdk:pi-session-sdk:assistant:0",
          kind: "thinking" as const,
          role: "assistant" as const,
          body: "先确认配置和 endpoint。",
          timestamp: "2026-06-26T08:00:02.000Z",
        },
        {
          id: "runtime-event-assistant-2",
          piSessionId: "pi-session-sdk",
          messageId: "pi-sdk:pi-session-sdk:assistant:1",
          kind: "message" as const,
          role: "assistant" as const,
          body: "API 有响应了！再测试一下 chat completions 端点。",
          timestamp: "2026-06-26T08:00:03.000Z",
        },
        {
          id: "runtime-event-thinking-2",
          piSessionId: "pi-session-sdk",
          messageId: "pi-sdk:pi-session-sdk:assistant:1",
          kind: "thinking" as const,
          role: "assistant" as const,
          body: "继续确认 chat completions。",
          timestamp: "2026-06-26T08:00:04.000Z",
        },
        {
          id: "runtime-event-assistant-3",
          piSessionId: "pi-session-sdk",
          messageId: "pi-sdk:pi-session-sdk:assistant:2",
          kind: "message" as const,
          role: "assistant" as const,
          body: "DeepSeek API 服务已完全恢复，可以正常使用。",
          timestamp: "2026-06-26T08:00:05.000Z",
        },
      ],
      updatedAt: "2026-06-26T08:00:05.000Z",
    };

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");
    const assistantMessages = liveChat.querySelectorAll<HTMLElement>(
      '[data-slot="chat-message-assistant"]',
    );

    expect(assistantMessages).toHaveLength(1);
    // Legacy bridges mint no Message boundaries, so there is nothing to
    // measure and the header carries no number.
    expect(within(assistantMessages[0]).getByRole("button", { name: /^Worked/ })).toBeInTheDocument();
    expect(within(assistantMessages[0]).getByText("先确认配置和 endpoint。")).toBeInTheDocument();
    expect(within(assistantMessages[0]).getByText("继续确认 chat completions。")).toBeInTheDocument();
    expect(within(assistantMessages[0]).getByTestId("markdown-renderer")).toHaveTextContent(
      "DeepSeek API 服务已完全恢复，可以正常使用。",
    );
    expect(
      within(assistantMessages[0]).queryByText("我来帮你测试 DeepSeek 的服务状态。"),
    ).not.toBeInTheDocument();
    expect(
      within(assistantMessages[0]).queryByText("API 有响应了！再测试一下 chat completions 端点。"),
    ).not.toBeInTheDocument();
  });

  it("keeps runtime status events out of the Live Chat message list", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-docs-review",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const projection = {
      ...createSessionProjection({
        id: "session-1",
        projectId: "pig-docs",
        initialPrompt: "你好",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      status: "completed" as const,
      creationStage: "accepted" as const,
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-rpc",
      runtimeEvents: [
        {
          id: "runtime-event-assistant",
          piSessionId: "pi-session-rpc",
          messageId: "pi-sdk:pi-session-rpc:assistant:0",
          kind: "message" as const,
          role: "assistant" as const,
          body: "你好！有什么可以帮你的吗？",
          timestamp: "2026-06-26T08:00:01.000Z",
        },
        {
          id: "runtime-event-completed",
          piSessionId: "pi-session-rpc",
          kind: "status" as const,
          title: "Completed",
          body: "Pi SDK runtime ended the active run.",
          timestamp: "2026-06-26T08:00:02.000Z",
        },
      ],
      updatedAt: "2026-06-26T08:00:02.000Z",
    };

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");

    expect(liveChat.querySelectorAll('[data-slot="chat-message-assistant"]')).toHaveLength(1);
    expect(within(liveChat).getByText("你好！有什么可以帮你的吗？")).toBeInTheDocument();
    expect(within(liveChat).queryByText("Completed")).not.toBeInTheDocument();
    expect(
      within(liveChat).queryByText("Pi SDK runtime ended the active run."),
    ).not.toBeInTheDocument();
  });

  it("uses streaming markdown for the collapsed assistant run bubble", async () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-docs-review",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const projection = {
      ...createSessionProjection({
        id: "session-1",
        projectId: "pig-docs",
        initialPrompt: "测试一下",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      status: "running" as const,
      creationStage: "accepted" as const,
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-rpc",
      runtimeEvents: [
        {
          id: "runtime-event-assistant-1",
          piSessionId: "pi-session-rpc",
          messageId: "pi-sdk:pi-session-rpc:assistant:0",
          kind: "message" as const,
          role: "assistant" as const,
          body: "**Earlier** assistant result",
          timestamp: "2026-06-26T08:00:01.000Z",
        },
        {
          id: "runtime-event-assistant-2",
          piSessionId: "pi-session-rpc",
          messageId: "pi-sdk:pi-session-rpc:assistant:1",
          kind: "message" as const,
          role: "assistant" as const,
          body: "Streaming `markdown` now",
          timestamp: "2026-06-26T08:00:02.000Z",
        },
        {
          id: "runtime-event-tool",
          piSessionId: "pi-session-rpc",
          kind: "tool-call" as const,
          title: "Inspect context",
          body: "Read AGENTS.md",
          timestamp: "2026-06-26T08:00:03.000Z",
        },
      ],
      updatedAt: "2026-06-26T08:00:03.000Z",
    };

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");
    const assistantMessages = liveChat.querySelectorAll<HTMLElement>(
      '[data-slot="chat-message-assistant"]',
    );
    const streamingAssistant = assistantMessages[0];
    const streamingTrace = streamingAssistant.querySelector(
      '[data-slot="chain-of-thought"]',
    );
    const streamingContent = streamingAssistant.querySelector(
      '[data-testid="stream-markdown-renderer"]',
    );

    expect(assistantMessages).toHaveLength(1);
    expect(within(liveChat).queryByTestId("markdown-renderer")).not.toBeInTheDocument();
    // Streamed text renders asynchronously through Astryx incremental parsing.
    await waitFor(() =>
      expect(within(liveChat).getByTestId("stream-markdown-renderer")).toHaveTextContent(
        "Streaming markdown now",
      ),
    );
    expect(within(liveChat).getByTestId("stream-markdown-renderer")).toHaveAttribute(
      "data-is-streaming",
      "true",
    );
    expect(
      within(liveChat).queryByText("**Earlier** assistant result"),
    ).not.toBeInTheDocument();
    expect(liveChat.querySelectorAll('[data-slot="chain-of-thought"]')).toHaveLength(1);
    expect(streamingTrace).toBeInTheDocument();
    expect(streamingContent).toBeInTheDocument();
    expect(
      within(streamingAssistant).getByRole("button", { name: /^Worked/ }),
    ).toBeInTheDocument();
    expect(
      streamingTrace!.compareDocumentPosition(streamingContent!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders assistant trace events above the visible answer without mixing them into markdown", async () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-docs-review",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const projection = {
      ...createSessionProjection({
        id: "session-1",
        projectId: "pig-docs",
        initialPrompt: "测试 Agent Trace 的效果",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      status: "running" as const,
      creationStage: "accepted" as const,
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-sdk",
      runtimeEvents: [
        {
          id: "runtime-event-thinking",
          piSessionId: "pi-session-sdk",
          messageId: "pi-sdk:pi-session-sdk:assistant:0",
          kind: "thinking" as const,
          role: "assistant" as const,
          body: "我需要先检查项目结构。",
          timestamp: "2026-06-26T08:00:01.000Z",
        },
        {
          id: "runtime-event-tool-call",
          piSessionId: "pi-session-sdk",
          messageId: "pi-sdk:pi-session-sdk:assistant:0",
          kind: "tool-call" as const,
          title: "read",
          body: "{\"path\":\"AGENTS.md\"}",
          timestamp: "2026-06-26T08:00:02.000Z",
          toolCallId: "tool-call-1",
        },
        {
          id: "runtime-event-tool-result",
          piSessionId: "pi-session-sdk",
          messageId: "pi-sdk:pi-session-sdk:assistant:0",
          kind: "tool-result" as const,
          title: "read",
          body: "Agent instructions loaded.",
          timestamp: "2026-06-26T08:00:03.000Z",
          toolCallId: "tool-call-1",
        },
        {
          id: "runtime-event-assistant",
          piSessionId: "pi-session-sdk",
          messageId: "pi-sdk:pi-session-sdk:assistant:0",
          kind: "message" as const,
          role: "assistant" as const,
          body: "最终回答只保留结论。",
          timestamp: "2026-06-26T08:00:04.000Z",
        },
      ],
      updatedAt: "2026-06-26T08:00:04.000Z",
    };

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");
    const assistantMessage = liveChat.querySelector<HTMLElement>(
      '[data-slot="chat-message-assistant"]',
    );
    const trace = assistantMessage!.querySelector(
      '[data-slot="chain-of-thought"]',
    );
    const tool = assistantMessage!.querySelector('[data-slot="chat-tool-step"]');
    const streamingContent = assistantMessage!.querySelector(
      '[data-testid="stream-markdown-renderer"]',
    );

    expect(trace).toBeInTheDocument();
    expect(within(assistantMessage!).getByRole("button", { name: /^Worked/ })).toBeInTheDocument();
    // The thinking body is disclosed inside the trace, never in the answer.
    expect(within(assistantMessage!).getByText("我需要先检查项目结构。")).toBeInTheDocument();
    expect(
      assistantMessage!.querySelector('[data-slot="chat-message-actions"]'),
    ).not.toBeInTheDocument();
    expect(tool).toHaveTextContent("Read AGENTS.md");
    // A single call's args and output sit behind the step row, one click away.
    expect(tool!.querySelector('[data-slot="chat-tool-args"]')).not.toBeVisible();
    expect(tool!.querySelector('[data-slot="chat-tool-result"]')).not.toBeVisible();
    await waitFor(() =>
      expect(streamingContent).toHaveTextContent("最终回答只保留结论。"),
    );
    expect(streamingContent).not.toHaveTextContent("我需要先检查项目结构。");
    expect(streamingContent).not.toHaveTextContent("Agent instructions loaded.");
    expect(
      trace!.compareDocumentPosition(streamingContent!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps tool call details collapsed when the assistant trace is expanded", () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-docs-review",
      liveMessages: [],
      runTimeline: [],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const projection = {
      ...createSessionProjection({
        id: "session-1",
        projectId: "pig-docs",
        initialPrompt: "检查 trace 展开态",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      status: "completed" as const,
      creationStage: "accepted" as const,
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-sdk",
      runtimeEvents: [
        {
          id: "runtime-event-thinking",
          piSessionId: "pi-session-sdk",
          messageId: "pi-sdk:pi-session-sdk:assistant:0",
          kind: "thinking" as const,
          role: "assistant" as const,
          body: "先读项目说明。",
          timestamp: "2026-06-26T08:00:01.000Z",
        },
        {
          id: "runtime-event-tool-call",
          piSessionId: "pi-session-sdk",
          messageId: "pi-sdk:pi-session-sdk:assistant:0",
          kind: "tool-call" as const,
          title: "read",
          body: "{\"path\":\"AGENTS.md\"}",
          timestamp: "2026-06-26T08:00:02.000Z",
          toolCallId: "tool-call-1",
        },
        {
          id: "runtime-event-tool-result",
          piSessionId: "pi-session-sdk",
          messageId: "pi-sdk:pi-session-sdk:assistant:0",
          kind: "tool-result" as const,
          title: "read",
          body: "Agent instructions loaded.",
          timestamp: "2026-06-26T08:00:03.000Z",
          toolCallId: "tool-call-1",
        },
        {
          id: "runtime-event-assistant",
          piSessionId: "pi-session-sdk",
          messageId: "pi-sdk:pi-session-sdk:assistant:0",
          kind: "message" as const,
          role: "assistant" as const,
          body: "已经读取项目说明。",
          timestamp: "2026-06-26T08:00:04.000Z",
        },
      ],
      updatedAt: "2026-06-26T08:00:04.000Z",
    };

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");
    const assistantMessage = liveChat.querySelector<HTMLElement>(
      '[data-slot="chat-message-assistant"]',
    );
    const trace = assistantMessage!.querySelector(
      '[data-slot="chain-of-thought"]',
    );
    const tool = assistantMessage!.querySelector('[data-slot="chat-tool-step"]');

    expect(trace).toBeInTheDocument();
    expect(within(assistantMessage!).getByRole("button", { name: /^Worked/ })).toBeInTheDocument();
    expect(assistantMessage!.querySelector('[data-slot="chat-message-actions"]')).toHaveClass(
      "chat-message__actions--persist",
    );
    expect(within(assistantMessage!).getByText("先读项目说明。")).toBeInTheDocument();
    expect(tool).toHaveTextContent("Read AGENTS.md");
    expect(tool!.querySelector('[data-slot="chat-tool-args"]')).not.toBeVisible();
    expect(tool!.querySelector('[data-slot="chat-tool-result"]')).not.toBeVisible();
  });

  it("does not show fixture trace steps when a live Projection has no tool calls", async () => {
    const workspace = {
      id: "pig-docs",
      name: "Pig Docs",
      projectRoot: "/Users/void/code/opensource/Pig/docs",
      repoRoot: "/Users/void/code/opensource/Pig",
      selectedSessionId: "session-docs-review",
      liveMessages: [
        {
          id: "fixture-assistant",
          role: "assistant" as const,
          body: "Fixture fallback should not drive a real Projection.",
        },
      ],
      runTimeline: [
        {
          id: "fixture-context",
          title: "Project context loaded",
          meta: "Fixture trace step",
        },
      ],
      checkout: {
        mode: "Foreground local checkout",
        root: "/Users/void/code/opensource/Pig",
        runtimeCwd: "/Users/void/code/opensource/Pig/docs",
      },
      summary: {
        model: "fixture-model",
        totalCostUsd: 0,
        totalTokens: 0,
      },
    };
    const projection = {
      ...createSessionProjection({
        id: "session-1",
        projectId: "pig-docs",
        initialPrompt: "测试一下",
        createdAt: "2026-06-26T08:00:00.000Z",
      }),
      status: "running" as const,
      creationStage: "accepted" as const,
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-session-rpc",
      runtimeEvents: [
        {
          id: "runtime-event-assistant-1",
          piSessionId: "pi-session-rpc",
          messageId: "pi-sdk:pi-session-rpc:assistant:0",
          kind: "message" as const,
          role: "assistant" as const,
          body: "真实回复",
          timestamp: "2026-06-26T08:00:01.000Z",
        },
      ],
      updatedAt: "2026-06-26T08:00:01.000Z",
    };

    render(
      <FixtureSessionsView
        projectId="pig-docs"
        workspace={workspace}
        sessionProjection={projection}
      />,
    );

    const liveChat = screen.getByLabelText("Live Chat messages");

    expect(await within(liveChat).findByText("真实回复")).toBeInTheDocument();
    expect(within(liveChat).queryByText("Project context loaded")).not.toBeInTheDocument();
    expect(liveChat.querySelector('[data-slot="chain-of-thought"]')).not.toBeInTheDocument();
  });

});

// The ADR-0030 phase machine as Live Chat renders it: one flat step list while
// the run is in flight, the answer below it, and exactly one fold into
// "Worked for Ns" at run(end). Events are driven through the real reducer so
// these assert the wiring, not a hand-built view.
describe("Chain of Thought phases in Live Chat", () => {
  const cotWorkspace = {
    id: "pig-docs",
    name: "Pig Docs",
    projectRoot: "/Users/void/code/opensource/Pig/docs",
    repoRoot: "/Users/void/code/opensource/Pig",
    selectedSessionId: "session-cot",
    liveMessages: [],
    runTimeline: [],
    checkout: {
      mode: "Foreground local checkout",
      root: "/Users/void/code/opensource/Pig",
      runtimeCwd: "/Users/void/code/opensource/Pig/docs",
    },
    summary: {
      model: "fixture-model",
      totalCostUsd: 0,
      totalTokens: 0,
    },
  };

  const cotRunId = "pi-session-cot:run-1";
  const cotT0 = Date.parse("2026-09-04T10:00:00.000Z");
  const cotAt = (ms: number) => new Date(cotT0 + ms).toISOString();

  type CotBeat = { ms: number; event: AgentRuntimeEventEntry["event"] };

  function cotMessage(turn: number) {
    const turnId = `${cotRunId}:turn-${turn}`;
    const messageId = `${turnId}:msg-1`;
    const base = { runId: cotRunId, turnId, messageId, role: "assistant" } as const;

    return {
      id: messageId,
      start: (ms: number): CotBeat => ({
        ms,
        event: { type: "message", ...base, phase: "start", surface: "chat", origin: "sdk" },
      }),
      end: (ms: number, parts: AgentMessagePartSnapshot[]): CotBeat => ({
        ms,
        event: { type: "message", ...base, phase: "end", parts, surface: "chat", origin: "sdk" },
      }),
      part: (slot: number, partType: AgentMessagePartType) => {
        const partId = `${messageId}:part-${slot}`;
        const surface = partType === "text" ? ("chat" as const) : ("trace" as const);
        const partBase = { type: "message_part", ...base, partId, partType, surface } as const;

        return {
          start: (ms: number, toolName?: string): CotBeat => ({
            ms,
            event: {
              ...partBase,
              phase: "start",
              bodyMode: "snapshot",
              body: "",
              ...(toolName ? { toolName } : {}),
              origin: "sdk",
            },
          }),
          delta: (ms: number, body: string): CotBeat => ({
            ms,
            event: { ...partBase, phase: "update", bodyMode: "delta", body, origin: "sdk" },
          }),
          end: (ms: number, body: string, toolCallId?: string): CotBeat => ({
            ms,
            event: {
              ...partBase,
              phase: "end",
              bodyMode: "snapshot",
              body,
              ...(toolCallId ? { toolCallId } : {}),
              origin: "sdk",
            },
          }),
          snapshot: (body: string, toolCallId?: string): AgentMessagePartSnapshot => ({
            partId,
            partType,
            body,
            ...(toolCallId ? { toolCallId } : {}),
          }),
        };
      },
    };
  }

  const cotRunStart = (ms: number): CotBeat => ({
    ms,
    event: {
      type: "run",
      runId: cotRunId,
      phase: "start",
      trigger: "prompt",
      surface: "hidden",
      origin: "sdk",
    },
  });

  const cotRunEnd = (ms: number): CotBeat => ({
    ms,
    event: {
      type: "run",
      runId: cotRunId,
      phase: "end",
      trigger: "prompt",
      outcome: "completed",
      surface: "hidden",
      origin: "sdk",
    },
  });

  const cotToolStart = (ms: number, toolCallId: string, name: string): CotBeat => ({
    ms,
    event: {
      type: "tool",
      runId: cotRunId,
      turnId: `${cotRunId}:turn-1`,
      toolCallId,
      phase: "start",
      name,
      surface: "trace",
      origin: "sdk",
    },
  });

  const cotToolEnd = (ms: number, toolCallId: string, name: string, result: string, isError = false): CotBeat => ({
    ms,
    event: {
      type: "tool",
      runId: cotRunId,
      turnId: `${cotRunId}:turn-1`,
      toolCallId,
      phase: "end",
      name,
      result,
      isError,
      surface: "trace",
      origin: "sdk",
    },
  });

  function cotProjection(beats: CotBeat[]): SessionProjection {
    let projection: SessionProjection = {
      ...createSessionProjection({
        id: "session-cot",
        projectId: "pig-docs",
        initialPrompt: "Ship the slice",
        createdAt: "2026-09-04T10:00:00.000Z",
      }),
      creationStage: "accepted",
      runtimeId: "pi-sdk:session-cot",
      piSessionId: "pi-session-cot",
    };

    beats.forEach((beat, index) => {
      projection = applySessionProjectionEvent(projection, {
        type: "agent-event-received",
        entry: { seq: index + 1, timestamp: cotAt(beat.ms), event: beat.event },
      });
    });

    return projection;
  }

  function cotView(nowMs: number) {
    return (
      <FixtureSessionsView
        clockNowMs={cotT0 + nowMs}
        projectId="pig-docs"
        sessionId="session-cot"
        workspace={cotWorkspace}
      />
    );
  }

  function renderCot(beats: CotBeat[], nowMs: number) {
    const store = storeWith(createInMemoryPiRuntimeBridge(), cotProjection(beats));

    return { ...render(cotView(nowMs), { store }), store };
  }

  // Later beats reach the store the way the runtime subscription delivers them.
  function receiveCotBeats(
    store: SessionProjectionsStore,
    beats: CotBeat[],
    alreadyApplied: number,
  ) {
    act(() => {
      beats.slice(alreadyApplied).forEach((beat, index) => {
        store.apply("session-cot", {
          type: "agent-event-received",
          entry: { seq: alreadyApplied + index + 1, timestamp: cotAt(beat.ms), event: beat.event },
        });
      });
    });
  }

  function cotBlock() {
    const liveChat = screen.getByLabelText("Live Chat messages");
    const block = liveChat.querySelector<HTMLElement>('[data-slot="chain-of-thought"]');

    if (!block) {
      throw new Error("no Chain of Thought rendered");
    }

    return block;
  }

  it("keeps a multi-turn run flat with a live last step, then folds it once at run(end)", async () => {
    const m1 = cotMessage(1);
    const m2 = cotMessage(2);
    const thought = m1.part(0, "thinking");
    const call = m1.part(1, "tool_call");
    const answer = m2.part(0, "text");
    const args = '{"path":"AGENTS.md"}';

    const acting = [
      cotRunStart(0),
      m1.start(100),
      thought.start(200),
      thought.end(900, "Read the instructions first."),
      call.start(1000, "read_file"),
      call.end(1200, args, "call-1"),
      m1.end(1300, [thought.snapshot("Read the instructions first."), call.snapshot(args, "call-1")]),
      cotToolStart(1400, "call-1", "read_file"),
    ];

    const { rerender, store } = renderCot(acting, 2000);

    // Flat while in flight: every completed step stays readable, so a later
    // Turn can look back at what the last one found.
    expect(cotBlock()).toHaveAttribute("data-phase", "acting");
    expect(
      screen.queryByRole("button", { name: /^Worked/ }),
    ).not.toBeInTheDocument();
    expect(cotBlock().querySelectorAll('[data-slot="chain-of-thought-step"]')).toHaveLength(2);
    expect(cotBlock()).toHaveTextContent("Running read_file…");
    // The heartbeat is the last line of the block and the only one.
    expect(cotBlock().lastElementChild).toHaveAttribute("data-slot", "chat-status-line");
    expect(cotBlock().querySelectorAll('[data-slot="chat-status-line"]')).toHaveLength(1);

    const answering = [
      ...acting,
      cotToolEnd(2000, "call-1", "read_file", "Agent instructions loaded."),
      m2.start(2100),
      answer.start(5100),
      answer.delta(5200, "Shipped."),
    ];

    receiveCotBeats(store, answering, acting.length);
    rerender(cotView(5300));

    expect(cotBlock()).toHaveAttribute("data-phase", "answering");
    expect(cotBlock().querySelector('[data-slot="chat-status-line"]')).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Worked/ })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("stream-markdown-renderer")).toHaveTextContent("Shipped."),
    );

    const settled = [
      ...answering,
      answer.end(5400, "Shipped."),
      m2.end(5500, [answer.snapshot("Shipped.")]),
      cotRunEnd(5600),
    ];

    receiveCotBeats(store, settled, answering.length);
    rerender(cotView(5700));

    // 5s: the wait from the Run's first model call to the first answer token,
    // tool execution included (ADR-0030 §6).
    const header = screen.getByRole("button", { name: /^Worked for 5s/ });

    expect(cotBlock()).toHaveAttribute("data-phase", "settled");
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(cotBlock().querySelector('[data-slot="chat-status-line"]')).not.toBeInTheDocument();
  });

  it("shows a Thought row for a single-turn run even when the provider sends no thinking body", () => {
    const m1 = cotMessage(1);
    const thought = m1.part(0, "thinking");
    const answer = m1.part(1, "text");

    renderCot(
      [
        cotRunStart(0),
        m1.start(100),
        thought.start(200),
        thought.end(2300, ""),
        answer.start(2400),
        answer.end(2600, "Shipped."),
        m1.end(2700, [thought.snapshot(""), answer.snapshot("Shipped.")]),
        cotRunEnd(2800),
      ],
      2900,
    );

    const steps = cotBlock().querySelectorAll<HTMLElement>(
      '[data-slot="chain-of-thought-step"]',
    );

    expect(screen.getByRole("button", { name: /^Worked for 2s/ })).toBeInTheDocument();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toHaveTextContent("Thought 2s");
    // Nothing to disclose behind an empty body, so the row is not a control.
    expect(steps[0].querySelector("button")).not.toBeInTheDocument();
    expect(screen.getByTestId("markdown-renderer")).toHaveTextContent("Shipped.");
  });

  it("withdraws the answer bubble and lists the text as Interim Output when a tool call follows it", async () => {
    const m1 = cotMessage(1);
    const interim = m1.part(0, "text");
    const call = m1.part(1, "tool_call");

    const answering = [
      cotRunStart(0),
      m1.start(100),
      interim.start(200),
      interim.delta(300, "Let me look at the repo."),
    ];

    const { rerender, store } = renderCot(answering, 400);

    await waitFor(() =>
      expect(screen.getByTestId("stream-markdown-renderer")).toHaveTextContent(
        "Let me look at the repo.",
      ),
    );
    expect(cotBlock()).toHaveAttribute("data-phase", "answering");

    receiveCotBeats(
      store,
      [...answering, interim.end(500, "Let me look at the repo."), call.start(600, "read_file")],
      answering.length,
    );
    rerender(cotView(700));

    const interimRow = cotBlock().querySelector('[data-slot="chat-interim-output"]');

    expect(cotBlock()).toHaveAttribute("data-phase", "acting");
    expect(interimRow).toHaveTextContent("Let me look at the repo.");
    expect(screen.queryByTestId("stream-markdown-renderer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("markdown-renderer")).not.toBeInTheDocument();
    // The header only ever appears at run(end): showing it here and taking it
    // away again is the flicker this regression path exists to avoid.
    expect(screen.queryByRole("button", { name: /^Worked/ })).not.toBeInTheDocument();
  });

  it("settles a replayed run that never reached run(end) because streaming is not allowed", () => {
    const m1 = cotMessage(1);
    const thought = m1.part(0, "thinking");
    const answer = m1.part(1, "text");
    const beats = [
      cotRunStart(0),
      m1.start(100),
      thought.start(200),
      thought.end(1100, "Reading."),
      answer.start(1200),
      answer.delta(1300, "Shipped."),
    ];

    render(
      <FixtureSessionsView
        clockNowMs={cotT0 + 999_999}
        projectId="pig-docs"
        sessionProjection={{ ...cotProjection(beats), stale: true }}
        workspace={cotWorkspace}
      />,
    );

    // A run cut off mid-stream: no wall clock may leak into a replay, and no
    // heartbeat may claim work is still happening.
    expect(cotBlock()).toHaveAttribute("data-phase", "settled");
    expect(cotBlock().querySelector('[data-slot="chat-status-line"]')).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Worked for 1s/ })).toBeInTheDocument();
  });

  it("puts the Chain of Thought where the message body's stretch rule can find it", () => {
    const m1 = cotMessage(1);
    const thought = m1.part(0, "thinking");
    const answer = m1.part(1, "text");

    renderCot(
      [
        cotRunStart(0),
        m1.start(100),
        thought.start(200),
        thought.end(1100, "Reading."),
        answer.start(1200),
        answer.end(1400, "Shipped."),
        m1.end(1500, [thought.snapshot("Reading."), answer.snapshot("Shipped.")]),
        cotRunEnd(1600),
      ],
      1700,
    );

    // Astryx lays the assistant body out as a fit-content column, and the
    // block contains its own inline size, so nothing inside pushes the body
    // wide: chat.css stretches it through `:has(> .chain-of-thought)`, which
    // only holds while the block is a direct child.
    expect(cotBlock().parentElement).toHaveAttribute("data-slot", "chat-message-body");
  });
});
