import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGitSummary } from "@pace/core";
import { saveLastModelSelection } from "@/entities/session/last-model-preference";
import { saveSessionDraft, type SessionDraft } from "@/entities/session/session-drafts";
import { providerAuthStatusQueryKey } from "@/entities/session/use-provider-auth-status";
import { footerOf } from "@/test/composer-footer";
import { getPromptInput, promptValue } from "@/test/prompt-input";
import { render } from "@/test/render";
import { SessionDraftComposer } from "./session-draft-composer";

const pigProjectPath = "/Users/void/code/opensource/Pig";

// The column owns the draft store; this stands in for it so typing and a
// picked suggestion land back in the composer's `draft` prop.
function DraftComposer({
  draft: initialDraft,
  projectGitSummary = null,
}: {
  draft: SessionDraft;
  projectGitSummary?: ProjectGitSummary | null;
}) {
  const [draft, setDraft] = useState(initialDraft);

  return (
    <SessionDraftComposer
      draft={draft}
      projects={[]}
      creationProjection={null}
      recommendedCheckoutMode="local"
      projectGit={{ summary: projectGitSummary, checkoutBranch: async () => {} }}
      onDraftChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
      onDraftCheckoutModeChange={() => {}}
      onDraftBaseRefChange={() => {}}
      onDraftTargetChange={() => {}}
      onDraftSubmit={() => {}}
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
