import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGitSummary, PromptCommandCatalog } from "@pace/core";
import type { ProjectRegistryEntry } from "@/entities/project/project-registry";
import { invokeBrowserFallback } from "@/shared/runtime";
import { saveLastModelSelection } from "@/entities/session/last-model-preference";
import { saveSessionDraft, type SessionDraft } from "@/entities/session/session-drafts";
import { providerAuthStatusQueryKey } from "@/entities/session/use-provider-auth-status";
import { footerOf } from "@/test/composer-footer";
import { findPromptInput, getPromptInput, promptValue } from "@/test/prompt-input";
import { render } from "@/test/render";
import { SessionDraftComposer, type SessionDraftSubmitEvent } from "./session-draft-composer";

const pigProjectPath = "/Users/void/code/opensource/Pig";

const pigProject: ProjectRegistryEntry = {
  id: pigProjectPath,
  path: pigProjectPath,
  displayName: "Pig",
  addedAt: "2026-01-01T00:00:00.000Z",
};

const promptCatalog: PromptCommandCatalog = {
  source: "static",
  commands: [
    { kind: "skill", name: "review-pr", invocation: "skill:review-pr", description: "Review a pull request" },
    { kind: "skill", name: "write-docs", invocation: "skill:write-docs", description: "Write documentation" },
    { kind: "prompt", name: "fix", invocation: "fix", description: "Fix a bug" },
    { kind: "extension", name: "deploy", invocation: "deploy", description: "Deploy the app" },
  ],
};

