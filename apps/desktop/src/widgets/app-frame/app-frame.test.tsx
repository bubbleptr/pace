import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState, type ReactNode } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppFrame } from "@/widgets/app-frame";
import { defaultSidebarProjectSessionProjections } from "@/dev/fixtures/agent-workspace";
import type { SessionProjection } from "@/entities/session/session-projection";
import { addProjectToRegistry, getProjectRegistry } from "@/entities/project/project-registry";
import { saveFollowUpDraft } from "@/entities/session/follow-up-drafts";
import { getSessionDraft, saveSessionDraft } from "@/entities/session/session-drafts";
import { resetUpdateStatusStore } from "@/entities/update/use-update-status";
import type { PaceRendererApi } from "@/shared/runtime";
import type { UpdateStatus } from "@/shared/update-protocol";

const pigProjectPath = "/Users/void/code/opensource/Pig";

function seedPigProject() {
  addProjectToRegistry(pigProjectPath, {
    now: () => "2026-06-30T08:00:00.000Z",
  });
}

function mockUpdateBridge(initial: UpdateStatus) {
  const listeners = new Set<(status: UpdateStatus) => void>();
  const invoke = vi.fn(async (command: string) => {
    if (command === "update:status") {
      return initial;
    }

    return null;
  });

  window.pace = {
    invoke: invoke as unknown as PaceRendererApi["invoke"],
    onBackendEvent: () => () => {},
    onBrowserEvent: () => () => {},
    onUpdateEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onWindowFocusChanged: () => () => {},
    onNavigateRequest: () => () => {},
  };

  return {
    emit(status: UpdateStatus) {
      for (const listener of listeners) {
        listener(status);
      }
    },
  };
}

function renderAppFrame(
  path = "/",
  {
    seedProjects = true,
    toolbarActions,
    sessionProjections,
  }: {
    seedProjects?: boolean;
    toolbarActions?: ReactNode;
    sessionProjections?: SessionProjection[];
  } = {},
) {
  if (seedProjects) {
    seedPigProject();
  }

  const rootRoute = createRootRoute({
    component: () => (
      <AppFrame
        sidebar={<div>Route sidebar</div>}
        sessionProjections={sessionProjections ?? defaultSidebarProjectSessionProjections}
        toolbarActions={toolbarActions}
      >
        <div>Main content</div>
      </AppFrame>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions/$sessionId",
    component: () => null,
  });
  const usageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/usage",
    component: () => null,
  });
  const trajectoryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/trajectory",
    component: () => null,
  });
  const projectSessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId/sessions",
    component: () => null,
  });
  const packagesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/packages",
    component: () => null,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => null,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: rootRoute.addChildren([
      indexRoute,
      sessionRoute,
      usageRoute,
      trajectoryRoute,
      projectSessionsRoute,
      packagesRoute,
      settingsRoute,
    ]),
  });

  return { ...render(<RouterProvider router={router} />), router };
}

function isSideNavRow(candidate: HTMLElement) {
  return candidate.classList.contains("astryx-side-nav-item");
}

/**
 * Project header rows are the collapsible Astryx SideNavItem buttons
 * (aria-expanded, not the MoreMenu trigger which carries aria-haspopup).
 */
function findProjectHeaderButton(projectGroup: HTMLElement, name: string) {
  return within(projectGroup)
    .getAllByRole("button")
    .find(
      (candidate) =>
        isSideNavRow(candidate) &&
        candidate.hasAttribute("aria-expanded") &&
        !candidate.hasAttribute("aria-haspopup") &&
        (candidate.textContent ?? "").startsWith(name),
    );
}

function getProjectHeaderButton(projectGroup: HTMLElement, name: string) {
  const button = findProjectHeaderButton(projectGroup, name);

  if (!button) {
    throw new Error(`Project header row not found: ${name}`);
  }

  return button;
}

/** The label span sits after the expansion-indicator icon slot. */
function projectHeaderLabel(header: HTMLElement) {
  return (header.children[1] as HTMLElement | undefined)?.textContent ?? "";
}

/** Sessions live in the aria-controls group owned by the project header row. */
function getProjectSessionsGroup(projectGroup: HTMLElement, name: string) {
  const header = getProjectHeaderButton(projectGroup, name);
  const groupId = header.getAttribute("aria-controls");
  const group = groupId ? document.getElementById(groupId) : null;

  if (!group) {
    throw new Error(`Project sessions group not found: ${name}`);
  }

  return group as HTMLElement;
}

function findSessionRow(scope: HTMLElement, title: string) {
  return within(scope)
    .getAllByRole("button")
    .find(
      (candidate) =>
        isSideNavRow(candidate) &&
        !candidate.hasAttribute("aria-expanded") &&
        (candidate.textContent ?? "").includes(title),
    );
}

function getSessionRow(scope: HTMLElement, title: string) {
  const row = findSessionRow(scope, title);

  if (!row) {
    throw new Error(`Session row not found: ${title}`);
  }

  return row;
}

/** Session row layout: [glyph slot, label span, end content]. */
function sessionRowLabel(row: HTMLElement) {
  return (row.children[1] as HTMLElement | undefined)?.textContent ?? "";
}

