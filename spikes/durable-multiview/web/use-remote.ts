import { useEffect, useState, useSyncExternalStore } from "react";
import { connectRemoteDurable, type RemoteDurable } from "../protocol/remote-durable.ts";
import type { DurableView } from "../protocol/view.ts";

export type RemoteState =
  | { readonly status: "connecting" }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "ready"; readonly remote: RemoteDurable };

/** One connection per address for the component's lifetime; later losses are the view's `connection`, not this state. */
export function useRemoteDurable(address: { url: string; token: string }): RemoteState {
  const [state, setState] = useState<RemoteState>({ status: "connecting" });
  useEffect(() => {
    let opened: RemoteDurable | undefined;
    let cancelled = false;
    connectRemoteDurable({ ...address, reconnectDelayMs: { min: 200, max: 2000 } }).then(
      (remote) => {
        if (cancelled) {
          remote.close();
          return;
        }
        opened = remote;
        // As in the TUI, the task panel starts open. Here and not in a component effect,
        // which StrictMode runs twice and would toggle it shut again.
        void remote.controller.toggleTasks();
        setState({ status: "ready", remote });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "failed", error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
      opened?.close();
    };
  }, [address.url, address.token]);
  return state;
}

export function useDurableView(remote: RemoteDurable): DurableView {
  return useSyncExternalStore(remote.view.subscribe, remote.view.current);
}