function mockPromptCommands(catalog: PromptCommandCatalog = promptCatalog) {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "list_prompt_commands") {
      return catalog;
    }
    if (command === "get_config_inventory") {
      return { skills: [], extensions: [], packages: [], promptTemplates: [] };
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

/**
 * Caret at the end of the contentEditable — what typing leaves behind.
 * Astryx's trigger detection requires the caret inside a text node, so
 * collapse into the last one rather than onto the editable element.
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

// The column owns the draft store; this stands in for it so typing and a
// picked suggestion land back in the composer's `draft` prop.
function DraftComposer({
  draft: initialDraft,
  projectGitSummary = null,
  projects = [],
  onDraftSubmit = () => {},
}: {
  draft: SessionDraft;
  projectGitSummary?: ProjectGitSummary | null;
  projects?: ProjectRegistryEntry[];
  onDraftSubmit?: (event: SessionDraftSubmitEvent) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);

  return (
    <SessionDraftComposer
      draft={draft}
      projects={projects}
      creationProjection={null}
      recommendedCheckoutMode="local"
      projectGit={{ summary: projectGitSummary, checkoutBranch: async () => {} }}
      onDraftChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
      onDraftCheckoutModeChange={() => {}}
      onDraftBaseRefChange={() => {}}
      onDraftTargetChange={() => {}}
      onDraftSubmit={onDraftSubmit}
    />
  );
}

// The no-providers gate links to Settings through the router.
function renderInRouter(ui: ReactNode) {
  const router = createRouter({
    history: createMemoryHistory(),
    routeTree: createRootRoute({ component: () => ui }),
  });

  return render(<RouterProvider router={router} />);
}

describe("SessionDraftComposer", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete window.pace;
  });

  it("says there is no branch when the Project is not a repository or its HEAD is detached", async () => {
    const draft = saveSessionDraft("pig-docs", "Draft outside a branch");

    render(
      <DraftComposer
        draft={draft}
        projectGitSummary={{
          projectRoot: "/Users/void/code/opensource/Pig/docs",
          branch: null,
          branches: [],
        }}
      />,
    );

    await screen.findByTestId("session-draft-composer");
    const footer = footerOf("session-draft-composer");

    const placeholder = await within(footer).findByTestId("composer-branch-label");
    expect(placeholder).toHaveTextContent("No branch");
    // A placeholder, not a way to pick a branch that does not exist.
    expect(placeholder.closest("button")).toBeNull();
    expect(
      within(footer).queryByTestId("git-branch-status-trigger"),
    ).not.toBeInTheDocument();
  });

  it("focuses the draft after choosing a suggestion so typing continues at the end", async () => {
    const user = userEvent.setup();
    const draft = saveSessionDraft(pigProjectPath, "");
    render(<DraftComposer draft={draft} />);

    await user.click(await screen.findByRole("button", { name: "Fix the failing test" }));

    const prompt = getPromptInput();
    expect(prompt).toHaveFocus();
    await user.keyboard(" for Friday");
    expect(promptValue(prompt)).toBe("Fix the failing test for Friday");
  });

  it("explains how the two project execution choices affect files", async () => {
    const user = userEvent.setup();
    const draft = saveSessionDraft(pigProjectPath, "");
    render(<DraftComposer draft={draft} />);
    await user.click(await screen.findByTestId("checkout-strategy-trigger"));

    expect(screen.getByText("Edit files directly in the selected project.")).toBeInTheDocument();
    expect(screen.getByText("Create a separate Git worktree for this chat.")).toBeInTheDocument();
  });

  it("associates missing-target validation with the project control", async () => {
    const user = userEvent.setup();
    const draft = saveSessionDraft(null, "Keep my draft after its project is removed");
    render(<DraftComposer draft={draft} />);
    await user.click(await screen.findByRole("button", { name: "Send" }));

    const target = screen.getByRole("combobox", { name: /Project/ });
    expect(target).toHaveAttribute("aria-invalid", "true");
    expect(target).toHaveAccessibleDescription("Choose a project or select No project to continue.");
    expect(screen.queryByTestId("checkout-strategy-trigger")).not.toBeInTheDocument();
  });

  it("restores the last selected model on a new Session Draft", async () => {
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
    const draft = saveSessionDraft(pigProjectPath, "");

    render(<DraftComposer draft={draft} />);

    expect(await screen.findByTestId("model-thinking-trigger")).toHaveTextContent(
      "GPT-5.6 SOL · High",
    );
  });

  it("loads draft models when the first credential arrives and clears them when the last one leaves", async () => {
    let configuredCount = 0;
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_session_projections") return [];
      if (command === "list_provider_auth_status") {
        return { agentDir: "", authPath: "", configuredCount, providers: [] };
      }
      if (command === "list_available_model_controls") {
        return {
          models: [{
            provider: "anthropic",
            modelId: "claude-sonnet-4",
            name: "Claude Sonnet 4",
            thinkingLevels: ["off", "high"],
          }],
          selected: { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "high" },
        };
      }
      if (command === "get_config_inventory") {
        return { skills: [], extensions: [], packages: [], promptTemplates: [] };
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
    const draft = saveSessionDraft(pigProjectPath, "");
    const { queryClient } = renderInRouter(<DraftComposer draft={draft} />);
    expect(await screen.findByTestId("session-draft-no-models-gate")).toBeInTheDocument();

    configuredCount = 1;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: providerAuthStatusQueryKey });
    });
    expect(await screen.findByTestId("model-thinking-trigger")).toHaveTextContent("Claude Sonnet 4");

    configuredCount = 0;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: providerAuthStatusQueryKey });
    });
    expect(await screen.findByTestId("session-draft-no-models-gate")).toBeInTheDocument();
    expect(screen.queryByTestId("model-thinking-trigger")).not.toBeInTheDocument();
  });
});

describe("SessionDraftComposer slash commands", () => {
  it("keeps a command typed out by hand as text and submits it unchanged", async () => {
    const onDraftSubmit = vi.fn();
    const user = userEvent.setup();
    mockPromptCommands({
      source: "static",
      commands: [
        { kind: "prompt", name: "review", invocation: "review", description: "Review something" },
        { kind: "prompt", name: "review-pr", invocation: "review-pr", description: "Review a pull request" },
      ],
    });
    const draft = saveSessionDraft(pigProjectPath, "");
    render(<DraftComposer draft={draft} projects={[pigProject]} onDraftSubmit={onDraftSubmit} />);
    const input = await findPromptInput();

    act(() => input.focus());
    // "/review" is complete once "w" lands, but the user keeps typing —
    // the rehydrate path is for external writes, not in-progress input.
    await user.keyboard("/review-pr hi");

    await waitFor(() => expect(promptValue(input)).toBe("/review-pr hi"));
    expect(input.querySelector("[data-astryx-token]")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onDraftSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "/review-pr hi" }),
    );
  });

  it("rehydrates the leading command once a late catalog resolves", async () => {
    let resolveCatalog!: (catalog: PromptCommandCatalog) => void;
    const gate = new Promise<PromptCommandCatalog>((resolve) => {
      resolveCatalog = resolve;
    });
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_prompt_commands") {
        return gate;
      }
      if (command === "get_config_inventory") {
        return { skills: [], extensions: [], packages: [], promptTemplates: [] };
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
    const draft = saveSessionDraft(pigProjectPath, "/skill:review-pr 参数");
    render(<DraftComposer draft={draft} projects={[pigProject]} />);
    const input = await findPromptInput();

    // The catalog is still in flight — the restored draft stays text.
    expect(promptValue(input)).toBe("/skill:review-pr 参数");
    expect(input.querySelector("[data-astryx-token]")).toBeNull();

    await act(async () => {
      resolveCatalog(promptCatalog);
      await gate;
    });

    await waitFor(() =>
      expect(input.querySelector("[data-astryx-token]")).toHaveAttribute(
        "data-astryx-token-value",
        "/skill:review-pr",
      ),
    );
    expect(promptValue(input)).toBe("/skill:review-pr\u00A0参数");
  });

  it("opens the catalog on '/' and submits the picked skill with a plain space", async () => {
    const onDraftSubmit = vi.fn();
    const user = userEvent.setup();
    mockPromptCommands();
    const draft = saveSessionDraft(pigProjectPath, "");
    render(<DraftComposer draft={draft} projects={[pigProject]} onDraftSubmit={onDraftSubmit} />);
    const input = await findPromptInput();

    typeAtCaret(input, "/");
    const option = await screen.findByRole("option", { name: /review-pr/ });
    await user.click(option);

    await waitFor(() => expect(promptValue(input)).toBe("/skill:review-pr\u00A0"));
    // Continue the prompt after the token's trailing NBSP.
    input.appendChild(document.createTextNode("参数"));
    fireEvent.input(input);
    await waitFor(() => expect(promptValue(input)).toBe("/skill:review-pr\u00A0参数"));

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onDraftSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "/skill:review-pr 参数" }),
    );
  });

  it("does not offer completion for a slash mid-sentence", async () => {
    mockPromptCommands();
    const draft = saveSessionDraft(pigProjectPath, "hello ");
    render(<DraftComposer draft={draft} projects={[pigProject]} />);
    const input = await findPromptInput();
    await waitFor(() => expect(promptValue(input)).toBe("hello "));

    typeAtCaret(input, "/");

    expect(promptValue(input)).toBe("hello /");
    await waitFor(() => {
      expect(screen.queryByRole("option", { name: /review-pr/ })).not.toBeInTheDocument();
    });
  });

  it("inserts a skill token at the start from the + menu and replaces it on the next pick", async () => {
    mockPromptCommands();
    const draft = saveSessionDraft(pigProjectPath, "do the thing");
    render(<DraftComposer draft={draft} projects={[pigProject]} />);
    const input = await findPromptInput();
    await waitFor(() => expect(promptValue(input)).toBe("do the thing"));

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add to prompt" }));
    await user.click(await screen.findByRole("menuitem", { name: "Skills" }));
    await user.click(await screen.findByRole("option", { name: /review-pr/ }));

    await waitFor(() => expect(promptValue(input)).toBe("/skill:review-pr\u00A0do the thing"));

    await user.click(screen.getByRole("button", { name: "Add to prompt" }));
    await user.click(await screen.findByRole("menuitem", { name: "Skills" }));
    await user.click(await screen.findByRole("option", { name: /write-docs/ }));

    await waitFor(() => expect(promptValue(input)).toBe("/skill:write-docs\u00A0do the thing"));
    expect(input.querySelectorAll("[data-astryx-token]")).toHaveLength(1);
  });

  it("blocks a Pi terminal command and keeps the draft", async () => {
    const onDraftSubmit = vi.fn();
    const user = userEvent.setup();
    mockPromptCommands();
    const draft = saveSessionDraft(pigProjectPath, "");
    render(<DraftComposer draft={draft} projects={[pigProject]} onDraftSubmit={onDraftSubmit} />);
    const input = await findPromptInput();

    typeAtCaret(input, "/compact");
    await waitFor(() => expect(promptValue(input)).toBe("/compact"));
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByText(/Pi terminal command/),
    ).toBeInTheDocument();
    expect(onDraftSubmit).not.toHaveBeenCalled();
    expect(promptValue(input)).toBe("/compact");
  });

  it("rehydrates a saved draft's leading command into a token", async () => {
    mockPromptCommands();
    const draft = saveSessionDraft(pigProjectPath, "/skill:review-pr 参数");
    render(<DraftComposer draft={draft} projects={[pigProject]} />);
    const input = await findPromptInput();

    await waitFor(() =>
      expect(input.querySelector("[data-astryx-token]")).toHaveAttribute(
        "data-astryx-token-value",
        "/skill:review-pr",
      ),
    );
    expect(promptValue(input)).toBe("/skill:review-pr\u00A0参数");
  });
});
