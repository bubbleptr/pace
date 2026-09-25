import { useCallback, useMemo, useRef, useState } from "react";
import type { RuntimePromptImage, WorkspaceFileMatch } from "@pace/core";
import type { ChatComposerTrigger } from "@astryxdesign/core/Chat";
import {
  ChatPromptInput as PromptInput,
  type ChatPromptInputHandle,
} from "@/shared/ui/chat/chat-prompt-input";
import { ChatPromptSuggestion as PromptSuggestion } from "@/shared/ui/chat/chat-prompt-suggestion";
import { TextShimmer } from "@/shared/ui/chat/text-shimmer";
import { ContextUsageMeter } from "@/shared/ui/context-usage-meter";
import { ModelSelectorControl } from "@/entities/model/model-selector/model-selector-control";
import {
  ComposerAttachmentDrawer,
  ComposerInsertMenu,
  buildPromptWithAttachments,
  useComposerAttachments,
  useFilePicker,
} from "@/shared/ui/composer-attachments";
import {
  INSERT_CATALOG_KIND,
  commandToken,
  insertCatalogs,
  leadingCommandMatch,
  slashTrigger,
  slashTriggerActive,
  useDraftPromptCommandTarget,
  usePromptCommands,
  validateCommandSubmit,
} from "@/entities/prompt-command";
import {
  FILE_INSERT_CATALOG_ID,
  atTrigger,
  fileInsertCatalog,
  fileSearchItem,
  fileToken,
  useWorkspaceFileSearch,
} from "@/entities/workspace-file";
import {
  ChatAdd,
  FileDiff,
  FolderClosed,
  GitBranch,
  ListTree,
  SquareTerminal,
  Wrench,
} from "@/shared/ui/icons";
import { CheckoutStrategyPicker } from "@/entities/checkout/checkout-strategy-picker";
import {
  ComposerLocationRow,
  ComposerStaticChip,
} from "@/entities/checkout/composer-location-row";
import { GitBranchPicker } from "@/entities/checkout/git-branch-picker";
import { useVisibleModels } from "@/entities/model/visible-models";
import { useModelCatalog } from "@/entities/model/use-model-catalog";
import {
  CHAT_WORKSPACE_DISPLAY_NAME,
  isChatProjectId,
} from "@/entities/project/chat-workspace";
import { type ProjectGitView } from "@/entities/project/project-git";
import { type ProjectRegistryEntry } from "@/entities/project/project-registry";
import { type RuntimeModelSelection } from "@/entities/runtime/pi-runtime-bridge";
import {
  getLastModelSelection,
  mostRecentSessionModelSelection,
  overlayPreferredModel,
  saveLastModelSelection,
} from "@/entities/session/last-model-preference";
import { NoProvidersEmptyState } from "@/entities/session/no-providers-empty-state";
import {
  type SessionDraft,
  type SessionDraftCheckoutMode,
} from "@/entities/session/session-drafts";
import { type SessionProjection } from "@/entities/session/session-projection";
import { useSessionProjectionsOptional } from "@/entities/session/use-session-projections";
import { useProviderAuthStatus } from "@/entities/session/use-provider-auth-status";
import { ProjectPicker } from "./project-picker";
import { SessionCreationFailureDetail } from "./session-creation-failure-detail";

export type SessionDraftSubmitEvent = {
  projectId: string;
  prompt: string;
  checkoutMode: SessionDraftCheckoutMode;
  /** Branch a Git worktree starts from; absent means the Project's HEAD. */
  baseRef?: string;
  modelSelection?: RuntimeModelSelection;
  images?: RuntimePromptImage[];
};

