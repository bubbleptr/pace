import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionChanges } from "@pace/core";
import type { PromptCommandCatalog } from "@pace/core";
import { CHAT_PROJECT_ID } from "@pace/core";
import type { WorkspaceFileMatch } from "@pace/core";
import { invokeBrowserFallback } from "@/shared/runtime";
import {
  createSessionProjection,
  type SessionProjection,
} from "@/entities/session/session-projection";
import type { SessionProjectionsStore } from "@/entities/session/session-projections-store";
import {
  SessionProjectionsProvider,
  useSessionProjections,
} from "@/entities/session/use-session-projections";
import type { PiRuntimeBridge } from "@/entities/runtime/pi-runtime-bridge";
import { saveFollowUpDraft, clearFollowUpDraft } from "@/entities/session/follow-up-drafts";
import { findPromptInput, promptValue } from "@/test/prompt-input";
import { render } from "@/test/render";
import { FullChatComposer } from "./full-chat-composer";

describe("Context usage placement", () => {
  function boundProjection(
    overrides: Partial<SessionProjection> = {},
  ): SessionProjection {
    return {
      ...createSessionProjection({
        id: "session-context",
        projectId: "pig-docs",
        initialPrompt: "Watch the context window fill up",
        createdAt: "2026-08-20T08:00:00.000Z",
      }),
      status: "completed" as const,
      runtimeId: "pi-sdk:session-context",
      piSessionId: "pi-session-context",
      contextUsage: { tokens: 90_000, contextWindow: 200_000, percent: 45 },
      ...overrides,
    };
  }

  function renderComposerFooter(
    projection: SessionProjection,
    sessionChanges?: {
      changes: SessionChanges | null;
      error: string | null;
      loading: boolean;
      refresh: () => void;
      checkoutBranch: (branch: string) => Promise<void>;
    },
    { queueMode = false }: { queueMode?: boolean } = {},
  ) {
    render(
      <FullChatComposer
        projection={projection}
        queueMode={queueMode}
        sessionChanges={sessionChanges ? { ...sessionChanges, refreshing: false } : undefined}
      />,
    );

    return screen
      .getByTestId("full-chat-composer")
      .querySelector('[data-slot="prompt-input-footer"]');
  }

  function gitChanges(overrides: Partial<SessionChanges> = {}): SessionChanges {
    return {
      sessionId: "session-context",
      state: "clean",
      checkoutRoot: "/work/Pace",
      repositoryRoot: "/work/Pace",
      generatedAt: "2026-09-04T00:00:00.000Z",
      head: {
        oid: "abc1234deadbeef",
        branch: "feat/composer-git",
        detached: false,
      },
      branches: ["feat/composer-git", "main", "fix/spacing", "feat/chat-chain-of-thought-rail"],
      files: [],
      totals: {
        files: 0,
        additions: 0,
        deletions: 0,
        binaryFiles: 0,
        conflictedFiles: 0,
      },
      truncated: false,
      omittedFileCount: 0,
      ...overrides,
    };
  }

  it("meters the context window as a ring on the composer footer line", () => {
    const footer = renderComposerFooter(boundProjection());

    expect(footer?.querySelector('[data-slot="context-usage-meter"]')).toHaveAttribute(
      "aria-label",
      "Context 45% · 200K",
    );
  });

  it("keeps the footer line while a run is queueing", () => {
    const footer = renderComposerFooter(boundProjection({ status: "running" }), undefined, {
      queueMode: true,
    });

    expect(
      footer?.querySelector('[data-slot="context-usage-meter"]'),
    ).toBeInTheDocument();
  });

  it("meters nothing until a runtime is bound, and keeps the Location row", () => {
    const footer = renderComposerFooter(boundProjection({ piSessionId: null }));

    // The row survives Session Creation so the composer keeps its height
    // through the Draft → Live handoff; only the share is unknown until a
    // runtime has a context window to be a share of.
    expect(footer).toBeInTheDocument();
    expect(
      footer?.querySelector('[data-slot="context-usage-meter"]'),
    ).toHaveAttribute("aria-label", "Context usage not reported yet");
  });

  function idleSessionChanges(
    changes: SessionChanges | null,
    checkoutBranch: (branch: string) => Promise<void> = async () => {},
  ) {
    return {
      changes,
      error: null as string | null,
      loading: false,
      refresh: () => {},
      checkoutBranch,
    };
  }

  it("shows the Session git branch to the left of the context ring", () => {
    const footer = renderComposerFooter(boundProjection(), idleSessionChanges(gitChanges()));
    const trigger = footer?.querySelector(
      '[data-testid="git-branch-status-trigger"]',
    );
    const ring = footer?.querySelector('[data-slot="context-usage-meter"]');
    const icon = footer?.querySelector('[data-testid="git-branch-status-icon"]');

    expect(trigger).toHaveTextContent("feat/composer-git");
    expect(icon).toBeInTheDocument();
    expect(ring).toBeInTheDocument();
    expect(
      trigger && ring
        ? Boolean(
            trigger.compareDocumentPosition(ring) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          )
        : false,
    ).toBe(true);
  });

  it("labels a detached HEAD with the short oid", () => {
    const footer = renderComposerFooter(
      boundProjection(),
      idleSessionChanges(
        gitChanges({
          head: {
            oid: "deadbeefcafebabe",
            branch: null,
            detached: true,
          },
        }),
      ),
    );

    expect(
      footer?.querySelector('[data-testid="git-branch-status-trigger"]'),
    ).toHaveTextContent("deadbee");
  });

  it("checks out the selected local branch on the Session checkout", async () => {
    const user = userEvent.setup();
    const checkoutBranch = vi.fn(async () => {});
    renderComposerFooter(
      boundProjection(),
      idleSessionChanges(gitChanges(), checkoutBranch),
    );

    await user.click(screen.getByTestId("git-branch-status-trigger"));
    await user.click(await screen.findByRole("option", { name: "main" }));

    expect(checkoutBranch).toHaveBeenCalledWith("main");
  });

  it("surfaces a failed checkout on the composer", async () => {
    const user = userEvent.setup();
    const checkoutBranch = vi.fn(async () => {
      throw new Error(
        "Please commit your changes or stash them before you switch branches.",
      );
    });
    renderComposerFooter(
      boundProjection(),
      idleSessionChanges(gitChanges(), checkoutBranch),
    );

    await user.click(screen.getByTestId("git-branch-status-trigger"));
    await user.click(await screen.findByRole("option", { name: "main" }));

    expect(
      await screen.findByText(
        /stash them before you switch branches/i,
      ),
    ).toBeInTheDocument();
  });

  it("hides the git branch chip when the checkout is not a repository", () => {
    const footer = renderComposerFooter(
      boundProjection(),
      idleSessionChanges(
        gitChanges({
          state: "non-git",
          repositoryRoot: null,
          head: undefined,
        }),
      ),
    );

    expect(
      footer?.querySelector('[data-testid="git-branch-status"]'),
    ).not.toBeInTheDocument();
    expect(
      footer?.querySelector('[data-slot="context-usage-meter"]'),
    ).toBeInTheDocument();
  });
});