describe("AppFrame", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete window.pace;
    resetUpdateStatusStore();
  });

  it("renders Empty Workspace State when the Project Registry is empty", async () => {
    renderAppFrame("/projects/chat/sessions", { seedProjects: false });

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const chatsGroup = screen.getByTestId("sidebar-chats");
    const projectGroup = screen.getByTestId("sidebar-projects");

    expect(within(chatsGroup).getByRole("button", { name: "Collapse Chats" })).toHaveTextContent("Chats");
    expect(within(chatsGroup).getByRole("button", { name: "New Chat without a project" })).toBeInTheDocument();
    expect(within(chatsGroup).queryByRole("button", { name: /Project actions/ })).not.toBeInTheDocument();
    expect(within(projectGroup).getByRole("button", { name: "Add Project" })).toBeInTheDocument();
    expect(within(projectGroup).queryByPlaceholderText("Absolute local path")).not.toBeInTheDocument();
    expect(
      within(projectGroup).queryByRole("button", { name: "New Chat for Pig" }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "Trajectory and usage navigation" })).getByRole(
        "button",
        { name: "New Chat" },
      ),
    ).toBeInTheDocument();
    expect(within(projectGroup).queryByText("Pig")).not.toBeInTheDocument();
  });

  it("pins Chats above Projects and keeps chat sessions out of Project groups", async () => {
    const chatProjection = {
      ...defaultSidebarProjectSessionProjections[0],
      id: "session-chat-casual",
      projectId: "chat",
      title: "Casual question",
      initialPrompt: "Casual question",
    };

    renderAppFrame("/projects/pig/sessions", {
      seedProjects: true,
      sessionProjections: [...defaultSidebarProjectSessionProjections, chatProjection],
    });

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const chatsGroup = screen.getByTestId("sidebar-chats");
    const projectGroup = screen.getByTestId("sidebar-projects");
    const sidebar = screen.getByTestId("app-layout-sidebar");
    const chatsIndex = sidebar.innerHTML.indexOf("sidebar-chats");
    const projectsIndex = sidebar.innerHTML.indexOf("sidebar-projects");

    expect(chatsIndex).toBeGreaterThan(-1);
    expect(projectsIndex).toBeGreaterThan(chatsIndex);
    expect(within(chatsGroup).getByText("Casual question")).toBeInTheDocument();
    expect(within(projectGroup).queryByText("Casual question")).not.toBeInTheDocument();
    expect(within(chatsGroup).queryByRole("button", { name: /Project actions/ })).toBeNull();
  });

  it("places the icon-only Add Project beside the section toggle without a duplicate list row", async () => {
    const user = userEvent.setup();
    renderAppFrame("/projects/pig/sessions", { seedProjects: false });

    const addProject = await screen.findByRole("button", { name: "Add Project" });
    const toggle = screen.getByRole("button", { name: "Collapse Projects" });
    expect(toggle.parentElement).toContainElement(addProject);
    expect(addProject.textContent).toBe("");
    expect(screen.getAllByRole("button", { name: "Add Project" })).toHaveLength(1);
    await user.click(toggle);
    expect(addProject).toBeVisible();
    expect(addProject).toBeEnabled();
  });

  it("opens New Chat without a project even when projects exist and preserves the draft", async () => {
    const user = userEvent.setup();
    saveSessionDraft(pigProjectPath, "Keep the idea while choosing where to work");
    const { router } = renderAppFrame("/projects/pig/sessions");
    const navigation = await screen.findByRole("group", { name: "Trajectory and usage navigation" });

    await user.click(within(navigation).getByRole("button", { name: /^New (Chat|Session)$/ }));

    expect(getSessionDraft()).toMatchObject({
      projectId: "chat",
      prompt: "Keep the idea while choosing where to work",
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/chat/sessions"));
    expect(screen.getByRole("heading", { level: 1, name: "New Chat" })).toBeInTheDocument();
  });

  it("lists Chats directly under their section with no synthetic Chat parent", async () => {
    const chat = {
      ...defaultSidebarProjectSessionProjections[0],
      id: "session-flat-chat",
      projectId: "chat",
      title: "An everyday question",
      initialPrompt: "An everyday question",
    };
    renderAppFrame("/projects/chat/sessions", { sessionProjections: [chat] });

    const section = await screen.findByTestId("sidebar-chats");
    expect(within(section).getByText("An everyday question")).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Chat" })).not.toBeInTheDocument();
    expect(section.querySelector('.astryx-side-nav-item[aria-expanded]:not([aria-haspopup])')).toBeNull();
    expect(within(section).getByRole("button", { name: "New Chat without a project" })).toBeInTheDocument();
    expect(section.querySelectorAll("button button")).toHaveLength(0);
  });

  it("collapses Chats and Projects independently while keeping creation actions available", async () => {
    const user = userEvent.setup();
    const chat = {
      ...defaultSidebarProjectSessionProjections[0],
      id: "collapsible-chat", projectId: "chat", title: "An everyday question",
    };
    const { router } = renderAppFrame("/projects/chat/sessions", {
      sessionProjections: [...defaultSidebarProjectSessionProjections, chat],
    });
    const chats = await screen.findByTestId("sidebar-chats");
    const projects = screen.getByTestId("sidebar-projects");
    const collapseChats = within(chats).getByRole("button", { name: "Collapse Chats" });
    expect(collapseChats).toHaveAttribute("aria-expanded", "true");
    // The section title itself is the toggle (Codex-style): no separate chevron button.
    expect(collapseChats).toHaveTextContent("Chats");
    expect(within(chats).getAllByRole("button", { name: /Chats$/ })).toHaveLength(1);
    const chatList = document.getElementById(collapseChats.getAttribute("aria-controls")!)!;
    await user.click(collapseChats);
    expect(chatList).toBeEmptyDOMElement();
    expect(within(chats).getByRole("button", { name: "New Chat without a project" })).toBeEnabled();
    expect(getProjectHeaderButton(projects, "Pig")).toBeVisible();
    await user.click(within(projects).getByRole("button", { name: "Collapse Projects" }));
    expect(within(projects).queryByRole("button", { name: "Pig" })).not.toBeInTheDocument();
    expect(within(projects).getByRole("button", { name: "Add Project" })).toBeEnabled();
    expect(router.state.location.pathname).toBe("/projects/chat/sessions");

    within(chats).getByRole("button", { name: "Expand Chats" }).focus();
    await user.keyboard("{Enter}");
    expect(within(chats).getByText("An everyday question")).toBeVisible();
    expect(within(projects).getByRole("button", { name: "Expand Projects" })).toHaveAttribute("aria-expanded", "false");
    await user.click(within(projects).getByRole("button", { name: "Expand Projects" }));
    expect(getProjectHeaderButton(projects, "Pig")).toBeVisible();
  });

  it("restores collapsed sidebar sections after remount and can create a chat while collapsed", async () => {
    const user = userEvent.setup();
    const first = renderAppFrame("/projects/pig/sessions");
    await user.click(await screen.findByRole("button", { name: "Collapse Chats" }));
    await user.click(screen.getByRole("button", { name: "Collapse Projects" }));
    first.unmount();
    const { router } = renderAppFrame("/projects/pig/sessions");
    expect(await screen.findByRole("button", { name: "Expand Chats" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Expand Projects" })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "New Chat without a project" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/chat/sessions"));
    expect(getSessionDraft()?.projectId).toBe("chat");
    expect(screen.getByRole("button", { name: "Expand Chats" })).toHaveAttribute("aria-expanded", "false");
  });

  it("uses the native directory picker when adding a Project", async () => {
    const user = userEvent.setup();
    const invoke = vi.fn(async (command: string) => {
      if (command === "select_project_directory") {
        return "/Users/void/Documents/study";
      }

      return null;
    });

    window.pace = {
      invoke: invoke as unknown as PaceRendererApi["invoke"],
      onBackendEvent: () => () => {},
      onBrowserEvent: () => () => {},
      onUpdateEvent: () => () => {},
      onWindowFocusChanged: () => () => {},
      onNavigateRequest: () => () => {},
    };

    renderAppFrame("/projects/pig/sessions", { seedProjects: false });

    await user.click(await screen.findByRole("button", { name: "Add Project" }));

    expect(invoke).toHaveBeenCalledWith("select_project_directory", undefined);
    const projectGroup = screen.getByTestId("sidebar-projects");

    expect(getProjectHeaderButton(projectGroup, "study")).toBeInTheDocument();
    expect(getSessionDraft()).toMatchObject({
      projectId: "/Users/void/Documents/study",
      prompt: "",
    });
  });

  it("dims a Project whose directory is missing and names the path in a tooltip", async () => {
    const user = userEvent.setup();
    const studyPath = "/Users/void/Documents/study";
    addProjectToRegistry(studyPath, { now: () => "2026-06-29T08:00:00.000Z" });
    const invoke = vi.fn(async (command: string, args?: { roots?: string[] }) => {
      if (command === "check_project_directories") {
        return Object.fromEntries(
          (args?.roots ?? []).map((root) => [root, root !== pigProjectPath]),
        );
      }

      return null;
    });
    window.pace = {
      invoke: invoke as unknown as PaceRendererApi["invoke"],
      onBackendEvent: () => () => {},
      onBrowserEvent: () => () => {},
      onUpdateEvent: () => () => {},
      onWindowFocusChanged: () => () => {},
      onNavigateRequest: () => () => {},
    };

    renderAppFrame("/projects/pig/sessions");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const projectGroup = screen.getByTestId("sidebar-projects");
    const pigHeader = getProjectHeaderButton(projectGroup, "Pig");
    const studyHeader = getProjectHeaderButton(projectGroup, "study");

    await waitFor(() =>
      expect(pigHeader).toHaveAccessibleDescription(expect.stringContaining(pigProjectPath)),
    );
    expect(invoke).toHaveBeenCalledWith("check_project_directories", {
      roots: expect.arrayContaining([pigProjectPath, studyPath]),
    });
    const rows = within(projectGroup).getAllByTestId("project-row-with-actions");
    const pigRow = rows.find((row) => row.contains(pigHeader));
    const studyRow = rows.find((row) => row.contains(studyHeader));
    expect(pigRow).toHaveAttribute("data-directory-missing", "true");
    expect(studyRow).not.toHaveAttribute("data-directory-missing");
    expect(studyHeader).not.toHaveAttribute("aria-describedby");

    // History stays reachable: the dimmed row still toggles its sessions.
    expect(pigHeader).toHaveAttribute("aria-expanded", "true");
    await user.click(pigHeader);
    expect(pigHeader).toHaveAttribute("aria-expanded", "false");
  });

  it("places Project sessions in the primary sidebar", async () => {
    renderAppFrame("/projects/pig/sessions");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const projectGroup = screen.getByTestId("sidebar-projects");
    const projectNavigation = getProjectSessionsGroup(projectGroup, "Pig");

    expect(getProjectHeaderButton(projectGroup, "Pig")).toBeInTheDocument();
    expect(within(projectNavigation).getByText("Agent Workspace shell")).not.toHaveAttribute(
      "data-pigui-session-title",
    );
    expect(within(projectNavigation).getByText("Trace boundary pass")).toBeInTheDocument();
    const activeRunIndicator = within(projectNavigation).getByLabelText("Active run");

    expect(activeRunIndicator).toHaveAttribute("data-slot", "dot-matrix");
    expect(activeRunIndicator).toHaveAttribute("data-state", "loading");
    expect(activeRunIndicator).not.toHaveClass("animate-spin");
    expect(activeRunIndicator.querySelector("svg")).toHaveAttribute("viewBox", "0 0 16 16");
    expect(activeRunIndicator.querySelectorAll('[data-slot="dot-matrix-dot"]')).toHaveLength(16);
    // Fixture timestamps are not "today", so chips use compact day-count ago
    // (not a short date, and not a UTC HH:mm slice).
    const activeSessionRow = getSessionRow(projectNavigation, "Agent Workspace shell");
    const activeTime = within(activeSessionRow).getByText(/^\d+d ago$/);

    expect(activeTime).toHaveClass("text-muted", "text-[10px]", "leading-none");
    // The time chip lives on the session row itself, not inside an action button.
    expect(activeTime.closest("button")).toBe(activeSessionRow);
    // Must not use naive UTC HH:mm from ISO.
    expect(within(activeSessionRow).queryByText("08:06")).toBeNull();
    const trajectoryUsageNavigation = screen.getByRole("group", {
      name: "Trajectory and usage navigation",
    });
    const topRows = within(trajectoryUsageNavigation).getAllByRole("button");
    const globalNewSessionRow = within(trajectoryUsageNavigation).getByRole("button", {
      name: "New Chat",
    });
    const projectActionsButton = within(projectGroup).getByRole("button", {
      name: "Project actions for Pig",
    });
    const projectNewSessionButton = within(projectGroup).getByRole("button", {
      name: "New Chat for Pig",
    });

    expect(topRows.map((row) => row.textContent)).toEqual([
      "New Chat",
      "Trajectory",
      "Usage",
      "Packages",
    ]);
    expect(globalNewSessionRow).not.toHaveAttribute("aria-current", "page");
    expect(
      within(projectNavigation).queryByRole("button", { name: "New Chat" }),
    ).not.toBeInTheDocument();
    expect(projectNewSessionButton).toHaveClass("astryx-button");
    expect(projectNewSessionButton).toHaveAttribute("data-size", "sm");
    expect(projectNewSessionButton).toHaveAttribute("data-variant", "ghost");
    expect(projectActionsButton).toHaveClass("astryx-button");
    expect(projectActionsButton).toHaveAttribute("data-size", "sm");
    expect(projectActionsButton).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.getByRole("heading", { level: 1, name: "Agent Workspace shell" })).toBeInTheDocument();
  });

  it.each(["pig", "chat"])("keeps the %s header in sync with session naming and selection", async (projectId) => {
    const [first, second] = defaultSidebarProjectSessionProjections;
    let update!: (state: { sessions: SessionProjection[]; selected: string | null }) => void;
    const rootRoute = createRootRoute({
      component: function TestFrame() {
        const [state, setState] = useState<{ sessions: SessionProjection[]; selected: string | null }>({
          sessions: [{ ...first, title: null, sessionName: undefined, initialPrompt: "Fix the session header" }, second],
          selected: first.id,
        });
        update = setState;
        return <AppFrame sessionProjections={state.sessions} selectedSessionId={state.selected}>Content</AppFrame>;
      },
    });
    const route = createRoute({ getParentRoute: () => rootRoute, path: "/projects/$projectId/sessions" });
    const router = createRouter({
      routeTree: rootRoute.addChildren([route]),
      history: createMemoryHistory({ initialEntries: [`/projects/${projectId}/sessions`] }),
    });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Fix the session header" })).toBeInTheDocument();

    const named = { ...first, title: null, sessionName: "Generated session name" };
    act(() => update({ sessions: [named, second], selected: first.id }));
    expect(screen.getByRole("heading", { level: 1, name: named.sessionName })).toBeInTheDocument();

    const renamed = { ...named, title: "Session title synchronization" };
    act(() => update({ sessions: [renamed, second], selected: first.id }));
    expect(screen.getByRole("heading", { level: 1, name: renamed.title })).toBeInTheDocument();
    act(() => update({ sessions: [renamed, second], selected: second.id }));
    expect(screen.getByRole("heading", { level: 1, name: second.title ?? second.sessionName ?? second.initialPrompt })).toBeInTheDocument();
    await act(() => router.navigate({ to: "/projects/$projectId/sessions", params: { projectId }, search: { view: "draft" } }));
    expect(screen.getByRole("heading", { level: 1, name: "New Chat" })).toBeInTheDocument();
  });

  it("renders Project headers as side nav rows with sibling row actions (no nested buttons)", async () => {
    renderAppFrame("/projects/pig/sessions");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const projectGroup = screen.getByTestId("sidebar-projects");
    const projectHeader = getProjectHeaderButton(projectGroup, "Pig");

    expect(projectHeader).toHaveClass("astryx-side-nav-item");
    expect(projectHeaderLabel(projectHeader)).toBe("Pig");

    // Interactive elements must never nest (invalid HTML, hydration warning,
    // unreachable for screen readers) — astryx-migration issue 01.
    expect(projectGroup.querySelectorAll("button button, a button, button a")).toHaveLength(0);
    expect(within(projectHeader).queryAllByRole("button")).toHaveLength(0);

    // The actions still render on the same visual row: siblings of the row
    // button inside the shared row wrapper.
    const rowWrapper = projectHeader.closest<HTMLElement>(
      "[data-testid='project-row-with-actions']",
    );
    expect(rowWrapper).not.toBeNull();
    const projectNewSessionButton = within(rowWrapper!).getByRole("button", {
      name: "New Chat for Pig",
    });
    const projectActionsButton = within(rowWrapper!).getByRole("button", {
      name: "Project actions for Pig",
    });

    expect(projectHeader.contains(projectNewSessionButton)).toBe(false);
    expect(projectHeader.contains(projectActionsButton)).toBe(false);
    expect(projectNewSessionButton).toHaveClass("astryx-button");
    expect(projectActionsButton).toHaveClass("astryx-button");
  });

  it("uses folder state icons for Project expansion and swaps to a chevron affordance on hover", async () => {
    const source = readFileSync(join(process.cwd(), "apps/desktop/src/widgets/app-frame/app-frame.tsx"), "utf8");
    const iconSource = readFileSync(
      join(process.cwd(), "apps/desktop/src/shared/ui/icons.tsx"),
      "utf8",
    );
    const styles = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");

    renderAppFrame("/projects/pig/sessions");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const projectGroup = screen.getByTestId("sidebar-projects");
    const projectHeader = getProjectHeaderButton(projectGroup, "Pig");

    expect(projectHeader.querySelector(".pigui-project-expansion-indicator")).toBeInTheDocument();
    expect(source).toContain("FolderClosed,");
    expect(source).toContain("FolderOpenState,");
    expect(source).toContain("ChevronRight,");
    expect(source).toContain("icon={<ProjectExpansionIndicator expanded={expanded} />}");
    expect(iconSource).toContain("Folder01Icon");
    expect(iconSource).toContain("Folder02Icon");
    expect(iconSource).toContain("export const FolderClosed = iconComponent(Folder01Icon);");
    expect(iconSource).toContain("export const FolderOpenState = iconComponent(Folder02Icon);");
    expect(styles).toContain(".pigui-project-expansion-indicator__state");
    expect(styles).toContain(".pigui-project-expansion-indicator__chevron");
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("[data-focus-visible=\"true\"]");
    expect(styles).toContain(".pigui-project-expansion-indicator__state");
    expect(styles).toContain("opacity: 0;");
    expect(styles).toContain(".pigui-project-expansion-indicator[data-expanded=\"true\"]");
    expect(styles).toContain("rotate: 90deg;");
  });

  it("orders Project sessions by user submission time while retaining active and unread indicators", async () => {
    renderAppFrame("/projects/pig/sessions");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const projectNavigation = getProjectSessionsGroup(
      screen.getByTestId("sidebar-projects"),
      "Pig",
    );
    const sessionRows = within(projectNavigation)
      .getAllByRole("button")
      .filter((row) => isSideNavRow(row));

    expect(sessionRows.map((row) => sessionRowLabel(row))).toEqual([
      "Agent Workspace shell",
      "Usage evidence review",
      "Trace boundary pass",
    ]);
    const activeRunIndicator = within(sessionRows[0]).getByLabelText("Active run");

    expect(activeRunIndicator).toHaveAttribute("data-slot", "dot-matrix");
    expect(activeRunIndicator).toHaveAttribute("data-state", "loading");
    expect(activeRunIndicator.querySelector("svg")).toHaveAttribute("viewBox", "0 0 16 16");
    expect(activeRunIndicator.querySelectorAll('[data-slot="dot-matrix-dot"]')).toHaveLength(16);
    expect(within(sessionRows[2]).getByLabelText("Unread result")).toBeInTheDocument();
    expect(
      sessionRows[1].querySelector('[data-testid="session-glyph"]'),
    ).toBeEmptyDOMElement();
    expect(within(projectNavigation).queryByText("Archived checkout snapshot")).not.toBeInTheDocument();
    expect(within(projectNavigation).queryByText(/Running|Completed|Failed|Waiting/)).not.toBeInTheDocument();
  });

  it("selects a Session without clearing unread before route content renders it", async () => {
    const user = userEvent.setup();

    renderAppFrame("/projects/pig/sessions");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const projectNavigation = getProjectSessionsGroup(
      screen.getByTestId("sidebar-projects"),
      "Pig",
    );
    const unreadRow = getSessionRow(projectNavigation, "Trace boundary pass");

    expect(within(unreadRow).getByLabelText("Unread result")).toBeInTheDocument();

    await user.click(unreadRow);

    const openedRow = getSessionRow(projectNavigation, "Trace boundary pass");

    expect(openedRow).toHaveAttribute("aria-current", "page");
    expect(within(openedRow).getByLabelText("Unread result")).toBeInTheDocument();
    expect(within(projectNavigation).queryByText(/Completed|Failed|Waiting/)).not.toBeInTheDocument();
  });

  it("auto-expands the Project that owns an externally opened Session", async () => {
    window.localStorage.setItem(
      "pigui.projectSidebar.expanded.v1",
      JSON.stringify({ [pigProjectPath]: false }),
    );

    renderAppFrame("/projects/pig/sessions");

    const projectGroup = await screen.findByTestId("sidebar-projects");
    const projectNavigation = getProjectSessionsGroup(projectGroup, "Pig");

    expect(getSessionRow(projectNavigation, "Agent Workspace shell")).toBeInTheDocument();
    expect(getProjectHeaderButton(projectGroup, "Pig")).toHaveAttribute("aria-expanded", "true");
  });

  it("lists registry Projects by addedAt and persists independent collapse state", async () => {
    const user = userEvent.setup();

    addProjectToRegistry(pigProjectPath, {
      now: () => "2026-06-30T08:00:00.000Z",
    });
    addProjectToRegistry("/Users/void/Documents/study", {
      now: () => "2026-06-30T09:00:00.000Z",
    });

    const firstRender = renderAppFrame("/projects/pig/sessions", { seedProjects: false });
    const projectGroup = await screen.findByTestId("sidebar-projects");
    const projectHeaders = within(projectGroup)
      .getAllByRole("button")
      .filter(
        (row) =>
          isSideNavRow(row) &&
          row.hasAttribute("aria-expanded") &&
          !row.hasAttribute("aria-haspopup"),
      );

    expect(projectHeaders.map((row) => projectHeaderLabel(row))).toEqual(["study", "Pig"]);
    expect(getProjectSessionsGroup(projectGroup, "study")).toBeInTheDocument();
    expect(getProjectSessionsGroup(projectGroup, "Pig")).toBeInTheDocument();

    await user.click(getProjectHeaderButton(projectGroup, "study"));

    expect(getProjectHeaderButton(projectGroup, "study")).toHaveAttribute("aria-expanded", "false");
    expect(getProjectSessionsGroup(projectGroup, "Pig")).not.toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByText("Main content")).toBeInTheDocument();

    firstRender.unmount();
    renderAppFrame("/projects/pig/sessions", { seedProjects: false });

    const restoredProjectGroup = await screen.findByTestId("sidebar-projects");

    expect(getProjectHeaderButton(restoredProjectGroup, "study")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(getProjectSessionsGroup(restoredProjectGroup, "Pig")).not.toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("opens the global New Chat draft without adding Project draft rows", async () => {
    const user = userEvent.setup();

    saveSessionDraft(pigProjectPath, "Existing Project draft");

    renderAppFrame("/projects/pig/sessions");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const projectGroup = screen.getByTestId("sidebar-projects");
    const projectNavigation = getProjectSessionsGroup(projectGroup, "Pig");
    const trajectoryUsageNavigation = screen.getByRole("group", {
      name: "Trajectory and usage navigation",
    });
    const globalNewSessionRow = within(trajectoryUsageNavigation).getByRole("button", {
      name: "New Chat",
    });

    expect(
      within(projectGroup).getByRole("button", { name: "New Chat for Pig" }),
    ).toHaveClass("astryx-button");
    expect(
      within(projectNavigation).queryByRole("button", { name: "New Chat" }),
    ).not.toBeInTheDocument();
    expect(within(projectGroup).queryByText("Draft")).not.toBeInTheDocument();
    expect(within(projectNavigation).queryByText("Session Draft")).not.toBeInTheDocument();

    await user.click(globalNewSessionRow);

    expect(getSessionDraft()).toMatchObject({
      projectId: "chat",
      prompt: "Existing Project draft",
    });
    expect(
      within(trajectoryUsageNavigation).getByRole("button", { name: "New Chat" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("shows unsent follow-up icons on Session rows and collapsed Projects", async () => {
    const user = userEvent.setup();

    saveFollowUpDraft("session-analyze-boundary", "Continue the trace review");

    renderAppFrame("/projects/pig/sessions");

    const projectGroup = await screen.findByTestId("sidebar-projects");
    const projectNavigation = getProjectSessionsGroup(projectGroup, "Pig");
    const sessionRow = getSessionRow(projectNavigation, "Trace boundary pass");
    const expandedProjectHeader = getProjectHeaderButton(projectGroup, "Pig");

    expect(within(sessionRow).getByLabelText("Unsent follow-up")).toBeInTheDocument();
    expect(
      within(expandedProjectHeader).queryByLabelText("Unsent follow-up"),
    ).not.toBeInTheDocument();
    expect(within(projectGroup).queryByText("Draft")).not.toBeInTheDocument();

    await user.click(expandedProjectHeader);

    const projectHeader = getProjectHeaderButton(projectGroup, "Pig");
    // The indicator sits in the sibling actions overlay on the same row, not
    // inside the row button (no interactive-element nesting).
    // Direct child only: nested session rows carry their own actions overlay.
    const projectActions = projectHeader
      .closest<HTMLElement>("[data-testid='project-row-with-actions']")
      ?.querySelector<HTMLElement>(":scope > .pigui-sidenav-row-actions");

    expect(within(projectActions!).getByLabelText("Unsent follow-up")).toBeInTheDocument();
    expect(within(projectGroup).queryByText("Draft")).not.toBeInTheDocument();
    expect(projectHeader).toHaveAttribute("aria-expanded", "false");
  });

  it("removes a Project from the sidebar after confirmation and clears only the draft target", async () => {
    const user = userEvent.setup();

    addProjectToRegistry(pigProjectPath, {
      now: () => "2026-06-30T08:00:00.000Z",
    });
    addProjectToRegistry("/Users/void/Documents/study", {
      now: () => "2026-06-30T09:00:00.000Z",
    });
    saveSessionDraft(pigProjectPath, "Keep this prompt");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderAppFrame("/projects/pig/sessions", { seedProjects: false });
    const projectGroup = await screen.findByTestId("sidebar-projects");

    await user.click(within(projectGroup).getByRole("button", { name: "Project actions for Pig" }));
    const projectActionsMenu = screen.getByRole("menu", { name: "Project actions for Pig" });
    const renameProjectItem = within(projectActionsMenu).getByRole("menuitem", {
      name: "Rename Project",
    });
    const revealProjectItem = within(projectActionsMenu).getByRole("menuitem", {
      name: "Reveal in Finder",
    });
    const removeProjectItem = within(projectActionsMenu).getByRole("menuitem", {
      name: "Remove Project...",
    });

    expect(projectActionsMenu).toHaveClass("astryx-dropdown-menu");
    expect(projectActionsMenu).toHaveClass("astryx-more-menu");
    expect(within(projectActionsMenu).queryByRole("menuitem", { name: "New Chat" })).toBeNull();
    expect(renameProjectItem).toHaveClass("astryx-dropdown-menu-item");
    expect(revealProjectItem).toHaveClass("astryx-dropdown-menu-item");
    expect(removeProjectItem).toHaveClass("astryx-dropdown-menu-item");
    // Destructive action stays separated from the safe actions by a divider.
    expect(removeProjectItem.previousElementSibling).toHaveAttribute("role", "separator");
    expect(
      within(projectActionsMenu).getAllByRole("menuitem").map((item) => item.textContent?.trim()),
    ).toEqual(["Rename Project", "Reveal in Finder", "Remove Project..."]);
    await user.click(removeProjectItem);

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Remove Pig from Pace?"),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Local files and historical Sessions will not be deleted."),
    );
    expect(within(projectGroup).queryByText("Pig")).not.toBeInTheDocument();
    expect(getProjectHeaderButton(projectGroup, "study")).toBeInTheDocument();
    expect(getSessionDraft()).toMatchObject({
      projectId: null,
      prompt: "Keep this prompt",
    });
  });

  it("opens a Project-scoped New Chat draft from the sidebar action button", async () => {
    const user = userEvent.setup();

    saveSessionDraft(null, "Prompt from the global draft");

    renderAppFrame("/projects/pig/sessions");
    const projectGroup = await screen.findByTestId("sidebar-projects");

    await user.click(within(projectGroup).getByRole("button", { name: "New Chat for Pig" }));

    expect(getSessionDraft()).toMatchObject({
      projectId: pigProjectPath,
      prompt: "Prompt from the global draft",
    });
    expect(
      within(screen.getByRole("group", { name: "Trajectory and usage navigation" })).getByRole(
        "button",
        { name: "New Chat" },
      ),
    ).toHaveAttribute("aria-current", "page");
  });

  it("renames a Project from the sidebar action menu", async () => {
    const user = userEvent.setup();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Pace Desktop");

    renderAppFrame("/projects/pig/sessions");
    const projectGroup = await screen.findByTestId("sidebar-projects");

    await user.click(within(projectGroup).getByRole("button", { name: "Project actions for Pig" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename Project" }));

    expect(prompt).toHaveBeenCalledWith("Rename Project", "Pig");
    expect(findProjectHeaderButton(projectGroup, "Pig")).toBeUndefined();
    expect(getProjectHeaderButton(projectGroup, "Pace Desktop")).toBeInTheDocument();
    expect(getProjectRegistry()[0]).toMatchObject({
      id: pigProjectPath,
      displayName: "Pace Desktop",
    });
  });

  it("reveals a Project in Finder from the sidebar action menu", async () => {
    const user = userEvent.setup();
    const invoke = vi.fn(async () => undefined);
    window.pace = {
      invoke: invoke as unknown as PaceRendererApi["invoke"],
      onBackendEvent: () => () => {},
      onBrowserEvent: () => () => {},
      onUpdateEvent: () => () => {},
      onWindowFocusChanged: () => () => {},
      onNavigateRequest: () => () => {},
    };

    renderAppFrame("/projects/pig/sessions");
    const projectGroup = await screen.findByTestId("sidebar-projects");

    await user.click(within(projectGroup).getByRole("button", { name: "Project actions for Pig" }));
    await user.click(screen.getByRole("menuitem", { name: "Reveal in Finder" }));

    expect(invoke).toHaveBeenCalledWith("reveal_project_in_finder", {
      path: pigProjectPath,
    });
  });

  it("renames a Session from the row action menu with a trimmed title", async () => {
    const user = userEvent.setup();
    const prompt = vi
      .spyOn(window, "prompt")
      .mockReturnValue("  Boundary follow-up  ");
    const alert = vi.spyOn(window, "alert").mockReturnValue(undefined);
    const invoke = vi.fn(async () => ({}));
    window.pace = {
      invoke: invoke as unknown as PaceRendererApi["invoke"],
      onBackendEvent: () => () => {},
      onBrowserEvent: () => () => {},
      onUpdateEvent: () => () => {},
      onWindowFocusChanged: () => () => {},
      onNavigateRequest: () => () => {},
    };

    renderAppFrame("/projects/pig/sessions");
    const projectGroup = await screen.findByTestId("sidebar-projects");

    await user.click(
      within(projectGroup).getByRole("button", {
        name: "Session actions for Trace boundary pass",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Rename Session" }));

    expect(prompt).toHaveBeenCalledWith("Rename Session", "Trace boundary pass");
    expect(invoke).toHaveBeenCalledWith("rename_session", {
      sessionId: "session-analyze-boundary",
      title: "Boundary follow-up",
    });
    expect(alert).not.toHaveBeenCalled();
  });

  it("opens a Session's Trajectory from the row action menu", async () => {
    const user = userEvent.setup();
    window.pace = {
      invoke: vi.fn(async () => null) as unknown as PaceRendererApi["invoke"],
      onBackendEvent: () => () => {},
      onBrowserEvent: () => () => {},
      onUpdateEvent: () => () => {},
      onWindowFocusChanged: () => () => {},
      onNavigateRequest: () => () => {},
    };

    const { router } = renderAppFrame("/projects/pig/sessions");
    const projectGroup = await screen.findByTestId("sidebar-projects");

    // Only Sessions that already have a Pi session file can be replayed.
    await user.click(
      within(projectGroup).getByRole("button", {
        name: "Session actions for Agent Workspace shell",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Open Trajectory" }));

    expect(router.state.location.pathname).toBe(
      "/sessions/session-control-plane-shell-pi-session",
    );
  });

  it("archives a Session from the row action menu", async () => {
    const user = userEvent.setup();
    const alert = vi.spyOn(window, "alert").mockReturnValue(undefined);
    const invoke = vi.fn(async () => ({
      sessionId: "session-analyze-boundary",
      runtimeId: null,
      piSessionId: null,
      projectId: pigProjectPath,
      cwd: pigProjectPath,
      status: "archived",
      archivedAt: "2026-06-26T09:00:00.000Z",
      updatedAt: "2026-06-26T09:00:00.000Z",
    }));
    window.pace = {
      invoke: invoke as unknown as PaceRendererApi["invoke"],
      onBackendEvent: () => () => {},
      onBrowserEvent: () => () => {},
      onUpdateEvent: () => () => {},
      onWindowFocusChanged: () => () => {},
      onNavigateRequest: () => () => {},
    };

    renderAppFrame("/projects/pig/sessions");
    const projectGroup = await screen.findByTestId("sidebar-projects");

    await user.click(
      within(projectGroup).getByRole("button", {
        name: "Session actions for Trace boundary pass",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Archive Session" }));

    expect(invoke).toHaveBeenCalledWith("archive_session", {
      sessionId: "session-analyze-boundary",
    });
    expect(alert).not.toHaveBeenCalled();
  });

  it("deletes a Session from the row action menu after confirmation", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const alert = vi.spyOn(window, "alert").mockReturnValue(undefined);
    const invoke = vi.fn(async () => ({}));
    window.pace = {
      invoke: invoke as unknown as PaceRendererApi["invoke"],
      onBackendEvent: () => () => {},
      onBrowserEvent: () => () => {},
      onUpdateEvent: () => () => {},
      onWindowFocusChanged: () => () => {},
      onNavigateRequest: () => () => {},
    };

    renderAppFrame("/projects/pig/sessions");
    const projectGroup = await screen.findByTestId("sidebar-projects");

    await user.click(
      within(projectGroup).getByRole("button", {
        name: "Session actions for Trace boundary pass",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete Session..." }));

    expect(confirm).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("delete_session", {
      sessionId: "session-analyze-boundary",
    });
    expect(alert).not.toHaveBeenCalled();
  });

  it("keeps only Rename on the action menu of an active Session", async () => {
    const user = userEvent.setup();

    renderAppFrame("/projects/pig/sessions");
    const projectGroup = await screen.findByTestId("sidebar-projects");

    await user.click(
      within(projectGroup).getByRole("button", {
        name: "Session actions for Agent Workspace shell",
      }),
    );

    expect(screen.getByRole("menuitem", { name: "Rename Session" })).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Archive Session" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Delete Session..." }),
    ).not.toBeInTheDocument();
  });

  it("renders Trajectory and Usage as first-level side nav items", async () => {
    renderAppFrame("/trajectory");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const trajectoryUsageNavigation = screen.getByRole("group", {
      name: "Trajectory and usage navigation",
    });
    const trajectoryItem = within(trajectoryUsageNavigation).getByRole("button", { name: "Trajectory" });
    const usageItem = within(trajectoryUsageNavigation).getByRole("button", { name: "Usage" });

    expect(within(trajectoryUsageNavigation).queryByText("Analyze")).not.toBeInTheDocument();
    expect(trajectoryItem).toHaveAttribute("aria-current", "page");
    expect(usageItem).not.toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1, name: "Trajectory" })).toBeInTheDocument();
  });

  it("renders Packages as a first-level side nav item with its own page title", async () => {
    renderAppFrame("/packages");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const navigation = screen.getByRole("group", { name: "Trajectory and usage navigation" });
    expect(within(navigation).getByRole("button", { name: "Packages" })).toHaveAttribute("aria-current", "page");
    expect(within(navigation).getByRole("button", { name: "Usage" })).not.toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1, name: "Packages" })).toBeInTheDocument();
  });

  it("orders Trajectory and Usage above Projects and pins Settings to the sidenav footer", async () => {
    const { container } = renderAppFrame("/projects/pig/sessions");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const sidebar = container.querySelector('[data-testid="app-layout-sidebar"]');
    const trajectoryUsageNavigation = screen.getByRole("group", {
      name: "Trajectory and usage navigation",
    });
    const projectGroup = screen.getByTestId("sidebar-projects");
    const systemGroup = screen.getByTestId("sidebar-system");

    expect(sidebar).toBeInTheDocument();
    expect(sidebar).toContainElement(trajectoryUsageNavigation);
    expect(sidebar).toContainElement(projectGroup);
    expect(sidebar).toContainElement(systemGroup);
    expect(within(projectGroup).getByRole("button", { name: "Collapse Projects" })).toHaveTextContent("Projects");
    expect(within(projectGroup).getByRole("button", { name: "Add Project" })).toBeInTheDocument();
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-workspace")).not.toBeInTheDocument();
    // Document order: trajectory/usage → projects → system footer.
    expect(
      trajectoryUsageNavigation.compareDocumentPosition(projectGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      projectGroup.compareDocumentPosition(systemGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(systemGroup).toHaveTextContent("Settings");
    expect(systemGroup).not.toHaveTextContent("Analyze");
    expect(trajectoryUsageNavigation).not.toHaveTextContent("Settings");
    expect(projectGroup).not.toHaveTextContent("Settings");
  });

  it("uses Astryx AppShell + SideNav and keeps the sidebar to primary tabs only", async () => {
    const { container } = renderAppFrame("/usage");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    expect(screen.queryByText("Route sidebar")).not.toBeInTheDocument();
    const layout = container.querySelector(".astryx-app-shell");
    const sidebar = container.querySelector('[data-testid="app-layout-sidebar"]');

    expect(layout).toBeInTheDocument();
    expect(layout).toHaveClass("pigui-app-layout");
    expect(sidebar).toBeInTheDocument();
    expect(sidebar).toHaveClass("astryx-side-nav");
    expect(sidebar).toHaveAttribute("data-state", "expanded");
    expect(sidebar).toHaveStyle({ width: "260px" });
    const sidebarChrome = screen.getByTestId("sidebar-titlebar-spacer");
    expect(sidebarChrome).toBeInTheDocument();
    // 24px + the SideNav header slot's own 8px block padding on each side
    // adds up to the 40px titlebar, so nav content starts right below the chrome.
    expect(sidebarChrome).toHaveStyle({ height: "24px" });
    expect(within(sidebarChrome).queryByRole("button")).not.toBeInTheDocument();

    const headerChrome = screen.getByTestId("header-chrome");
    expect(headerChrome).toBeInTheDocument();
    expect(headerChrome).toHaveClass("pigui-header-chrome");
    expect(headerChrome).toHaveStyle({
      "--pigui-header-height": "40px",
      "--pigui-main-left": "260px",
      "--pigui-traffic-width": "88px",
    });
    const macTrafficSpace = within(headerChrome).getByTestId("mac-traffic-space");

    expect(macTrafficSpace).toBeInTheDocument();
    expect(macTrafficSpace).toHaveAttribute("data-window-drag-region");
    expect(headerChrome.querySelector("[data-window-drag-region]")).toBeInTheDocument();
    const sidebarCollapseTrigger = within(headerChrome).getByRole("button", {
      name: "Collapse sidebar",
    });
    expect(sidebarCollapseTrigger).toHaveAttribute("data-slot", "sidebar-trigger");
    expect(container.querySelector('[data-testid="collapsed-traffic-space"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="navbar"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="app-layout-menu-toggle"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="sidebar-rail"]')).not.toBeInTheDocument();
    const resizeHandle = screen.getByTestId("astryx-sidenav-resize-handle");
    expect(resizeHandle).toBeInTheDocument();
    expect(resizeHandle).toHaveAttribute("aria-label", "Resize sidebar");
    expect(resizeHandle).toHaveAttribute("role", "separator");
    expect(resizeHandle).toHaveAttribute("aria-valuemin", "240");
    expect(resizeHandle).toHaveAttribute("aria-valuemax", "320");
    const currentItems = Array.from(container.querySelectorAll('[aria-current="page"]'));
    expect(currentItems.some((item) => item.textContent?.includes("Usage"))).toBe(true);
    expect(currentItems.some((item) => item.textContent?.includes("Analyze"))).toBe(false);
    expect(screen.getByRole("heading", { level: 1, name: "Usage" })).toBeInTheDocument();
  });

  it("keeps titlebar controls on the native traffic-light center line", async () => {
    const { container } = renderAppFrame("/trajectory");
    const mainSource = readFileSync(join(process.cwd(), "apps/desktop/electron/main.ts"), "utf8");

    expect(await screen.findByText("Main content")).toBeInTheDocument();

    const headerChrome = screen.getByTestId("header-chrome");
    const titleTrack = screen.getByTestId("header-chrome-title-track");
    const title = screen.getByTestId("header-chrome-title");
    const trigger = screen.getByRole("button", { name: "Collapse sidebar" });
    const heading = screen.getByRole("heading", { level: 1, name: "Trajectory" });

    expect(container.querySelector('[data-slot="navbar"]')).not.toBeInTheDocument();
    const headerHeight = Number.parseInt(
      headerChrome.style.getPropertyValue("--pigui-header-height"),
      10,
    );

    expect(headerChrome).toHaveStyle({ height: "40px" });
    expect(mainSource).toContain("trafficLightPosition: { x: 16, y: 13 }");
    expect(13).toBe((headerHeight - 14) / 2);
    expect(titleTrack).toHaveStyle({ left: "var(--pigui-chrome-safe-left)" });
    expect(title).toHaveStyle({
      transform:
        "translateX(calc(max(var(--pigui-main-left), var(--pigui-chrome-safe-left)) - var(--pigui-chrome-safe-left)))",
    });
    expect(trigger).toHaveStyle({ width: "28px", height: "28px" });
    expect(screen.getByTestId("header-chrome-left")).toHaveClass("pigui-header-chrome__left");
    expect(title).toHaveClass("h-7", "items-center");
    expect(heading).toHaveClass("leading-7");
  });

  it("uses only blank titlebar space as window drag regions", async () => {
    const { container } = renderAppFrame("/trajectory");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Collapse sidebar" });
    const heading = screen.getByRole("heading", { level: 1, name: "Trajectory" });
    const title = screen.getByTestId("header-chrome-title");
    const navbarSpacer = container.querySelector('[data-slot="navbar-spacer"]');
    const macTrafficSpace = within(screen.getByTestId("header-chrome")).getByTestId(
      "mac-traffic-space",
    );
    const dragRegions = container.querySelectorAll("[data-window-drag-region]");

    expect(dragRegions).toHaveLength(3);
    expect(macTrafficSpace).toHaveAttribute("data-window-drag-region");
    expect(navbarSpacer).toHaveAttribute("data-window-drag-region");
    expect(navbarSpacer).toHaveClass("h-full", "min-w-0", "flex-1", "select-none");
    expect(screen.getByTestId("header-chrome-title-track")).toHaveStyle({
      left: "var(--pigui-chrome-safe-left)",
    });
    expect(trigger).not.toHaveAttribute("data-window-drag-region");
    expect(title).not.toHaveAttribute("data-window-drag-region");
    expect(heading).not.toHaveAttribute("data-window-drag-region");
    expect(heading).toHaveClass("select-none");
  });

  it("renders route toolbar actions outside the titlebar drag region", async () => {
    const { container } = renderAppFrame("/projects/pig/sessions", {
      toolbarActions: <button type="button">Session actions</button>,
    });

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const navbarActions = screen.getByTestId("navbar-actions");
    const action = within(navbarActions).getByRole("button", {
      name: "Session actions",
    });

    expect(navbarActions).toBeInTheDocument();
    expect(action).toBeInTheDocument();
    expect(navbarActions).not.toHaveAttribute("data-window-drag-region");
    expect(action).not.toHaveAttribute("data-window-drag-region");
    expect(container.querySelector('[data-slot="navbar-spacer"]')).toHaveAttribute(
      "data-window-drag-region",
    );
    expect(container.querySelector('[data-slot="navbar"]')).not.toBeInTheDocument();
  });

  it("keeps the collapsed navbar title clear of native traffic lights", async () => {
    const user = userEvent.setup();
    const { container } = renderAppFrame("/");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const sidebar = container.querySelector('[data-testid="app-layout-sidebar"]');
    const styles = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");
    const headerChrome = screen.getByTestId("header-chrome");
    const titleTrack = screen.getByTestId("header-chrome-title-track");
    const title = screen.getByTestId("header-chrome-title");
    const fixedTrigger = within(headerChrome).getByRole("button", {
      name: "Collapse sidebar",
    });

    expect(container.querySelector('[data-testid="collapsed-traffic-space"]')).not.toBeInTheDocument();
    expect(headerChrome).toHaveStyle({ "--pigui-main-left": "260px" });
    expect(titleTrack).toHaveStyle({ left: "var(--pigui-chrome-safe-left)" });
    expect(title).toHaveStyle({
      transform:
        "translateX(calc(max(var(--pigui-main-left), var(--pigui-chrome-safe-left)) - var(--pigui-chrome-safe-left)))",
    });

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    // Offcanvas: the sidenav unmounts entirely when collapsed.
    expect(container.querySelector('[data-testid="app-layout-sidebar"]')).toBeNull();

    const collapsedTrigger = within(headerChrome).getByRole("button", {
      name: "Expand sidebar",
    });
    const dragRegions = container.querySelectorAll("[data-window-drag-region]");

    expect(collapsedTrigger).toBe(fixedTrigger);
    expect(titleTrack).toHaveStyle({ left: "var(--pigui-chrome-safe-left)" });
    expect(title).toHaveStyle({
      transform:
        "translateX(calc(max(var(--pigui-main-left), var(--pigui-chrome-safe-left)) - var(--pigui-chrome-safe-left)))",
    });
    expect(styles).not.toContain("collapsed-traffic-space");
    expect(styles).not.toContain("left: max(var(--pigui-main-left)");
    expect(styles).not.toContain("padding-left 200ms cubic-bezier(.2, .8, .2, 1)");
    expect(styles).not.toContain("padding-left: calc(var(--pigui-title-safe-offset)");
    expect(styles).not.toContain("transition: left 200ms cubic-bezier(.2, .8, .2, 1);");
    expect(styles).not.toContain("transform 200ms cubic-bezier(.2, .8, .2, 1)");
    expect(styles).toContain(".pigui-header-chrome__left {\n  position: absolute;");
    expect(styles).toContain("z-index: 1;");
    expect(styles).toContain(".pigui-header-chrome__title-track {\n  position: absolute;");
    expect(styles).toContain("z-index: 0;");
    expect(collapsedTrigger).not.toHaveAttribute("data-window-drag-region");
    expect(dragRegions).toHaveLength(3);
  });

  it("drives the fixed title from the sidebar's observed animation width", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const resizeObservers: Array<{ trigger: () => void }> = [];

    class TestResizeObserver {
      private callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        resizeObservers.push({
          trigger: () => this.callback([], this as unknown as ResizeObserver),
        });
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }

    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
      writable: true,
    });

    try {
      const user = userEvent.setup();
      const { container } = renderAppFrame("/");

      expect(await screen.findByText("Main content")).toBeInTheDocument();
      const sidebarPanel = container.querySelector<HTMLElement>(
        '[data-testid="app-layout-sidebar"]',
      );
      const headerChrome = screen.getByTestId("header-chrome");
      const title = screen.getByTestId("header-chrome-title");

      expect(sidebarPanel).toBeInTheDocument();
      if (!sidebarPanel) {
        throw new Error("Expected the SideNav root to be rendered");
      }

      let measuredWidth = 224;
      const mockPanelRect = () => {
        // SideNav remounts its root when the resizable wrapper toggles, so
        // re-apply the rect mock to the current node after open/close.
        const panel = container.querySelector<HTMLElement>(
          '[data-testid="app-layout-sidebar"]',
        );

        if (!panel) {
          throw new Error("Expected the SideNav root to be rendered");
        }

        panel.getBoundingClientRect = () =>
          ({
            bottom: 0,
            height: 0,
            left: 0,
            right: measuredWidth,
            top: 0,
            width: measuredWidth,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          }) as DOMRect;
      };

      mockPanelRect();

      await act(async () => {
        resizeObservers.forEach((observer) => observer.trigger());
      });

      expect(headerChrome).toHaveStyle({ "--pigui-main-left": "224px" });
      expect(title).toHaveStyle({
        transform:
          "translateX(calc(max(var(--pigui-main-left), var(--pigui-chrome-safe-left)) - var(--pigui-chrome-safe-left)))",
      });

      await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

      // Offcanvas: with the sidenav unmounted, the header snaps to the edge.
      expect(
        container.querySelector('[data-testid="app-layout-sidebar"]'),
      ).toBeNull();
      expect(headerChrome).toHaveStyle({ "--pigui-main-left": "0px" });

      await user.click(screen.getByRole("button", { name: "Expand sidebar" }));

      measuredWidth = 176;
      mockPanelRect();
      await act(async () => {
        resizeObservers.forEach((observer) => observer.trigger());
      });

      expect(headerChrome).toHaveStyle({ "--pigui-main-left": "176px" });
    } finally {
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: originalResizeObserver,
        writable: true,
      });
    }
  });

  it("collapses and reopens the sidenav with the fixed header chrome trigger", async () => {
    const user = userEvent.setup();
    const { container } = renderAppFrame("/");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const querySidebar = () =>
      container.querySelector('[data-testid="app-layout-sidebar"]');
    const layout = container.querySelector(".astryx-app-shell");
    const headerChrome = screen.getByTestId("header-chrome");
    const styles = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");

    expect(querySidebar()).toHaveAttribute("data-state", "expanded");
    expect(within(headerChrome).queryByRole("button", { name: "Expand sidebar" })).not.toBeInTheDocument();
    // The icon-rail middle state is disabled: the shell must not opt into
    // Astryx's collapsible rail at all.
    expect(container.querySelector(".astryx-side-nav")).not.toHaveAttribute(
      "data-mode",
      "rail",
    );
    void styles;

    await user.click(
      within(headerChrome).getByRole("button", {
        name: "Collapse sidebar",
      }),
    );

    // Offcanvas: collapsed means the sidenav leaves the DOM entirely — no
    // 48px icon rail in between.
    expect(querySidebar()).toBeNull();
    expect(layout).toHaveAttribute("data-sidebar-animating", "true");
    const expandTrigger = within(headerChrome).getByRole("button", {
      name: "Expand sidebar",
    });
    expect(expandTrigger).toHaveAttribute("data-slot", "sidebar-trigger");

    await user.click(expandTrigger);

    expect(querySidebar()).toHaveAttribute("data-state", "expanded");
    expect(
      within(headerChrome).getByRole("button", {
        name: "Collapse sidebar",
      }),
    ).toHaveAttribute("data-slot", "sidebar-trigger");
    expect(within(headerChrome).queryByRole("button", { name: "Expand sidebar" })).not.toBeInTheDocument();
  });

  it("keeps the desktop sidebar compact", async () => {
    const { container } = renderAppFrame("/");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const sidebar = container.querySelector<HTMLElement>('[data-testid="app-layout-sidebar"]');
    const styles = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");
    const source = readFileSync(join(process.cwd(), "apps/desktop/src/widgets/app-frame/app-frame.tsx"), "utf8");

    expect(sidebar).toHaveStyle({ width: "260px" });
    expect(styles).toContain("--pigui-sidebar-row-height: 1.875rem;");
    expect(styles).toContain("--pigui-sidebar-row-gap: var(--spacing-1);");
    expect(styles).toContain("--pigui-sidebar-row-icon-gap: 0.625rem;");
    expect(styles).toContain("--pigui-sidebar-icon-size: 1rem;");
    expect(styles).toContain(".pigui-app-layout .astryx-side-nav-item {");
    expect(styles).toContain("min-height: var(--pigui-sidebar-row-height);");
    expect(styles).toContain("border-radius: var(--pigui-sidebar-item-radius);");
    expect(styles).toContain(".pigui-app-layout .astryx-side-nav-item svg,");
    expect(styles).toContain("width: var(--pigui-sidebar-icon-size);");
    expect(styles).toContain("height: var(--pigui-sidebar-icon-size);");
    expect(source).toContain(
      'resizable={{ defaultWidth: 260, minWidth: 240, maxWidth: 320, autoSaveId: "pigui-app-shell" }}',
    );
    expect(source).not.toContain('resizableAutoSaveId="pig-app-shell"');
    expect(source).not.toContain('"--spacing"');
    expect(source).toContain("<ProjectActionsMenu");
    expect(source).toContain("MoreMenu");
    expect(source).not.toContain("min-w-40");
    expect(source).not.toContain('role="menu"');
    expect(source).not.toContain('role="menuitem"');
    expect(source).not.toContain("absolute right-0 top-7");
  });

  it("smooths sidebar icon rendering without changing icon sizing tokens", () => {
    const styles = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");
    const themeRootBlock = styles.match(
      /\n:root \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;

    expect(styles).toContain("-webkit-font-smoothing: antialiased;");
    expect(styles).toContain("-moz-osx-font-smoothing: grayscale;");
    expect(styles).toContain("text-rendering: optimizeLegibility;");
    expect(themeRootBlock).toContain("--pigui-sidebar-content-padding-x: 0.5rem;");
    expect(themeRootBlock).toContain("--pigui-sidebar-icon-box-size: 1.25rem;");
    expect(themeRootBlock).toContain("--pigui-sidebar-icon-size: 1rem;");
    expect(styles).toContain(".pigui-app-layout .astryx-side-nav-item svg,");
    expect(styles).toContain(".pigui-app-layout .astryx-more-menu svg,");
    expect(styles).toContain(".pigui-app-layout .pigui-session-glyph svg");
    expect(styles).toContain("shape-rendering: geometricPrecision;");
  });

  it("keeps Project and Session sidebar rows aligned while shrinking titles only", async () => {
    addProjectToRegistry(pigProjectPath, {
      now: () => "2026-06-30T08:00:00.000Z",
    });
    addProjectToRegistry("/Users/void/Documents/study", {
      now: () => "2026-06-30T09:00:00.000Z",
    });

    renderAppFrame("/projects/pig/sessions", { seedProjects: false });

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const styles = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");
    const source = readFileSync(join(process.cwd(), "apps/desktop/src/widgets/app-frame/app-frame.tsx"), "utf8");
    const projectGroup = screen.getByTestId("sidebar-projects");
    const projectHeader = getProjectHeaderButton(projectGroup, "Pig");
    const projectNavigation = getProjectSessionsGroup(projectGroup, "Pig");
    const activeSessionRow = getSessionRow(projectNavigation, "Agent Workspace shell");
    const sessionGlyph = activeSessionRow.querySelector('[data-testid="session-glyph"]');
    const emptyProjectNavigation = getProjectSessionsGroup(projectGroup, "study");
    const emptySessionRow = getSessionRow(emptyProjectNavigation, "No chats");
    const emptySessionGlyph = emptySessionRow.querySelector('[data-testid="session-glyph"]');

    // Every row leads with a fixed-size glyph slot so titles line up.
    expect(
      projectHeader.querySelector(".pigui-project-expansion-indicator"),
    ).toBeInTheDocument();
    expect(sessionGlyph).toHaveClass("pigui-session-glyph");
    expect(
      within(sessionGlyph as HTMLElement).getByLabelText("Active run"),
    ).toBeInTheDocument();
    expect(emptySessionGlyph).toHaveClass("pigui-session-glyph");
    expect(emptySessionGlyph).toBeEmptyDOMElement();
    // Titles are string labels: the component owns single-line truncation.
    expect(source).toContain("label={session.title}");
    expect(source).toContain("label={project.displayName}");
    expect(styles).toContain(".pigui-session-glyph {");
    expect(styles).toContain("flex: 0 0 auto;");
    expect(styles).toContain(".pigui-project-expansion-indicator {");
    expect(styles).toContain("width: var(--pigui-sidebar-icon-size);");
    // Astryx nests children at --spacing-6; that extra indent plus the glyph
    // slot parks short labels like "No chats" near the row center. Zero it
    // so the session glyph column matches the project folder column.
    expect(styles).toContain(
      ".pigui-sidenav-row-with-actions [role=\"group\"] > div:not(#\\#):not(#\\#):not(#\\#)",
    );
    expect(styles).toContain("padding-inline-start: 0;");
  });

  it("separates nested session rows so rounded washes do not pinch", async () => {
    renderAppFrame("/projects/pig/sessions");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    const styles = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");

    // Astryx SideNavSection spaces top-level items, but nested session rows
    // live in childrenInner with no gap — hover/selected pills collide, and
    // the project header sits flush on the first session row.
    expect(styles).toMatch(
      /\.pigui-sidenav-row-with-actions \[role="group"\] > div:not\(#\\#\):not\(#\\#\):not\(#\\#\) \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*gap: var\(--pigui-sidebar-row-gap\);/,
    );
    expect(styles).toMatch(
      /\.pigui-sidenav-row-with-actions \[role="group"\] > div:not\(#\\#\):not\(#\\#\):not\(#\\#\) \{[^}]*padding-block-start: var\(--pigui-sidebar-row-gap\);/,
    );
    expect(styles).toContain("--pigui-sidebar-row-gap: var(--spacing-1);");
  });

  it("uses the Astryx resizable separator without transparent overrides", async () => {
    const { container } = renderAppFrame("/");
    const styles = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="sidebar-rail"]')).not.toBeInTheDocument();
    expect(screen.getByTestId("astryx-sidenav-resize-handle")).toBeInTheDocument();
    expect(styles).not.toContain("astryx-resize-handle");
    expect(styles).not.toContain("--resizable-handle-color: transparent;");
    expect(styles).not.toContain("--resizable-handle-color-hover: transparent;");
    expect(styles).not.toContain("--resizable-handle-color-active: transparent;");
  });

  it("removes duplicate product identity from the shell chrome", async () => {
    const { container } = renderAppFrame("/");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="navbar"]')).not.toBeInTheDocument();
    expect(screen.getByTestId("header-chrome-title")).not.toHaveTextContent("Pig");
    expect(screen.queryByText("Pi flight recorder")).not.toBeInTheDocument();
  });

  it("uses the current section label as the content title", async () => {
    renderAppFrame("/sessions/session-a");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Trajectory" })).toBeInTheDocument();
  });

  it("gives routed pages a fixed-height content slot", async () => {
    renderAppFrame("/");

    expect(await screen.findByText("Main content")).toBeInTheDocument();
    expect(screen.getByTestId("app-frame-content")).toHaveClass("h-full", "min-h-0");
    expect(screen.getByTestId("app-frame-content")).not.toHaveClass("min-h-full");
    expect(screen.getByTestId("app-frame-content")).not.toHaveClass("bg-background");
  });

  it("keeps a transparent sidebar separate from the elevated content surface", async () => {
    renderAppFrame("/");

    await screen.findByText("Main content");
    const shellRoot = document.querySelector(".astryx-app-shell");
    const source = readFileSync(join(process.cwd(), "apps/desktop/src/widgets/app-frame/app-frame.tsx"), "utf8");
    const styles = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");

    expect(shellRoot).not.toBeNull();
    expect(shellRoot).toHaveAttribute("data-variant", "elevated");
    expect(shellRoot).not.toHaveClass("bg-background");
    expect(source).toContain('variant="elevated"');
    expect(source).not.toContain('variant="wash"');
    // Vibrancy (transparent sidebar) is macOS-only; other platforms keep an
    // opaque wash nav so the content surface still contrasts.
    expect(styles).toContain("html[data-pigui-vibrancy]");
    expect(styles).toContain("--pigui-sidebar-wash-alpha:");
    expect(styles).toContain(
      "color-mix(in srgb, var(--color-background-body) var(--pigui-sidebar-wash-alpha), transparent)",
    );
    expect(styles).toContain('.pigui-app-layout [role="main"]');
    expect(styles).toContain("background-color: var(--surface);");
    // Sticky titlebar/footer must not inherit another semi-transparent wash
    // or they composite into a second slab over the scrollable middle.
    expect(styles).toContain(".pigui-app-sidenav > div:not(#\\#):not(#\\#):not(#\\#)");
  });

  it("disables document-level elastic overscroll", () => {
    const source = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");

    expect(source).toContain("html,");
    expect(source).toContain("body,");
    expect(source).toContain("#root");
    expect(source).toContain("overscroll-behavior: none;");
    expect(source).toContain("overflow: hidden;");
    expect(source).toContain('.pigui-app-layout [role="main"]');
  });

  it("lets AppShell own the right content column surface", () => {
    const source = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");

    expect(source).not.toContain(".pigui-app-layout [data-slot=\"app-layout-body\"]");
    expect(source).not.toContain(".pigui-app-layout > [data-slot=\"app-layout-body\"]");
    expect(source).not.toContain("border: 1px solid var(--border);");
    expect(source).not.toContain("box-shadow: var(--surface-shadow);");
    expect(source).not.toContain("--pigui-color-");
    expect(source).not.toContain("border-radius: calc(var(--radius) * 2);");
    expect(source).not.toContain("margin: 0 calc(var(--spacing, 0.25rem) * 1) 0 0;");
  });

  it("uses compact styling for sidebar and picker menus", () => {
    const source = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");
    const appShellSource = readFileSync(
      join(process.cwd(), "apps/desktop/src/widgets/app-frame/app-frame.tsx"),
      "utf8",
    );

    expect(source).toContain("--pigui-sidebar-item-radius:");
    expect(source).not.toContain(".pigui-app-layout {\n  --pigui-sidebar-content-padding-x:");
    expect(source).toContain("--pigui-sidebar-dropdown-padding: 0.25rem;");
    expect(source).toContain("--pigui-sidebar-dropdown-menu-gap: var(--pigui-sidebar-row-gap);");
    expect(source).toContain("--pigui-sidebar-dropdown-item-height: 1.75rem;");
    expect(source).toContain("--pigui-sidebar-dropdown-item-gap: 0.5rem;");
    expect(source).toContain("--pigui-sidebar-dropdown-item-padding-x: 0.5rem;");
    expect(source).toContain("--pigui-sidebar-dropdown-item-padding-y: 0.25rem;");
    expect(source).toContain("--pigui-sidebar-dropdown-icon-size: 0.875rem;");
    expect(source).toContain(".pigui-app-layout .astryx-side-nav-item");
    expect(source).toContain("border-radius: var(--pigui-sidebar-item-radius);");
    expect(source).toContain(".pigui-compact-menu-popover");
    expect(source).toContain("border: 1px solid var(--separator);");
    expect(source).not.toContain("border: 0;");
    expect(source).toContain("box-shadow: 0 4px 14px 0 rgba(24, 24, 27, 0.10);");
    expect(source).toContain("gap: var(--pigui-sidebar-dropdown-menu-gap);");
    expect(source).toContain("padding: var(--pigui-sidebar-dropdown-padding);");
    expect(source).toContain(".pigui-compact-menu-item");
    expect(source).toContain("min-height: var(--pigui-sidebar-dropdown-item-height);");
    expect(source).toContain("gap: var(--pigui-sidebar-dropdown-item-gap);");
    expect(source).toContain("padding: var(--pigui-sidebar-dropdown-item-padding-y) var(--pigui-sidebar-dropdown-item-padding-x);");
    expect(source).toContain("width: var(--pigui-sidebar-dropdown-icon-size);");
    expect(source).toContain("height: var(--pigui-sidebar-dropdown-icon-size);");
    expect(source).not.toContain("border-radius: calc(var(--radius) * 0.75);");
    expect(source).not.toContain("pigui-sidebar-action-dropdown");
    expect(appShellSource).toContain("<Pencil");
    expect(appShellSource).toContain("<FolderOpen");
    expect(appShellSource).toContain("<Trash2");
    expect(appShellSource.match(/className="size-3.5"/g)).toBeNull();
  });

  it("keeps inactive sidebar menu text and icons at normal foreground color", () => {
    const source = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");

    expect(source).toContain(
      '.pigui-app-layout .astryx-side-nav-item:not([aria-disabled="true"]):not(:disabled)',
    );
    expect(source).toContain("color: var(--foreground);");
  });

  it("keeps primary sidebar navigation icons at the default compact size", () => {
    const source = readFileSync(
      join(process.cwd(), "apps/desktop/src/widgets/app-frame/app-frame.tsx"),
      "utf8",
    );

    expect(source).not.toContain("sidebarNavigationIconSlotClassName");
    expect(source).not.toContain("sidebarNavigationIconClassName");
    expect(source).not.toContain("size-[1.125rem]");
    expect(source).toContain('<AnimatedNewChat aria-hidden="true" className="size-4" />');
  });

  it("does not import standalone React Aria Heading into the app shell", () => {
    const source = readFileSync(
      join(process.cwd(), "apps/desktop/src/widgets/app-frame/app-frame.tsx"),
      "utf8",
    );

    expect(source).not.toContain('react-aria-components/Heading');
    expect(source).not.toContain("<Sidebar.Mobile");
  });

  it("extends web content into the native macOS titlebar overlay", () => {
    const mainSource = readFileSync(join(process.cwd(), "apps/desktop/electron/main.ts"), "utf8");

    expect(mainSource).toContain('titleBarStyle: "hidden"');
    expect(mainSource).toContain("trafficLightPosition: { x: 16, y: 13 }");
    expect(mainSource).toContain("width: 1280");
    expect(mainSource).toContain("height: 840");
    expect(mainSource).toContain("minWidth: 960");
    expect(mainSource).toContain("minHeight: 720");
  });

  it("does not replace macOS titlebar gestures with React window API handlers", () => {
    const source = readFileSync(join(process.cwd(), "apps/desktop/src/widgets/app-frame/app-frame.tsx"), "utf8");

    expect(source).not.toContain("startWindowDrag");
    expect(source).not.toContain("toggleWindowMaximize");
  });

  it("marks Electron drag regions with app-region CSS instead of renderer window commands", () => {
    const styles = readFileSync(join(process.cwd(), "apps/desktop/src/app/styles.css"), "utf8");
    const source = readFileSync(join(process.cwd(), "apps/desktop/src/widgets/app-frame/app-frame.tsx"), "utf8");

    expect(styles).toContain("-webkit-app-region: drag;");
    expect(styles).toContain("-webkit-app-region: no-drag;");
    expect(source).not.toContain("startWindowDrag");
    expect(source).not.toContain("toggleWindowMaximize");
  });

  it("shows the Settings update badge only when an update is ready", async () => {
    mockUpdateBridge({
      state: "ready",
      currentVersion: "0.0.1",
      availableVersion: "0.0.2",
    });

    renderAppFrame("/");

    const settingsRow = await screen.findByRole("button", { name: /Settings/ });
    const badge = within(settingsRow).getByLabelText("Update ready");

    expect(badge).toHaveAttribute("role", "img");
    expect(badge).toHaveClass("size-2", "rounded-full", "bg-primary");
  });

  it.each(["idle", "available", "disabled"] as const)(
    "does not show the Settings update badge when status is %s",
    async (state) => {
      mockUpdateBridge({ state, currentVersion: "0.0.1" });

      renderAppFrame("/");

      const settingsRow = await screen.findByRole("button", { name: /Settings/ });
      await waitFor(() => {
        expect(window.pace!.invoke).toHaveBeenCalledWith("update:status", undefined);
      });
      expect(within(settingsRow).queryByLabelText("Update ready")).not.toBeInTheDocument();
    },
  );

  it("toggles the Settings update badge when onUpdateEvent pushes a new status", async () => {
    const bridge = mockUpdateBridge({ state: "idle", currentVersion: "0.0.1" });

    renderAppFrame("/");

    const settingsRow = await screen.findByRole("button", { name: /Settings/ });
    await waitFor(() => {
      expect(window.pace!.invoke).toHaveBeenCalledWith("update:status", undefined);
    });
    expect(within(settingsRow).queryByLabelText("Update ready")).not.toBeInTheDocument();

    act(() => {
      bridge.emit({
        state: "ready",
        currentVersion: "0.0.1",
        availableVersion: "0.0.2",
      });
    });

    expect(within(settingsRow).getByLabelText("Update ready")).toBeInTheDocument();

    act(() => {
      bridge.emit({ state: "idle", currentVersion: "0.0.2" });
    });

    expect(within(settingsRow).queryByLabelText("Update ready")).not.toBeInTheDocument();
  });

  it("keeps the Settings update badge while the Settings route is open", async () => {
    mockUpdateBridge({
      state: "ready",
      currentVersion: "0.0.1",
      availableVersion: "0.0.2",
    });

    renderAppFrame("/settings");

    const settingsRow = await screen.findByRole("button", { name: /Settings/ });

    expect(within(settingsRow).getByLabelText("Update ready")).toBeInTheDocument();
  });
});
