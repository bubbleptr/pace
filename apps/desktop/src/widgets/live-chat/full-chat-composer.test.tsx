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