describe("FullChatComposer slash commands", () => {
  const catalog: PromptCommandCatalog = {
    source: "runtime",
    commands: [
      { kind: "skill", name: "review-pr", invocation: "skill:review-pr", description: "Review a pull request" },
      { kind: "prompt", name: "fix", invocation: "fix", description: "Fix a bug" },
      { kind: "extension", name: "deploy", invocation: "deploy", description: "Deploy the app" },
    ],
  };

  function mockCommands(
    next: PromptCommandCatalog = catalog,
    workspaceFiles: WorkspaceFileMatch[] = [],
  ) {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_prompt_commands") {
        return next;
      }
      if (command === "search_workspace_files") {
        const query = String(args?.query ?? "");
        return {
          matches: workspaceFiles.filter((match) => match.path.includes(query)),
          truncated: false,
        };
      }
      return invokeBrowserFallback(command, args);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };
    return invoke;
  }

  function liveProjection(): SessionProjection {
    return {
      ...createSessionProjection({
        id: "session-cmds",
        projectId: "pig-docs",
        initialPrompt: "start",
        createdAt: "2026-08-20T08:00:00.000Z",
      }),
      status: "waiting" as const,
      runtimeId: "pi-sdk:session-cmds",
      piSessionId: "pi-session-cmds",
    };
  }

  /**
   * Caret inside the last text node — Astryx's trigger detection reads
   * range.startContainer and only fires when it's a text node, matching
   * where a real keystroke leaves the caret.
   */
  function caretAtEnd(element: HTMLElement) {
    element.focus();
    const range = document.createRange();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let lastText: Node | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      lastText = node;
    }
    if (lastText) {
      range.setStart(lastText, lastText.textContent?.length ?? 0);
      range.collapse(true);
    } else {
      range.selectNodeContents(element);
      range.collapse(false);
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function typeAtCaret(element: HTMLElement, text: string) {
    element.textContent = `${element.textContent ?? ""}${text}`;
    caretAtEnd(element);
    fireEvent.input(element);
  }

  beforeEach(() => {
    clearFollowUpDraft("session-cmds");
    delete window.pace;
  });

  it("submits a picked command token with a plain space before the args", async () => {
    const onPromptSubmit = vi.fn();
    const user = userEvent.setup();
    mockCommands();
    render(<FullChatComposer projection={liveProjection()} onPromptSubmit={onPromptSubmit} />);
    const input = await findPromptInput();

    typeAtCaret(input, "/");
    await user.click(await screen.findByRole("option", { name: /review-pr/ }));
    await waitFor(() => expect(promptValue(input)).toBe("/skill:review-pr\u00A0"));

    input.appendChild(document.createTextNode("参数"));
    fireEvent.input(input);
    await waitFor(() => expect(promptValue(input)).toBe("/skill:review-pr\u00A0参数"));

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onPromptSubmit).toHaveBeenCalledWith("/skill:review-pr 参数", []);
  });

  it("hides extension commands in queue mode across both entry points", async () => {
    const user = userEvent.setup();
    mockCommands();
    render(
      <FullChatComposer
        projection={{ ...liveProjection(), status: "running" }}
        queueMode
        onQueueSubmit={() => {}}
      />,
    );
    const input = await findPromptInput();

    // Slash completion keeps skills and prompts but drops extensions.
    typeAtCaret(input, "/");
    await screen.findByRole("option", { name: /review-pr/ });
    expect(screen.queryByRole("option", { name: /deploy/ })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });

    // The + menu drops the whole Commands group; file references still work
    // — queueing a file mention is just text.
    await user.click(screen.getByRole("button", { name: "Add to prompt" }));
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["Add files", "Skills", "Prompts", "Reference file"]);
  });

  it("blocks submitting an existing extension token while a run queues", async () => {
    const onQueueSubmit = vi.fn();
    const user = userEvent.setup();
    mockCommands();
    saveFollowUpDraft("session-cmds", "/deploy prod");
    render(
      <FullChatComposer
        projection={{ ...liveProjection(), status: "running" }}
        queueMode
        onQueueSubmit={onQueueSubmit}
      />,
    );
    const input = await findPromptInput();

    // The saved command still rehydrates into a token so the block is visible.
    await waitFor(() =>
      expect(input.querySelector("[data-astryx-token]")).toHaveAttribute(
        "data-astryx-token-value",
        "/deploy",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await screen.findByText(/can't be queued/),
    ).toBeInTheDocument();
    expect(onQueueSubmit).not.toHaveBeenCalled();
    expect(promptValue(input)).toBe("/deploy\u00A0prod");
  });

  it("refetches the catalog when a cold session's run starts, surfacing extension commands", async () => {
    // The first answer is the static catalog (no extension commands — the
    // session is cold); the runtime answer includes them.
    const staticCatalog: PromptCommandCatalog = {
      source: "static",
      commands: catalog.commands.filter((command) => command.kind !== "extension"),
    };
    // The backend answers with extension commands only once the runtime is
    // live — before that the same RPC resolves the static catalog.
    let runtimeLive = false;
    let promptCommandCalls = 0;
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_prompt_commands") {
        promptCommandCalls += 1;
        return runtimeLive ? catalog : staticCatalog;
      }
      if (command === "list_session_projections") {
        // A cold Session already carries piSessionId — the runtime binding
        // key alone never moves when it goes live.
        return [
          {
            sessionId: "session-cmds",
            runtimeId: "pi-sdk:session-cmds",
            piSessionId: "pi-session-cmds",
            projectId: "pig-docs",
            cwd: "/work/Pig",
            status: "completed",
            sessionFile: "/tmp/session-cmds.jsonl",
            updatedAt: "2026-08-20T08:00:00.000Z",
          },
        ];
      }
      return invokeBrowserFallback(command, args);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };

    // usePromptCommands reads the projections context, so mount the real
    // provider (rehydrating from the mocked list) and expose its store.
    const bridge = {
      subscribeToEvents: () => () => {},
      subscribeToAgentEvents: () => () => {},
      subscribeToModelControls: () => () => {},
    } as unknown as PiRuntimeBridge;
    let store: SessionProjectionsStore | null = null;
    function Probe() {
      store = useSessionProjections().store;
      return null;
    }
    render(
      <SessionProjectionsProvider bridge={bridge}>
        <Probe />
        <FullChatComposer projection={liveProjection()} onPromptSubmit={() => {}} />
      </SessionProjectionsProvider>,
    );
    const input = await findPromptInput();
    await waitFor(() => expect(store?.get("session-cmds")).toBeTruthy());

    typeAtCaret(input, "/");
    await screen.findByRole("option", { name: /review-pr/ });
    expect(screen.queryByRole("option", { name: /deploy/ })).not.toBeInTheDocument();

    const callsBeforeRun = promptCommandCalls;
    // A run starting is the moment the runtime is guaranteed live.
    act(() => {
      runtimeLive = true;
      store!.apply("session-cmds", {
        type: "runtime-event-received",
        event: {
          id: "evt-1",
          piSessionId: "pi-session-cmds",
          kind: "thinking",
          body: "working",
          timestamp: "2026-08-20T08:01:00.000Z",
        },
      });
    });

    // The already-open slash menu picks up the refetched catalog.
    expect(await screen.findByRole("option", { name: /deploy/ })).toBeInTheDocument();
    expect(promptCommandCalls).toBeGreaterThan(callsBeforeRun);
  });
});

