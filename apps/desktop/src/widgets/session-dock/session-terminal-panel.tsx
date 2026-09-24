import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Stack } from "@astryxdesign/core/Stack";
import {
  attachTerminal,
  closeTerminal,
  listTerminals,
  openTerminal,
  resizeTerminal,
  sendTerminalInput,
  subscribeTerminalEvents,
  type TerminalInstanceInfo,
} from "@/entities/terminal/terminal-client";
import { isElectronRuntime } from "@/shared/runtime";
import { Terminal } from "@/shared/ui/icons";
import {
  SessionSurfaceBar,
  SessionSurfaceTabs,
} from "@/shared/ui/session-dock/surface-bar";
import {
  TerminalView,
  type TerminalViewHandle,
} from "@/shared/ui/terminal/terminal-view";

/**
 * Terminal surface content (ADR-0028): the rail keeps a single icon while the
 * panel owns the instances — the shared instance strip as the surface's first
 * row, one xterm viewport below.
 */

const defaultTerminalSize = { cols: 80, rows: 24 };

/**
 * The xterm view for one instance. Mount order matters: subscribe first so no
 * output is missed, then attach and replay the backend's scrollback buffer.
 * Live chunks that race the attach round-trip are held and de-duplicated by
 * stream offset (`end`) once attach reports where its scrollback ends, so old
 * and new bytes neither interleave nor repeat. Unmounting disposes the view
 * only; the backend instance stays alive and the next mount re-attaches.
 */
function ActiveTerminal({
  instance,
  onSizeChange,
}: {
  instance: TerminalInstanceInfo;
  onSizeChange: (cols: number, rows: number) => void;
}) {
  const viewRef = useRef<TerminalViewHandle>(null);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    let disposed = false;
    let attached = false;
    const pending: Array<{ data: string; end?: number }> = [];
    const write = (data: string, end?: number) => {
      if (attached) {
        view.write(data);
      } else {
        pending.push({ data, end });
      }
    };

    const unsubscribe = subscribeTerminalEvents({
      onOutput: (terminalId, data, end) => {
        if (terminalId === instance.terminalId) {
          write(data, end);
        }
      },
      onExit: (terminalId, exitCode) => {
        if (terminalId === instance.terminalId) {
          write(`\r\n[process exited with code ${exitCode}]`);
        }
      },
    });

    void attachTerminal(instance.terminalId)
      .then(({ scrollback, end: attachEnd }) => {
        if (disposed) {
          return;
        }

        if (scrollback) {
          view.write(scrollback);
        }
        if (instance.status === "exited") {
          // The exit event fired before this view existed; the code may be
          // unknown for instances that came back from listTerminals.
          view.write(
            instance.exitCode === undefined
              ? "\r\n[process exited]"
              : `\r\n[process exited with code ${instance.exitCode}]`,
          );
        }
        for (const chunk of pending) {
          if (chunk.end === undefined) {
            view.write(chunk.data);
            continue;
          }
          if (chunk.end <= attachEnd) {
            continue; // Already inside the replayed scrollback.
          }
          const start = chunk.end - chunk.data.length;
          view.write(chunk.data.slice(Math.max(0, attachEnd - start)));
        }
        attached = true;
      })
      .catch(() => {
        // A dead instance leaves the viewport blank; the next mount retries.
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
    // Only the instance identity re-runs this: a status flip to "exited" must
    // not re-attach, or the scrollback replay would duplicate the buffer. The
    // status/exitCode reads above are the mount-time snapshot, which is
    // exactly what the "already exited before this view existed" check wants.
  }, [instance.terminalId]);

  return (
    <TerminalView
      ref={viewRef}
      className="h-full w-full"
      onData={(data) => {
        void sendTerminalInput(instance.terminalId, data).catch(() => {});
      }}
      onResize={(cols, rows) => {
        onSizeChange(cols, rows);
        void resizeTerminal(instance.terminalId, cols, rows).catch(() => {});
      }}
    />
  );
}

type Props = {
  sessionId: string;
  onInstancesChange?: (instances: TerminalInstanceInfo[]) => void;
};

export function SessionTerminalPanel(props: Props) {
  return <TerminalSessionContent key={props.sessionId} {...props} />;
}

