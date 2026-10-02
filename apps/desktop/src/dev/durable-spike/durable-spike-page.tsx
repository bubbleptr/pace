import { relayTransport } from "@pace/durable-spike/protocol/transport.ts";
import { RemoteWorkbench } from "@pace/durable-spike/web/App.tsx";
import { invoke, onBackendEvent } from "@/shared/runtime";
import { backendRelay } from "./backend-relay";

const label = "Pace backend → ws://127.0.0.1:7420";
const transport = relayTransport(backendRelay({ invoke, onBackendEvent }), label);

/**
 * Dev-only third client of the Durable multiview spike (spikes/durable-multiview):
 * the web client's workbench, reached through Pace's backend instead of a
 * browser WebSocket. Start the host first (`bun run host` or `bun run demo` in the spike).
 */
export function DurableSpikePage() {
  return <RemoteWorkbench options={{ transport, clientName: "pace" }} connectionKey="pace-backend" label={label} />;
}