describe("FullChatComposer file references", () => {
  const files: WorkspaceFileMatch[] = [
    { path: "apps/desktop/x.ts", kind: "file" },
    { path: "src", kind: "directory" },
  ];

  function fileProjection(
    overrides: Partial<SessionProjection> = {},
  ): SessionProjection {
    return {
      ...createSessionProjection({
        id: "session-files",
        projectId: "pig-docs",
        initialPrompt: "start",
        createdAt: "2026-08-20T08:00:00.000Z",
      }),
      status: "waiting" as const,
      runtimeId: "pi-sdk:session-files",
      piSessionId: "pi-session-files",
      ...overrides,
    };
  }

  function caretAtEnd(element: HTMLElement) {
    element.focus();
    const range = document.createRange();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let lastText: Node | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      lastText = node;
    }
    if (lastText) {
      range.setStart(lastText, lastText.textContent?.length ?? 0);
      range.collapse(true);
    } else {
      range.selectNodeContents(element);
      range.collapse(false);
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function typeAtCaret(element: HTMLElement, text: string) {
    element.textContent = `${element.textContent ?? ""}${text}`;
    caretAtEnd(element);
    fireEvent.input(element);
  }

  beforeEach(() => {
    clearFollowUpDraft("session-files");
    delete window.pace;
  });

  it("completes a file reference mid-sentence and submits the serialized path", async () => {
    const onPromptSubmit = vi.fn();
    const user = userEvent.setup();
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_prompt_commands") {
        return { source: "runtime", commands: [] } satisfies PromptCommandCatalog;
      }
      if (command === "search_workspace_files") {
        const query = String(args?.query ?? "");
        return {
          matches: files.filter((match) => match.path.includes(query)),
          truncated: false,
        };
      }
      return invokeBrowserFallback(command, args);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };
    render(
      <FullChatComposer
        projection={fileProjection()}
        onPromptSubmit={onPromptSubmit}
      />,
    );
    const input = await findPromptInput();

    typeAtCaret(input, "look at @ap");
    await user.click(await screen.findByRole("option", { name: /x\.ts/ }));

    await waitFor(() =>
      expect(promptValue(input)).toBe("look at @apps/desktop/x.ts\u00A0"),
    );

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onPromptSubmit).toHaveBeenCalledWith("look at @apps/desktop/x.ts", []);
  });

  it("inserts the visible file result when an older search finishes last", async () => {
    const user = userEvent.setup();
    const pendingSearches = new Map<string, (matches: WorkspaceFileMatch[]) => void>();
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "search_workspace_files") {
        return new Promise((resolve) => {
          pendingSearches.set(String(args?.query), (matches) => {
            resolve({ matches, truncated: false });
          });
        });
      }
      return invokeBrowserFallback(command, args);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };
    render(<FullChatComposer projection={fileProjection()} onPromptSubmit={() => {}} />);
    const input = await findPromptInput();

    await user.click(screen.getByRole("button", { name: "Add to prompt" }));
    await user.click(await screen.findByRole("menuitem", { name: "Reference file" }));
    const search = await screen.findByRole("combobox", { name: "Search files" });
    await user.type(search, "a");
    await waitFor(() => expect(pendingSearches.has("a")).toBe(true));
    await user.type(search, "b");
    await waitFor(() => expect(pendingSearches.has("ab")).toBe(true));

    await act(async () => {
      pendingSearches.get("ab")!([{ path: "ab.ts", kind: "file" }]);
    });
    await act(async () => {
      pendingSearches.get("a")!([{ path: "a.ts", kind: "file" }]);
    });
    await user.click(await screen.findByRole("option", { name: /ab\.ts/ }));

    expect(promptValue(input)).toBe("@ab.ts\u00A0");
  });

  it("offers no @ completion and no Reference file group in a Chat session", async () => {
    const user = userEvent.setup();
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "search_workspace_files") {
        return { matches: files, truncated: false };
      }
      return invokeBrowserFallback(command, args);
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn(() => vi.fn()),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };
    render(
      <FullChatComposer
        projection={fileProjection({ projectId: CHAT_PROJECT_ID })}
        onPromptSubmit={() => {}}
      />,
    );
    const input = await findPromptInput();

    typeAtCaret(input, "@a");
    await waitFor(() => expect(promptValue(input)).toBe("@a"));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(
      invoke.mock.calls.filter(([command]) => command === "search_workspace_files"),
    ).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Add to prompt" }));
    expect(
      screen.queryByRole("menuitem", { name: "Reference file" }),
    ).not.toBeInTheDocument();
  });
});

