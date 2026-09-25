import { useQuery } from "@tanstack/react-query";
import type { PromptCommandCatalog } from "@pace/core";
import { invoke } from "@/shared/runtime";
import { isChatProjectId } from "@/entities/project/chat-workspace";
import type { ProjectRegistryEntry } from "@/entities/project/project-registry";
import { useSessionProjectionsOptional } from "@/entities/session/use-session-projections";

/**
 * Where the command catalog comes from: a live Session (runtime data —
 * extension commands included) or a Project root (static disk resolution —
 * skills and prompt templates only). null disables the query.
 */
export type PromptCommandTarget = { sessionId: string } | { projectRoot: string };

const PROMPT_COMMANDS_STALE_MS = 15_000;

export function usePromptCommands(target: PromptCommandTarget | null) {
  const projections = useSessionProjectionsOptional();
  const sessionProjection =
    target && "sessionId" in target
      ? projections?.sessionProjections.find(
          (projection) => projection.id === target.sessionId,
        )
      : null;
  // A cold Session already carries piSessionId, so binding alone never
  // changes the key. Status flips to "running" when a run starts — the
  // moment the runtime is guaranteed live — and keying on it refetches the
  // catalog, picking up runtime-only extension commands without a remount.
  // The RPC is cheap, so a refetch on every status transition is fine.
  const piSessionId = sessionProjection?.piSessionId ?? null;
  const status = sessionProjection?.status ?? null;

  return useQuery({
    queryKey:
      target === null
        ? ["prompt-commands", "off"]
        : "sessionId" in target
          ? ["prompt-commands", "session", target.sessionId, piSessionId, status]
          : ["prompt-commands", "root", target.projectRoot],
    queryFn: () =>
      invoke<PromptCommandCatalog>("list_prompt_commands", target ?? {}),
    enabled: target !== null,
    staleTime: PROMPT_COMMANDS_STALE_MS,
  });
}

/**
 * The static-catalog target for the Session Draft: the picked Project's
 * root, or the Chat workspace root for the "No project" target (chat
 * sessions run under <dataDir>/chats, so that root is the honest base for
 * skill/prompt discovery). Returns null while no root is resolvable.
 */
export function useDraftPromptCommandTarget(
  projectId: string | null,
  projects: readonly ProjectRegistryEntry[],
): PromptCommandTarget | null {
  const chatTarget = isChatProjectId(projectId);
  const chatRoot = useQuery({
    queryKey: ["chat-workspace-root"],
    queryFn: () => invoke<{ path: string }>("get_chat_workspace_root"),
    enabled: chatTarget,
    staleTime: Infinity,
  });

  if (!projectId) {
    return null;
  }
  if (chatTarget) {
    return chatRoot.data ? { projectRoot: chatRoot.data.path } : null;
  }
  const projectRoot = projects.find((project) => project.id === projectId)?.path;
  return projectRoot ? { projectRoot } : null;
}
