import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import {
  Outlet,
  RouterProvider,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { AppLandingPage } from "@/pages/app-landing";
import { AgentWorkspaceSessionsPage } from "@/pages/agent-workspace";
import { PreflightPage, preflightStatusQueryKey } from "@/pages/preflight";
import { SettingsDialog } from "@/pages/settings";
import { SetupPage } from "@/pages/setup";
import { TrajectoryIndexPage, TrajectorySessionPage } from "@/pages/trajectory";
import { UsagePage } from "@/pages/usage";
import type { EnvironmentPreflightStatus } from "@pace/core";
import { SessionProjectionsProvider } from "@/entities/session/use-session-projections";
import { startModelCatalogInvalidationBridge } from "@/entities/model/model-catalog-cache";
import { invoke, isElectronRuntime, onNavigateRequest } from "@/shared/runtime";
import { Theme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
// Astryx CSS is @imported inside styles.css (after tailwindcss) so its
// cascade layers outrank Tailwind preflight.
import "./styles.css";

const queryClient = new QueryClient();
startModelCatalogInvalidationBridge({ queryClient });

function isPreflightExemptPath(pathname: string) {
  // Preflight itself, plus Provider Settings so "Configure providers →" can
  // leave the gate without bouncing straight back (S3 E2E / DF-002).
  return (
    pathname === "/preflight" ||
    pathname === "/design" ||
    pathname === "/settings" ||
    pathname.startsWith("/settings/")
  );
}

function PreflightGate({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const pathname = useRouterState({
    // Location changes before Outlet commits the new match. Releasing the old
    // landing page during that gap lets its redirect cancel the preflight route.
    select: (state) =>
      state.matches[state.matches.length - 1]?.pathname ?? state.location.pathname,
  });
  const onExemptRoute = isPreflightExemptPath(pathname);
  const statusQuery = useQuery({
    queryKey: preflightStatusQueryKey,
    queryFn: () => invoke<EnvironmentPreflightStatus>("get_environment_preflight_status"),
  });

  useEffect(() => {
    if (statusQuery.isLoading || statusQuery.isFetching) {
      return;
    }

    if (statusQuery.isError || !statusQuery.data) {
      return;
    }

    if (!statusQuery.data.completedAt && !onExemptRoute) {
      void navigate({ to: "/preflight", search: true, replace: true });
    }
  }, [
    navigate,
    onExemptRoute,
    statusQuery.data,
    statusQuery.isError,
    statusQuery.isFetching,
    statusQuery.isLoading,
  ]);

  if (statusQuery.isLoading || (statusQuery.isFetching && !statusQuery.data)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6 text-sm text-muted">
        Checking environment readiness…
      </main>
    );
  }

  if (statusQuery.isError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6 text-sm text-danger">
        Could not load environment preflight status:{" "}
        {statusQuery.error instanceof Error
          ? statusQuery.error.message
          : String(statusQuery.error)}
      </main>
    );
  }

  if (!statusQuery.data?.completedAt && !onExemptRoute) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6 text-sm text-muted">
        Opening environment check…
      </main>
    );
  }

  return children;
}

const rootRoute = createRootRoute({
  component: () => (
    <>
      <PreflightGate>
        <Outlet />
      </PreflightGate>
      <SettingsDialog />
    </>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: AppLandingPage,
});

const trajectoryIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trajectory",
  component: TrajectoryIndexPage,
});

const legacyTraceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trace",
  beforeLoad: () => {
    // Existing bookmarks survive the Trace → Trajectory rename (ADR-0032 §3).
    throw redirect({ to: "/trajectory", replace: true });
  },
});

const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId",
  component: TrajectorySessionPage,
});

const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/usage",
  component: UsagePage,
});

const projectSessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/sessions",
  component: AgentWorkspaceSessionsPage,
});

const packagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/packages",
  component: SetupPage,
});

const legacySetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  beforeLoad: () => {
    // The inventory page was only reachable by URL as /setup; keep those links alive.
    throw redirect({ to: "/packages", replace: true });
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: ({ location }) => {
    // Existing bookmarks still open the matching settings panel.
    throw redirect({
      to: "/trajectory",
      search: {
        settings: location.hash === "models" ? "models" : "providers",
      } as never,
      replace: true,
    });
  },
});

const preflightRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/preflight",
  component: PreflightPage,
});

// Dev-only design gallery. Both the createRoute() call and the page import
// must live inside the DEV branch: a top-level createRoute() is not provably
// pure, and a static import would keep the page in the production bundle
// even with the route unregistered.
function DevRouteError({ error }: { error: Error }) {
  return (
    <pre
      data-testid="route-error"
      style={{
        margin: 0,
        padding: 16,
        color: "crimson",
        whiteSpace: "pre-wrap",
        fontSize: 12,
      }}
    >
      {error.stack ?? error.message}
    </pre>
  );
}

const devOnlyRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/design",
        wrapInSuspense: true,
        errorComponent: DevRouteError,
        component: React.lazy(async () => ({
          default: (await import("@/pages/design")).DesignPage,
        })),
      }),
    ]
  : [];

// Dev-only UI intent picker (floating crosshair button / Cmd+Ctrl+Shift+X).
// Same DEV-gated lazy pattern as the design route: the module never lands in
// production bundles.
const DevUiIntentPicker = import.meta.env.DEV
  ? React.lazy(async () => ({
      default: (await import("@/dev/ui-intent/ui-intent-picker")).UiIntentPicker,
    }))
  : null;

const router = createRouter({
  ...(isElectronRuntime() ? { history: createHashHistory() } : {}),
  ...(import.meta.env.DEV
    ? {
        defaultErrorComponent: DevRouteError,
        defaultOnCatch: (error: Error) => {
          console.error("[router]", error);
        },
      }
    : {}),
  routeTree: rootRoute.addChildren([
    indexRoute,
    trajectoryIndexRoute,
    legacyTraceRoute,
    sessionDetailRoute,
    usageRoute,
    projectSessionsRoute,
    packagesRoute,
    legacySetupRoute,
    settingsRoute,
    preflightRoute,
    ...devOnlyRoutes,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

onNavigateRequest(({ to, search }) => {
  void router.navigate({
    to,
    search: ((previous: Record<string, unknown>) => ({ ...previous, ...search })) as never,
    hash: true,
    replace: true,
    resetScroll: false,
  } as never);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Theme theme={neutralTheme}>
      <QueryClientProvider client={queryClient}>
        <SessionProjectionsProvider>
          <RouterProvider router={router} />
          {DevUiIntentPicker ? (
            <React.Suspense fallback={null}>
              <DevUiIntentPicker />
            </React.Suspense>
          ) : null}
        </SessionProjectionsProvider>
      </QueryClientProvider>
    </Theme>
  </React.StrictMode>,
);
