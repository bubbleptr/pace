import { Button } from "@astryxdesign/core/Button";
import { Collapsible, CollapsibleGroup } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SessionChangedFile, SessionChanges } from "@pace/core";
import { type SessionChangeTarget } from "@/entities/session/session-change-link";
import { SessionSurfaceBar } from "@/shared/ui/session-dock/surface-bar";
import { FileDiff, RefreshCw } from "@/shared/ui/icons";

type SessionChangesPanelProps = {
  sessionId: string | null;
  target?: SessionChangeTarget | null;
  stale: boolean;
  /** The page owns the read so the rail badge can share it (ADR-0028). */
  changes: SessionChanges | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
};

const SessionDiffViewer = lazy(
  () => import("@/entities/session/session-diff-viewer"),
);

function changeKindLabel(kind: SessionChangedFile["kind"]) {
  switch (kind) {
    case "type-changed":
      return "Type changed";
    case "conflicted":
      return "Conflict";
    default:
      return `${kind[0]?.toUpperCase()}${kind.slice(1)}`;
  }
}

function changeStageLabel(file: SessionChangedFile) {
  if (file.kind === "untracked") return "Working tree";
  if (file.staged && file.unstaged) return "Staged + unstaged";
  if (file.staged) return "Staged";
  return "Working tree";
}

/**
 * One line of working-tree state for the Changes bar, or nothing when there is
 * none to state. A failed read says nothing here: the alert below already
 * carries the message, and a stale count beside it would contradict it.
 */
function sessionChangesStatus({
  changes,
  error,
  loading,
}: Pick<SessionChangesPanelProps, "changes" | "error" | "loading">): ReactNode {
  if (error) {
    return null;
  }

  if (!changes) {
    return loading ? "Loading…" : null;
  }

  if (changes.state === "non-git") {
    return "Not a Git repository";
  }

  // Same predicate the file list below uses, so the row and the list can never
  // disagree about whether there is anything to review.
  if (changes.state === "clean" || changes.files.length === 0) {
    return "Working tree clean";
  }

  return (
    <>
      {changes.totals.files} files ·{" "}
      <span className="text-success">+{changes.totals.additions}</span>{" "}
      <span className="text-danger">-{changes.totals.deletions}</span>
    </>
  );
}

