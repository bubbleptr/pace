/**
 * Shared demo plugin for the chord IPC spikes.
 *
 * Both the in-memory port test and the forked-child test must use the same
 * service token; a mismatched id would look like a transport failure.
 */
import {
  defineFacet,
  defineService,
  type Context,
  type ReplicatedState,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

export interface DemoPanelService {
  readonly progress: ReplicatedState<{ step: number; label: string }>;
  advance(input: { by: number }, context: Context): Promise<{ step: number }>;
}

export const DemoPanelService = defineService<DemoPanelService>("pace.spike.demo-panel");

/** Stand-in for a plugin's `session.ts` facet, running next to the agent. */
export const sessionFacet = defineFacet({
  id: "pace-spike/session",
  setup(env) {
    const progress = env.replicatedState({ step: 0, label: "idle" });
    env.provide(DemoPanelService, {
      progress,
      async advance({ by }) {
        progress.state.step += by;
        progress.state.label = `step ${progress.state.step}`;
        progress.publish(BACKGROUND_CONTEXT);
        return { step: progress.state.step };
      },
    });
  },
});
