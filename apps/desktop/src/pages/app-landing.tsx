import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { resolveAppLanding } from "@/pages/app-landing-route";
import { getVisibleProjectRegistry } from "@/entities/project/visible-registry";
import { ensureSessionDraft, getSessionDraft } from "@/entities/session/session-drafts";

export function AppLandingPage() {
  const navigate = useNavigate();

  useEffect(() => {
    const landing = resolveAppLanding({
      projects: getVisibleProjectRegistry(),
      draft: getSessionDraft(),
    });

    if (landing.to === "/trajectory") {
      void navigate({ to: "/trajectory", replace: true });
      return;
    }

    ensureSessionDraft(landing.draftProjectId);
    void navigate({
      to: `/projects/${encodeURIComponent(landing.params.projectId)}/sessions` as never,
      search: landing.search as never,
      replace: true,
    });
  }, [navigate]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-sm text-muted">
      Opening New Session…
    </main>
  );
}