// Pace is a coding-agent workbench, so the empty-state suggestions are
// coding tasks (not the generic "design a launch page" copy this template
// started from) - they're what a README screenshot or a first-time user
// should see as representative prompts.
const SESSION_DRAFT_SUGGESTED_PROMPTS = [
  {
    Icon: ListTree,
    id: "explain-architecture",
    label: "Explain this repo's architecture",
    prompt: "Explain this repo's architecture",
  },
  {
    Icon: Wrench,
    id: "fix-failing-test",
    label: "Fix the failing test",
    prompt: "Fix the failing test",
  },
  {
    Icon: SquareTerminal,
    id: "add-cli-flag",
    label: "Add a CLI flag with docs",
    prompt: "Add a CLI flag with docs",
  },
  {
    Icon: FileDiff,
    id: "review-uncommitted-changes",
    label: "Review my uncommitted changes",
    prompt: "Review my uncommitted changes",
  },
] as const;

/**
 * Title and suggestion grid of the Session Draft. Both are shared with the
 * handoff echo below, which replays them on their way out, so the copy and
 * spacing can only ever be stated once.
 */
function SessionDraftHero() {
  return (
    <div className="pigui-draft-handoff__hero flex flex-col items-center gap-2 text-center">
      <h2 className="text-center text-3xl font-normal tracking-tight text-foreground">
        Build something useful with{" "}
        <TextShimmer tone="brand">Pace</TextShimmer>
      </h2>
    </div>
  );
}

function SessionDraftSuggestions({
  onSelect,
}: {
  onSelect?: (prompt: string) => void;
}) {
  return (
    <PromptSuggestion className="pigui-draft-handoff__suggestions w-full max-w-[35rem]">
      <PromptSuggestion.Items className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {SESSION_DRAFT_SUGGESTED_PROMPTS.map(({ Icon, id, label, prompt }) => (
          <PromptSuggestion.Item
            key={id}
            className="items-center justify-start"
            showEndIcon={false}
            onPress={() => onSelect?.(prompt)}
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <Icon
                aria-hidden="true"
                className="size-4 shrink-0"
                data-testid="session-draft-suggestion-icon"
              />
              <span className="truncate">{label}</span>
            </span>
          </PromptSuggestion.Item>
        ))}
      </PromptSuggestion.Items>
    </PromptSuggestion>
  );
}

/**
 * What the Session Draft leaves behind for the length of the handoff: the
 * title and the suggestion grid drift up and fade while the Live composer
 * settles into the space the draft composer held (the spacer keeps that
 * space, so nothing below the title moves). Inert and hidden from assistive
 * tech — the interactive Draft is already gone.
 */
export function SessionDraftExitEcho({
  composerHeight,
  projectLabel,
  isChatTarget,
}: {
  composerHeight: number;
  projectLabel: string | null;
  isChatTarget: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className="pigui-draft-handoff__exit flex h-full min-h-0 flex-col items-center justify-center px-6 py-8"
      inert
    >
      <div className="flex w-full max-w-[44rem] flex-col items-center justify-center gap-6">
        <SessionDraftHero />
        <div className="pigui-draft-handoff__target flex w-full justify-center">
          {projectLabel ? (
            <ComposerStaticChip
              chrome="selector"
              icon={isChatTarget ? ChatAdd : FolderClosed}
              label={projectLabel}
              testId="session-draft-echo-target"
            />
          ) : null}
        </div>
        <div className="w-full" style={{ height: `${composerHeight}px` }} />
        <SessionDraftSuggestions />
      </div>
    </div>
  );
}