export function SessionChangesPanel({
  sessionId,
  target,
  stale,
  changes,
  error,
  loading,
  onRefresh,
}: SessionChangesPanelProps) {
  // Fold state is the set of *closed* paths: a file the reviewer has not
  // touched is open, so a fresh read (new files included) needs no
  // bookkeeping to come up expanded, and only explicit folds are remembered.
  const [closedPaths, setClosedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLDivElement>());

  // Another Session is another review; its folds start from scratch.
  useEffect(() => {
    setClosedPaths(new Set());
    setCurrentPath(null);
  }, [sessionId]);

  // Each read yields a new object; keep folds for files that survived and let
  // the rest go so a path that comes back later is open again.
  useEffect(() => {
    if (!changes) return;

    const present = new Set(changes.files.map((file) => file.path));
    setClosedPaths((current) => {
      const next = new Set([...current].filter((path) => present.has(path)));
      return next.size === current.size ? current : next;
    });
    setCurrentPath((current) =>
      current !== null && present.has(current) ? current : null,
    );
  }, [changes]);

  const files = changes?.files ?? [];
  const openPaths = files
    .map((file) => file.path)
    .filter((path) => !closedPaths.has(path));
  const anyOpen = openPaths.length > 0;

  const toggleAll = () => {
    setClosedPaths(anyOpen ? new Set(files.map((file) => file.path)) : new Set());
  };

  const navigateTo = useCallback((path: string) => {
    setClosedPaths((current) => {
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    setCurrentPath(path);
    // The section root stays mounted while folded, so it can be scrolled to
    // before React has re-rendered the expanded body. jsdom has no
    // scrollIntoView, hence the optional call.
    const section = sectionRefs.current.get(path);
    section?.scrollIntoView?.({ block: "start" });
    // Continue keyboard navigation from the diff after an outline jump.
    section?.querySelector("button")?.focus({ preventScroll: true });
  }, []);

  const status = sessionChangesStatus({ changes, error, loading });
  const hasReview =
    Boolean(sessionId) &&
    !error &&
    changes?.state === "ready" &&
    files.length > 0;

  useEffect(() => {
    if (hasReview && target?.sessionId === sessionId) navigateTo(target.path);
  }, [hasReview, target, sessionId, navigateTo]);

  return (
    <section aria-label="Session changes" className="flex h-full min-h-0 flex-col">
      {/* The surface's first row (ADR-0028): working-tree state on the left,
          actions on the right — the slot Session-scoped checkout / commit /
          push actions (ADR-0008) will land in. A Session without a checkout
          has neither, so it gets no band at all. */}
      {sessionId ? (
        <SessionSurfaceBar
          actions={
            <>
              {hasReview ? (
                <>
                  <Button
                    className="pigui-pressable"
                    label={anyOpen ? "Collapse all" : "Expand all"}
                    size="sm"
                    variant="ghost"
                    onClick={toggleAll}
                  />
                </>
              ) : null}
              <IconButton
                className="pigui-pressable"
                icon={<RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />}
                isDisabled={loading}
                label="Refresh Session changes"
                size="sm"
                tooltip="Refresh changes"
                variant="ghost"
                onClick={onRefresh}
              />
            </>
          }
        >
          {status ? (
            <p className="min-w-0 truncate text-xs text-muted">{status}</p>
          ) : null}
        </SessionSurfaceBar>
      ) : null}

      {/* Keep scrolling and size containment below the window's header band.
          The bar must stay in the root stacking context above its drag region. */}
      <div className="@container/changes flex min-h-0 flex-1 flex-col overflow-hidden">
        {stale ? (
          <p className="mt-3 bg-warning/5 px-3 py-2 text-sm text-foreground">
            Runtime state is stale. This diff is fresh, but the Session status may be outdated.
          </p>
        ) : null}

        {!sessionId ? (
          <EmptyState
            className="flex-1 justify-center px-4"
            title="No changes to review"
            description="Start a session in a project to review its file changes here."
            icon={<FileDiff className="size-5 text-muted" />}
            isCompact
          />
        ) : loading && !changes ? (
          <div className="mt-3 grid gap-2" aria-label="Loading Session changes">
            <div className="h-8 animate-pulse motion-reduce:animate-none bg-default/40" />
            <div className="h-24 animate-pulse motion-reduce:animate-none bg-default/30" />
          </div>
        ) : error ? (
          <div
            className="mt-3 bg-danger/5 px-3 py-3"
            role="alert"
          >
            <p className="text-sm text-danger">{error}</p>
            <Button
              className="mt-3"
              label="Retry"
              size="sm"
              variant="secondary"
              onClick={onRefresh}
            />
          </div>
        ) : changes?.state === "non-git" ? (
          <EmptyState
            className="flex-1 justify-center px-4"
            title="No Git repository"
            description="This session’s working directory is not a Git repository. File changes appear here for Git projects."
            icon={<FileDiff className="size-5 text-muted" />}
            isCompact
          />
        ) : changes?.state === "clean" || !changes?.files.length ? (
          <EmptyState
            className="flex-1 justify-center px-4"
            title="No changes yet"
            description="Your working tree is clean. Staged, unstaged, and new files will appear here as you work."
            icon={<FileDiff className="size-5 text-muted" />}
            isCompact
          />
        ) : (
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_min(40%,13rem)] grid-rows-[minmax(0,1fr)]">
            {/* Every diff, top to bottom: the reviewer scrolls instead of
                switching. Each section is one file; a folded one drops its
                viewer so a wide tree never keeps hundreds of renderers alive. */}
            <CollapsibleGroup
              className="min-h-0 min-w-0 overflow-y-auto overscroll-contain bg-surface"
              density="compact"
              hasDividers
              type="multiple"
              value={openPaths}
              onChange={(value) => {
                const open = new Set(Array.isArray(value) ? value : [value]);
                setClosedPaths(
                  new Set(
                    files.map((file) => file.path).filter((path) => !open.has(path)),
                  ),
                );
              }}
            >
              {changes.files.map((file) => {
                const isOpen = !closedPaths.has(file.path);

                return (
                  <Collapsible
                    key={`${file.previousPath ?? ""}:${file.path}`}
                    className="pigui-change-section shrink-0"
                    data-testid="session-change-section"
                    ref={(node) => {
                      if (node) sectionRefs.current.set(file.path, node);
                      else sectionRefs.current.delete(file.path);
                    }}
                    trigger={
                      <span className="flex w-full min-w-0 items-center gap-3 text-left">
                        <span
                          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                          title={file.path}
                        >
                          {file.path}
                        </span>
                        <span
                          className="hidden min-w-0 shrink truncate text-xs text-muted @sm/changes:inline"
                          title={changeStageLabel(file)}
                        >
                          {changeKindLabel(file.kind)} · {changeStageLabel(file)}
                        </span>
                        <ChangeCounts file={file} />
                      </span>
                    }
                    value={file.path}
                  >
                    {isOpen ? (
                      <>
                        {file.kind === "conflicted" ? (
                          <p className="bg-warning/5 px-3 py-3 text-sm text-foreground">
                            This file has unresolved merge conflicts. Resolve it in the
                            checkout before reviewing a normal patch.
                          </p>
                        ) : file.binary ? (
                          <EmptyState
                            className="px-4 py-6"
                            title="Diff unavailable"
                            description="Binary file changed. A textual diff is not available."
                            icon={<FileDiff className="size-5 text-muted" />}
                            isCompact
                          />
                        ) : file.patchTruncated ? (
                          <p className="bg-warning/5 px-3 py-3 text-sm text-foreground">
                            This patch exceeds the review limit and was omitted. Open the
                            checkout for the full diff.
                          </p>
                        ) : file.patch ? (
                          <Suspense
                            fallback={
                              <div
                                className="h-40 animate-pulse motion-reduce:animate-none bg-default/30"
                                aria-label="Loading diff renderer"
                              />
                            }
                          >
                            <SessionDiffViewer
                              cacheKey={`${changes.sessionId}:${changes.generatedAt}:${file.path}`}
                              patch={file.patch}
                              line={target?.sessionId === sessionId && target.path === file.path ? target.line : undefined}
                              style="unified"
                            />
                          </Suspense>
                        ) : (
                          <EmptyState
                            className="px-4 py-6"
                            title="No textual changes"
                            description="No textual patch is available for this file."
                            icon={<FileDiff className="size-5 text-muted" />}
                            isCompact
                          />
                        )}
                      </>
                    ) : null}
                  </Collapsible>
                );
              })}
            </CollapsibleGroup>

            {/* Both columns own their scroll position, including in narrow docks. */}
            <nav
              aria-label="Changed files"
              className="flex min-h-0 min-w-0 flex-col border-l border-separator bg-surface"
            >
              <p className="shrink-0 px-2 py-1 text-xs font-medium text-muted">
                {changes.files.length} files
              </p>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {changes.files.map((file) => (
                  <button
                    key={`${file.previousPath ?? ""}:${file.path}`}
                    data-current={file.path === currentPath ? "true" : undefined}
                    className={`w-full min-w-0 px-2 py-1.5 text-left transition-colors ${
                      file.path === currentPath
                        ? "bg-default/70 text-foreground"
                        : "text-muted hover:bg-default/40 hover:text-foreground"
                    }`}
                    type="button"
                    onClick={() => navigateTo(file.path)}
                  >
                    <span className="block truncate text-sm" title={file.path}>
                      {file.path}
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate" title={changeStageLabel(file)}>
                        {changeKindLabel(file.kind)} · {changeStageLabel(file)}
                      </span>
                      <ChangeCounts file={file} />
                    </span>
                  </button>
                ))}
              </div>
            </nav>
          </div>
        )}
        {hasReview && changes?.truncated ? (
          <p className="shrink-0 bg-warning/5 px-3 py-2 text-sm text-foreground">
            Review is bounded. {changes.omittedFileCount > 0
              ? `${changes.omittedFileCount} additional files were omitted.`
              : "One or more oversized patches were omitted."}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** The +A −D tail of a file row, or what stands in for it. */
function ChangeCounts({ file }: { file: SessionChangedFile }) {
  if (file.kind === "conflicted") {
    return <span className="shrink-0 text-xs">Resolve</span>;
  }
  if (file.binary) {
    return <span className="shrink-0 text-xs">Binary</span>;
  }
  return (
    <span className="shrink-0 text-xs">
      <span className="text-success">+{file.additions ?? 0}</span>{" "}
      <span className="text-danger">-{file.deletions ?? 0}</span>
    </span>
  );
}