function TerminalSessionContent({ sessionId, onInstancesChange }: Props) {
  const [instances, setInstances] = useState<TerminalInstanceInfo[] | null>(null);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const openingRef = useRef(false);
  // Reused for every new shell so it starts at the viewport's current
  // geometry instead of a guess that immediately resizes.
  const lastSizeRef = useRef(defaultTerminalSize);

  // Opening the surface only lists existing shells; creation needs an explicit action.
  useEffect(() => {
    if (!isElectronRuntime()) {
      setUnavailable(true);
      setInstances([]);
      return;
    }

    let cancelled = false;
    setUnavailable(false);
    setActionError(null);
    setInstances(null);
    setActiveTerminalId(null);

    void (async () => {
      try {
        const list = await listTerminals(sessionId);
        if (cancelled) {
          return;
        }
        setInstances(list);
        setActiveTerminalId(list[0]?.terminalId ?? null);
      } catch {
        if (!cancelled) {
          setUnavailable(true);
          setInstances([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const markExited = useCallback((terminalId: string, exitCode: number) => {
    setInstances((current) =>
      current?.map((instance) =>
        instance.terminalId === terminalId
          ? { ...instance, status: "exited", exitCode }
          : instance,
      ) ?? current,
    );
  }, []);

  // Exits land whatever tab is active, so a background shell's exit still
  // mutes its tab in the strip.
  useEffect(() => {
    if (!isElectronRuntime()) {
      return;
    }

    return subscribeTerminalEvents({ onExit: markExited });
  }, [markExited]);

  useEffect(() => {
    if (instances) {
      onInstancesChange?.(instances);
    }
  }, [instances, onInstancesChange]);

  const openNewTerminal = async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    setIsOpening(true);
    setActionError(null);

    try {
      const created = await openTerminal({ sessionId, ...lastSizeRef.current });
      setInstances((current) => [...(current ?? []), created]);
      setActiveTerminalId(created.terminalId);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "A new terminal could not be opened.",
      );
    } finally {
      openingRef.current = false;
      setIsOpening(false);
    }
  };

  const closeInstance = async (terminalId: string) => {
    const current = instances ?? [];
    const index = current.findIndex((instance) => instance.terminalId === terminalId);
    const next = current.filter((instance) => instance.terminalId !== terminalId);

    setInstances(next);
    if (terminalId === activeTerminalId) {
      // Activate whichever tab slides into the closed tab's slot.
      setActiveTerminalId(next[Math.min(index, next.length - 1)]?.terminalId ?? null);
    }

    try {
      await closeTerminal(terminalId);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "The terminal could not be closed.",
      );
    }
  };

  if (unavailable) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <Terminal className="size-5 text-muted" />
        <p className="text-sm text-muted">Terminal requires the desktop app.</p>
      </div>
    );
  }

  if (instances === null) {
    return (
      <p className="pt-3 text-sm text-muted" role="status">Loading terminals…</p>
    );
  }

  if (instances.length === 0) {
    return (
      <Stack height="100%" justify="center" padding={4}>
        <EmptyState
          title="No terminals open"
          description="Create a terminal to run commands in this session’s working directory."
          icon={<Terminal className="size-5 text-muted" />}
          isCompact
          actions={
            <Button
              label="New terminal"
              size="sm"
              isLoading={isOpening}
              onClick={() => void openNewTerminal()}
            />
          }
        />
        {actionError ? (
          <p className="text-xs text-danger" role="alert">{actionError}</p>
        ) : null}
      </Stack>
    );
  }

  const activeInstance =
    instances.find((instance) => instance.terminalId === activeTerminalId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionSurfaceBar>
        <SessionSurfaceTabs
          activeId={activeTerminalId}
          addLabel="New terminal"
          icon={Terminal}
          items={instances.map((instance, index) => ({
            id: instance.terminalId,
            label: `Terminal ${index + 1}`,
            hint: instance.cwd,
            isExited: instance.status === "exited",
          }))}
          aria-label="Terminal instances"
          onActiveChange={setActiveTerminalId}
          onAdd={() => void openNewTerminal()}
          onClose={(terminalId) => void closeInstance(terminalId)}
        />
      </SessionSurfaceBar>
      {actionError ? (
        <p className="pb-2 text-xs text-danger" role="alert">
          {actionError}
        </p>
      ) : null}
      {/* The resize handle is the 1px divider itself, so column zero would
          otherwise touch it. pl-4 gives the text the same 16px inset as the
          non-flush surfaces (and as Cursor's terminal). The right inset is
          xterm's scrollbar lane (slimmed in terminal.css) plus a hair of bottom
          pad so the last line never kisses the chrome. */}
      <div
        className="min-h-0 flex-1 pb-1 pl-4"
        data-testid="terminal-viewport"
      >
        {activeInstance ? (
          <ActiveTerminal
            key={activeInstance.terminalId}
            instance={activeInstance}
            onSizeChange={(cols, rows) => {
              lastSizeRef.current = { cols, rows };
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
