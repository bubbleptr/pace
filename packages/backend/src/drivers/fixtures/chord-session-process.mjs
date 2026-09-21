/**
 * Forked child for the chord IPC spike.
 *
 * Both the real session-process server and a chord FacetHost share this
 * process's IPC channel. Node flushes the pre-listen backlog to the first
 * `message` handler only, so we attach both listeners before signalling ready.
 *
 * serveSessionProcess does not yet filter `chord_*`; unknown-method error
 * replies for those frames are expected until the production server does.
 */
import { createFacetHost } from "@earendil-works/chord";
import { sessionFacet } from "../chord-plugin-spike-demo.ts";
import { createParentProcessChordPort, serveChordFacetHost } from "../chord-plugin-spike.ts";
import { serveSessionProcess } from "../session-process-server.ts";

let snapshot;
let onEvent = () => {};

const host = await createFacetHost({ facets: [sessionFacet] });
serveChordFacetHost(host, createParentProcessChordPort());
serveSessionProcess({
  async createSession(input) {
    snapshot = {
      sessionId: input.sessionId,
      projectId: input.projectId,
      cwd: input.cwd,
      piSessionId: input.piSessionId ?? `pi-${input.sessionId}`,
      runtimeId: String(process.pid),
      status: "idle",
      events: [],
      updatedAt: new Date().toISOString(),
    };
    return snapshot;
  },
  async getSnapshot() {
    return snapshot;
  },
  async dispose() {},
  onEvent(listener) {
    onEvent = listener;
    return () => {
      onEvent = () => {};
    };
  },
});

process.send({ type: "spike_ready" });
