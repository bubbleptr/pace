import { CHAT_PROJECT_ID } from "@pace/core";
import { isChatProjectId } from "@/entities/project/chat-workspace";
import type { ProjectRegistryEntry } from "@/entities/project/project-registry";

export type AppLanding =
  | { to: "/trajectory" }
  | {
      to: "/projects/$projectId/sessions";
      params: { projectId: string };
      search: { view: "draft" };
      draftProjectId: string | null;
    };

function isSelectableDraftTarget(
  projectId: string | null,
  projects: Array<Pick<ProjectRegistryEntry, "id">>,
) {
  if (!projectId) {
    return false;
  }

  return isChatProjectId(projectId) || projects.some((project) => project.id === projectId);
}

export function resolveAppLanding(input: {
  projects: Array<Pick<ProjectRegistryEntry, "id">>;
  draft: { projectId: string | null } | null;
}): AppLanding {
  const firstProjectId = input.projects[0]?.id;
  const requestedDraftProjectId = input.draft ? input.draft.projectId : CHAT_PROJECT_ID;
  const draftProjectId = isSelectableDraftTarget(requestedDraftProjectId, input.projects)
    ? requestedDraftProjectId
    : null;
  const routeProjectId = draftProjectId ?? firstProjectId ?? CHAT_PROJECT_ID;

  return {
    to: "/projects/$projectId/sessions",
    params: { projectId: routeProjectId },
    search: { view: "draft" },
    draftProjectId,
  };
}