export function SessionDraftComposer({
  draft,
  projects,
  creationProjection,
  recommendedCheckoutMode,
  projectGit,
  onDraftChange,
  onDraftCheckoutModeChange,
  onDraftBaseRefChange,
  onDraftTargetChange,
  onDraftSubmit,
  onManageModels,
}: {
  draft: SessionDraft;
  projects: ProjectRegistryEntry[];
  creationProjection: SessionProjection | null;
  recommendedCheckoutMode: SessionDraftCheckoutMode;
  /** Branch state of the target Project; empty for the Chat workspace. */
  projectGit: ProjectGitView;
  onDraftChange: (prompt: string) => void;
  onDraftCheckoutModeChange: (checkoutMode: SessionDraftCheckoutMode) => void;
  onDraftBaseRefChange: (baseRef: string) => void;
  onDraftTargetChange: (projectId: string | null) => void;
  onDraftSubmit: (event: SessionDraftSubmitEvent) => void;
  onManageModels?: () => void;
}) {
  const [targetValidationRequested, setTargetValidationRequested] = useState(false);
  const targetError = targetValidationRequested && !draft.projectId;
  const draftInputRef = useRef<ChatPromptInputHandle | null>(null);
  const visibleModels = useVisibleModels();
  const selectedCheckoutMode = draft.checkoutMode ?? recommendedCheckoutMode;
  const projectBranch = projectGit.summary?.branch ?? null;
  const projectBranches = projectGit.summary?.branches ?? [];
  // A pick the Project no longer lists (branch deleted since the draft was
  // saved) is dropped rather than failing Session Creation. Before Git has
  // answered there is no list to check, so the pick stands and the backend
  // rejects it if it is gone — never a silent fall back to HEAD.
  const chosenBaseRef =
    selectedCheckoutMode === "worktree" &&
    draft.baseRef &&
    (!projectGit.summary || projectBranches.includes(draft.baseRef))
      ? draft.baseRef
      : undefined;
  const { loading: providerAuthLoading, configured: providersConfigured } =
    useProviderAuthStatus();
  const modelCatalog = useModelCatalog();
  // Re-renders on a pick; the pick is also the stored last selection.
  const [pickedModel, setPickedModel] = useState<RuntimeModelSelection | null>(null);
  const sessionProjectionsStore = useSessionProjectionsOptional();
  const recentSessionModel = mostRecentSessionModelSelection(
    sessionProjectionsStore?.sessionProjections ?? [],
  );
  const recentSessionModelKey = recentSessionModel
    ? `${recentSessionModel.provider}:${recentSessionModel.modelId}:${recentSessionModel.thinkingLevel}`
    : "";
  const attachments = useComposerAttachments();
  const picker = useFilePicker(attachments.addFiles);
  // The Draft has no live runtime: the catalog resolves statically from the
  // picked Project's root (or the Chat workspace root), so extension
  // commands can only appear once the Session exists.
  const commandTarget = useDraftPromptCommandTarget(draft.projectId, projects);
  const commandQuery = usePromptCommands(commandTarget);
  const commands = useMemo(
    () => commandQuery.data?.commands ?? [],
    [commandQuery.data],
  );
  // A draft never queues — the Session starts idle — so extension commands
  // stay listed here; the Live composer applies its own queueMode filter.
  const slashActive = slashTriggerActive(draft.prompt);
  const trigger = useMemo(
    () => slashTrigger(commands, { active: slashActive, queueMode: false }),
    [commands, slashActive],
  );
  // "@" file references search the same target the static command catalog
  // resolves from — except the Chat workspace, which has no project files.
  const fileSearch = useWorkspaceFileSearch(
    isChatProjectId(draft.projectId) ? null : commandTarget,
  );
  const fileTrigger = useMemo(
    () => (fileSearch ? atTrigger(fileSearch) : null),
    [fileSearch],
  );
  const inputTriggers = useMemo(
    () =>
      [trigger, fileTrigger].filter(
        (entry): entry is ChatComposerTrigger => entry !== null,
      ),
    [trigger, fileTrigger],
  );
  const leadingTokenFor = useCallback(
    (value: string) => leadingCommandMatch(value, commands),
    [commands],
  );
  // Palette picks come back as row ids (paths); the matches behind the last
  // search are what onPick maps back to WorkspaceFileMatch.
  const lastFileMatchesRef = useRef<readonly WorkspaceFileMatch[]>([]);
  const fileSearchVersionRef = useRef(0);
  const fileCatalogSearch = useMemo(() => {
    if (!fileSearch) {
      return null;
    }
    return async (query: string) => {
      const version = ++fileSearchVersionRef.current;
      const matches = await fileSearch(query);
      // Match the palette's latest-query guard so picks use its visible rows.
      if (version === fileSearchVersionRef.current) {
        lastFileMatchesRef.current = matches;
      }
      return matches.map(fileSearchItem);
    };
  }, [fileSearch]);

  const draftCatalog =
    providerAuthLoading || !providersConfigured ? null : modelCatalog.catalog;
  // Unfiltered like the Live fallback: the preferred model may be one the user
  // hid, and the selector marks it rather than dropping it.
  const draftModelControls = useMemo(
    () => draftCatalog && overlayPreferredModel(draftCatalog, [
      pickedModel,
      getLastModelSelection(),
      recentSessionModel,
    ]),
    // recentSessionModel is a fresh object per render; its key is the identity.
    [draftCatalog, pickedModel, recentSessionModelKey],
  );

  const switchProjectBranch = async (branch: string) => {
    try {
      await projectGit.checkoutBranch(branch);
      attachments.setError(null);
    } catch (error) {
      attachments.setError(
        error instanceof Error ? error.message : "Git could not switch branch.",
      );
    }
  };
  const applySuggestedPrompt = (prompt: string) => {
    onDraftChange(prompt);
    draftInputRef.current?.focusAtEnd();
  };
  const submitDraft = async () => {
    if (!providerAuthLoading && !providersConfigured) {
      return;
    }

    if (!draft.projectId) {
      setTargetValidationRequested(true);
      return;
    }

    const commandError = validateCommandSubmit(draft.prompt, {
      commands,
      queueMode: false,
    });
    if (commandError) {
      attachments.setError(commandError);
      return;
    }

    const built = await buildPromptWithAttachments(
      draft.prompt,
      attachments.items,
    );

    if (!built.ok) {
      attachments.setError(built.error);
      return;
    }

    // The Live composer reads this back while the Session is being created,
    // so the model chip does not blank out during the handoff.
    if (draftModelControls?.selected) {
      saveLastModelSelection(draftModelControls.selected);
    }

    onDraftSubmit({
      projectId: draft.projectId,
      prompt: built.prompt,
      checkoutMode: selectedCheckoutMode,
      ...(chosenBaseRef ? { baseRef: chosenBaseRef } : {}),
      ...(built.images.length ? { images: built.images } : {}),
      ...(draftModelControls?.selected
        ? { modelSelection: draftModelControls.selected }
        : {}),
    });
    attachments.clear();
  };

  const chatTarget = isChatProjectId(draft.projectId);
  // The Location row the Live composer will keep: where this Session runs,
  // which branch it starts from, and the context ring waiting to be filled.
  const draftLocationRow = (
    <ComposerLocationRow
      location={
        !draft.projectId ? undefined : chatTarget ? (
          <ComposerStaticChip
            chrome="selector"
            icon={ChatAdd}
            label={CHAT_WORKSPACE_DISPLAY_NAME}
            testId="composer-location-label"
          />
        ) : (
          <CheckoutStrategyPicker
            selectedCheckoutMode={selectedCheckoutMode}
            onCheckoutModeChange={onDraftCheckoutModeChange}
          />
        )
      }
      branch={
        chatTarget || !projectGit.summary ? undefined : !projectBranch ? (
          // Git answered with no branch — not a repository, or a detached
          // HEAD. Say so quietly rather than leave the slot looking unloaded.
          <ComposerStaticChip
            chrome="button"
            icon={GitBranch}
            label="No branch"
            testId="composer-branch-label"
          />
        ) : selectedCheckoutMode === "worktree" ? (
          // A worktree is cut from the chosen base rather than moving the
          // Project folder onto it, so picking only records it on the draft.
          <GitBranchPicker
            branch={chosenBaseRef ?? projectBranch}
            branches={projectBranches}
            occupiedBranches={[]}
            triggerLabel={`from ${chosenBaseRef ?? projectBranch}`}
            onBranchChange={onDraftBaseRefChange}
          />
        ) : (
          <GitBranchPicker
            branch={projectBranch}
            branches={projectBranches}
            occupiedBranches={[]}
            onBranchChange={(next) => void switchProjectBranch(next)}
          />
        )
      }
      meter={<ContextUsageMeter usage={null} />}
    />
  );

  if (!providerAuthLoading && !providersConfigured) {
    return (
      <section
        className="flex h-full min-h-0 flex-col items-center justify-center px-6 py-8"
        data-testid="session-draft-composer"
      >
        <NoProvidersEmptyState testId="session-draft-no-models-gate" />
      </section>
    );
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col items-center justify-center px-6 py-8"
      data-testid="session-draft-composer"
    >
      <div
        className="flex w-full max-w-[44rem] flex-col items-center justify-center gap-6"
        data-testid="session-draft-empty-state"
      >
        <SessionDraftHero />
        {/* Draft-only, so it sits above the composer and leaves with the
            title; everything that outlives the draft is in the composer or
            its Location row. */}
        <div
          className="pigui-draft-handoff__target flex w-full flex-wrap justify-center gap-2"
          data-testid="session-draft-project-picker"
        >
          <ProjectPicker
            error={targetError}
            projects={projects}
            selectedProjectId={draft.projectId}
            onProjectChange={(projectId) => {
              onDraftTargetChange(projectId);
            }}
          />
        </div>
        <div className="flex w-full flex-col gap-3">
          <PromptInput
            accent="brand"
            accentFocusRing
            className="w-full"
            drawer={
              <ComposerAttachmentDrawer
                items={attachments.items}
                onRemove={attachments.remove}
              />
            }
            error={attachments.error}
            footer={draftLocationRow}
            hasAttachments={attachments.items.length > 0}
            inputRef={draftInputRef}
            leadingTokenFor={leadingTokenFor}
            placeholder="Do anything with Pi"
            startActions={
              <>
                {picker.input}
                <ComposerInsertMenu
                  catalogs={[
                    ...insertCatalogs(commands, { queueMode: false }),
                    ...(fileCatalogSearch
                      ? [fileInsertCatalog(fileCatalogSearch)]
                      : []),
                  ]}
                  onAttach={picker.open}
                  onPick={(catalogId, itemId) => {
                    if (catalogId === FILE_INSERT_CATALOG_ID) {
                      const match = lastFileMatchesRef.current.find(
                        (entry) => entry.path === itemId,
                      );
                      if (match) {
                        draftInputRef.current?.appendToken(fileToken(match));
                      }
                      return;
                    }
                    const kind = INSERT_CATALOG_KIND[catalogId];
                    const command = commands.find(
                      (entry) => entry.kind === kind && entry.invocation === itemId,
                    );
                    if (command) {
                      draftInputRef.current?.insertLeadingToken(commandToken(command));
                    }
                  }}
                />
                {draftModelControls?.selected ? (
                  <ModelSelectorControl
                    controls={draftModelControls}
                    isDisabled={false}
                    visibleModels={visibleModels}
                    onManageModels={onManageModels}
                    onChange={(selection) => {
                      saveLastModelSelection(selection);
                      setPickedModel(selection);
                    }}
                  />
                ) : null}
              </>
            }
            triggers={inputTriggers}
            value={draft.prompt}
            onFiles={attachments.addFiles}
            onSubmit={submitDraft}
            onValueChange={onDraftChange}
          />
          {creationProjection ? (
            <div
              aria-live="polite"
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
              data-testid="session-creation-status"
            >
              {creationProjection.failure ? (
                <SessionCreationFailureDetail failure={creationProjection.failure} />
              ) : (
                <p className="font-medium text-foreground">
                  {creationProjection.creationStage}
                </p>
              )}
            </div>
          ) : null}
        </div>
        <SessionDraftSuggestions onSelect={applySuggestedPrompt} />
      </div>
    </section>
  );
}
