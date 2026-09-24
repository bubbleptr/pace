import { beforeEach, describe, expect, it } from "vitest";
import { resolveAppLanding } from "@/pages/app-landing-route";

const pigProjectId = "/Users/void/code/opensource/Pig";
const studyProjectId = "/Users/void/Documents/study";

describe("resolveAppLanding", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("opens a Chat draft when the Project Registry is empty", () => {
    expect(
      resolveAppLanding({
        projects: [],
        draft: null,
      }),
    ).toEqual({
      to: "/projects/$projectId/sessions",
      params: { projectId: "chat" },
      search: { view: "draft" },
      draftProjectId: "chat",
    });
  });

  it("keeps an existing Chat draft target when Projects are registered", () => {
    expect(
      resolveAppLanding({
        projects: [{ id: pigProjectId }],
        draft: { projectId: "chat" },
      }),
    ).toEqual({
      to: "/projects/$projectId/sessions",
      params: { projectId: "chat" },
      search: { view: "draft" },
      draftProjectId: "chat",
    });
  });

  it("opens a new Chat without a project even when Projects are registered", () => {
    expect(
      resolveAppLanding({
        projects: [{ id: pigProjectId }, { id: studyProjectId }],
        draft: null,
      }),
    ).toEqual({
      to: "/projects/$projectId/sessions",
      params: { projectId: "chat" },
      search: { view: "draft" },
      draftProjectId: "chat",
    });
  });

  it("keeps a missing draft target unresolved when the last Project was removed", () => {
    expect(resolveAppLanding({ projects: [], draft: { projectId: studyProjectId } }))
      .toMatchObject({ params: { projectId: "chat" }, draftProjectId: null });
    expect(resolveAppLanding({ projects: [], draft: { projectId: null } }))
      .toMatchObject({ params: { projectId: "chat" }, draftProjectId: null });
  });

  it("keeps an existing draft target when that Project is still registered", () => {
    expect(
      resolveAppLanding({
        projects: [{ id: pigProjectId }, { id: studyProjectId }],
        draft: { projectId: studyProjectId },
      }),
    ).toEqual({
      to: "/projects/$projectId/sessions",
      params: { projectId: studyProjectId },
      search: { view: "draft" },
      draftProjectId: studyProjectId,
    });
  });

  it("routes through the first Project and drops a missing draft target", () => {
    expect(
      resolveAppLanding({
        projects: [{ id: pigProjectId }],
        draft: { projectId: studyProjectId },
      }),
    ).toEqual({
      to: "/projects/$projectId/sessions",
      params: { projectId: pigProjectId },
      search: { view: "draft" },
      draftProjectId: null,
    });
  });
});