describe("FullChatComposer browser comments", () => {
  const SESSION_ID = "session-comments";

  function comment(id: string, index: number, overrides = {}) {
    return {
      id,
      index,
      selector: `#${id}`,
      tag: "button",
      comment: `note ${id}`,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      tabId: "t1",
      url: "http://localhost:3000/",
      title: "A",
      viewport: { width: 800, height: 600, dpr: 1 },
      stale: false,
      hasImage: false,
      createdAt: "2026-10-10T09:00:00.000Z",
      ...overrides,
    };
  }

  function liveProjection() {
    return {
      ...createSessionProjection({
        id: SESSION_ID,
        projectId: "pig-docs",
        initialPrompt: "start",
        createdAt: "2026-08-20T08:00:00.000Z",
      }),
      status: "waiting" as const,
      runtimeId: `pi-sdk:${SESSION_ID}`,
      piSessionId: `pi-${SESSION_ID}`,
    };
  }

  function installPreload(options: { comments?: ReturnType<typeof comment>[] } = {}) {
    const listeners = new Set<(event: unknown) => void>();
    const comments = options.comments ?? [];
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_prompt_commands") {
        return { source: "runtime", commands: [] };
      }
      if (command === "browser_list_comments") {
        return comments;
      }
      if (command === "browser_comment_images") {
        const ids = (args?.ids as string[]) ?? [];
        return Object.fromEntries(
          ids.map((id) => [id, `data:image/png;base64,${btoa(id.toUpperCase())}`]),
        );
      }
      if (command === "browser_delete_comment" || command === "browser_consume_comments") {
        return null;
      }
      return null;
    });
    window.pace = {
      invoke: invoke as unknown as NonNullable<typeof window.pace>["invoke"],
      onBackendEvent: vi.fn(() => vi.fn()),
      onBrowserEvent: vi.fn((listener) => {
        listeners.add(listener as (event: unknown) => void);
        return () => listeners.delete(listener as (event: unknown) => void);
      }),
      onUpdateEvent: vi.fn(() => vi.fn()),
      onWindowFocusChanged: vi.fn(() => vi.fn()),
      onNavigateRequest: vi.fn(() => vi.fn()),
    };
    return {
      invoke,
      publish(event: unknown) {
        for (const listener of listeners) {
          listener(event);
        }
      },
      callsFor(command: string) {
        return invoke.mock.calls.filter(([name]) => name === command);
      },
    };
  }

  const commentsGroup = () =>
    screen.findByRole("group", { name: "Browser comments" });

  function typeText(element: HTMLElement, text: string) {
    element.textContent = text;
    fireEvent.input(element);
  }

  beforeEach(() => {
    clearFollowUpDraft(SESSION_ID);
    delete window.pace;
  });

  it("shows the Session's comments as chips and flags stale ones", async () => {
    installPreload({
      comments: [
        comment("c1", 1),
        comment("c2", 2, { stale: true }),
      ],
    });
    render(<FullChatComposer projection={liveProjection()} />);

    const group = await commentsGroup();
    expect(screen.getByText("#1 note c1")).toBeInTheDocument();
    const staleChip = screen
      .getByText("#2 note c2")
      .closest("[aria-description]");
    expect(staleChip).toHaveAttribute(
      "aria-description",
      "No longer on the page — sent as it was when saved",
    );
    expect(group).toBeInTheDocument();
  });

  it("removes a chip through the store", async () => {
    const preload = installPreload({ comments: [comment("c1", 1)] });
    const user = userEvent.setup();
    render(<FullChatComposer projection={liveProjection()} />);

    await commentsGroup();
    await user.click(
      screen.getAllByRole("button", { name: /remove/i })[0]!,
    );

    expect(preload.callsFor("browser_delete_comment")).toEqual([
      ["browser_delete_comment", { sessionId: SESSION_ID, id: "c1" }],
    ]);
  });

  it("sends the draft plus the comments block and screenshots, then consumes the snapshot", async () => {
    const preload = installPreload({
      comments: [
        comment("c1", 1, { hasImage: true }),
        comment("c2", 2),
      ],
    });
    const onPromptSubmit = vi.fn(async () => {});
    const user = userEvent.setup();
    render(
      <FullChatComposer
        projection={liveProjection()}
        onPromptSubmit={onPromptSubmit}
      />,
    );
    const input = await findPromptInput();
    await commentsGroup();

    typeText(input, "Please look");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onPromptSubmit).toHaveBeenCalledOnce());
    const [prompt, images] = onPromptSubmit.mock.calls[0]! as unknown as [
      string,
      { name: string; mimeType: string; data: string }[],
    ];

    // Draft first, then the comments block — the contract Pi reads.
    expect(prompt.startsWith("Please look\n\nBrowser comments from the embedded preview.")).toBe(true);
    expect(prompt).toContain("[screenshot] has a cropped screenshot");
    expect(prompt).toContain("#1 [screenshot] `#c1` (button)");
    expect(prompt).toContain("note c1");
    expect(prompt).toContain("#2 `#c2` (button)");
    expect(prompt).toContain("- rect: 10×10 at (0, 0)");

    // Only the comment that has a shot rides along, in comment order.
    expect(images).toEqual([
      {
        mimeType: "image/png",
        data: btoa("C1"),
        name: "browser-comment-1.png",
      },
    ]);

    await waitFor(() =>
      expect(preload.callsFor("browser_consume_comments")).toEqual([
        [
          "browser_consume_comments",
          { sessionId: SESSION_ID, ids: ["c1", "c2"] },
        ],
      ]),
    );
  });

  it("keeps a comment that arrives while the send is in flight", async () => {
    let releaseSend = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const preload = installPreload({ comments: [comment("c1", 1)] });
    const onPromptSubmit = vi.fn(() => sendGate);
    const user = userEvent.setup();
    render(
      <FullChatComposer
        projection={liveProjection()}
        onPromptSubmit={onPromptSubmit}
      />,
    );
    const input = await findPromptInput();
    await commentsGroup();

    typeText(input, "look");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onPromptSubmit).toHaveBeenCalledOnce());

    act(() => {
      preload.publish({
        type: "comments-changed",
        sessionId: SESSION_ID,
        comments: [comment("c1", 1), comment("c2", 2)],
      });
    });
    await act(async () => releaseSend());

    await waitFor(() =>
      expect(preload.callsFor("browser_consume_comments")).toEqual([
        [
          "browser_consume_comments",
          { sessionId: SESSION_ID, ids: ["c1"] },
        ],
      ]),
    );
  });

  it("consumes nothing when the send fails", async () => {
    const preload = installPreload({ comments: [comment("c1", 1)] });
    const onPromptSubmit = vi.fn(async () => {
      throw new Error("Pi said no");
    });
    const user = userEvent.setup();
    render(
      <FullChatComposer
        projection={liveProjection()}
        onPromptSubmit={onPromptSubmit}
      />,
    );
    const input = await findPromptInput();
    await commentsGroup();

    typeText(input, "look");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onPromptSubmit).toHaveBeenCalledOnce());
    // Let the rejection settle — then the store must still hold the comment.
    await act(async () => {});
    expect(preload.callsFor("browser_consume_comments")).toHaveLength(0);
    expect(await screen.findByText(/Pi said no/)).toBeInTheDocument();
  });

  it("bakes the comments into a queued message the same way", async () => {
    const preload = installPreload({ comments: [comment("c1", 1)] });
    const onQueueSubmit = vi.fn(async () => {});
    const user = userEvent.setup();
    render(
      <FullChatComposer
        projection={liveProjection()}
        queueMode
        onQueueSubmit={onQueueSubmit}
      />,
    );
    const input = await findPromptInput();
    await commentsGroup();

    typeText(input, "queued look");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onQueueSubmit).toHaveBeenCalledOnce());
    const [prompt] = onQueueSubmit.mock.calls[0]! as unknown as [string];
    expect(prompt).toContain("Browser comments from the embedded preview.");
    expect(prompt).toContain("#1 `#c1` (button)");

    await waitFor(() =>
      expect(preload.callsFor("browser_consume_comments")).toHaveLength(1),
    );
  });

  it("sends an empty draft that carries only comments", async () => {
    installPreload({ comments: [comment("c1", 1)] });
    const onPromptSubmit = vi.fn(async () => {});
    const user = userEvent.setup();
    render(
      <FullChatComposer
        projection={liveProjection()}
        onPromptSubmit={onPromptSubmit}
      />,
    );
    await findPromptInput();
    await commentsGroup();

    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onPromptSubmit).toHaveBeenCalledOnce());
    const [prompt] = onPromptSubmit.mock.calls[0]! as unknown as [string];
    expect(prompt.startsWith("Browser comments from the embedded preview.")).toBe(
      true,
    );
  });

  it("submits when the page asks the composer to send", async () => {
    installPreload({ comments: [comment("c1", 1)] });
    const onPromptSubmit = vi.fn(async () => {});
    render(
      <FullChatComposer
        projection={liveProjection()}
        onPromptSubmit={onPromptSubmit}
      />,
    );
    await findPromptInput();
    await commentsGroup();

    const { requestComposerSubmit } = await import(
      "@/entities/session/composer-submit-requests"
    );
    act(() => {
      expect(requestComposerSubmit(SESSION_ID)).toBe(true);
    });

    await waitFor(() => expect(onPromptSubmit).toHaveBeenCalledOnce());
    const [prompt] = onPromptSubmit.mock.calls[0]! as unknown as [string];
    expect(prompt).toContain("#1 `#c1` (button)");
  });

  it("ignores a page submit request with nothing to send", async () => {
    installPreload();
    const onPromptSubmit = vi.fn(async () => {});
    render(
      <FullChatComposer
        projection={liveProjection()}
        onPromptSubmit={onPromptSubmit}
      />,
    );
    await findPromptInput();

    // A stray Cmd/Ctrl+Enter in the page: the composer is mounted, so the
    // request is delivered — but an empty draft and an empty drawer mean a
    // no-op, not "Type a message or attach a file."
    const { requestComposerSubmit } = await import(
      "@/entities/session/composer-submit-requests"
    );
    act(() => {
      expect(requestComposerSubmit(SESSION_ID)).toBe(true);
    });

    await act(async () => {});
    expect(onPromptSubmit).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Type a message or attach a file."),
    ).not.toBeInTheDocument();
  });

  it("ignores a page submit request while Session Creation owns the composer", async () => {
    installPreload({ comments: [comment("c1", 1)] });
    saveFollowUpDraft(SESSION_ID, "a draft waiting to send");
    const onPromptSubmit = vi.fn(async () => {});
    render(
      <FullChatComposer
        isCreating
        projection={liveProjection()}
        onPromptSubmit={onPromptSubmit}
      />,
    );
    await findPromptInput();
    await commentsGroup();

    const { requestComposerSubmit } = await import(
      "@/entities/session/composer-submit-requests"
    );
    act(() => {
      expect(requestComposerSubmit(SESSION_ID)).toBe(true);
    });

    await act(async () => {});
    // There was something to send, but the input is locked — the request is
    // answered "delivered" without going out, like pressing a disabled Send.
    expect(onPromptSubmit).not.toHaveBeenCalled();
  });
});
