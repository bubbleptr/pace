import { DEFAULT_THEMES } from "@pierre/diffs";
import { File } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef } from "react";

export type SessionFileViewerProps = {
  /** Diff-root-relative path; the viewer picks its syntax grammar from it. */
  path: string;
  contents: string;
  /** 1-based line to highlight and scroll to, from a chat file link. */
  line?: number;
};

/**
 * Read-only file preview for the Files surface. Same renderer options as the
 * diff viewer so a file looks identical whether it is browsed or reviewed.
 */
export default function SessionFileViewer({
  path,
  contents,
  line,
}: SessionFileViewerProps) {
  const focusFrame = useRef<number | null>(null);
  const focusedLine = useRef<string | null>(null);
  useEffect(() => () => {
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = null;
  }, [path, line]);
  const selectedLines = useMemo(
    () =>
      line && Number.isSafeInteger(line) && line >= 1
        ? ({ start: line, end: line } as const)
        : null,
    [line],
  );

  return (
    <div
      className="min-w-0 overflow-hidden rounded-md border border-default/70 bg-surface"
      data-testid="session-file-viewer"
    >
      <File
        disableWorkerPool
        file={{ name: path, contents }}
        selectedLines={selectedLines}
        options={{
          disableFileHeader: true,
          overflow: "scroll",
          theme: DEFAULT_THEMES,
          themeType: "light",
          onPostRender(node, _instance, phase) {
            if (phase === "unmount" || !selectedLines) return;
            const key = `${path}:${line}`;
            if (focusedLine.current === key || focusFrame.current !== null) return;
            // Wait until the Dock and its file-level jump have laid out. Later
            // syntax-highlighting passes must not pull the user back here —
            // the same rule the diff viewer follows.
            focusFrame.current = requestAnimationFrame(() => {
              focusFrame.current = null;
              if (!node.isConnected) return;
              // File mode marks each code row with its 1-based line number;
              // an out-of-range link simply finds no row.
              const row = node.shadowRoot?.querySelector<HTMLElement>(
                `[data-line="${selectedLines.start}"]`,
              );
              if (row) {
                row.scrollIntoView({ block: "center" });
                focusedLine.current = key;
              }
            });
          },
        }}
      />
    </div>
  );
}
