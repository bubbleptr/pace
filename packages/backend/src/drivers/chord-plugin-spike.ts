/**
 * Spike: carry Chord services over a plain JSON message port.
 *
 * Pi's upcoming plugin model (`@earendil-works/chord`) splits a plugin into
 * facets that run in different hosts: a `session` facet next to the agent and
 * a presentation facet next to the UI. Pi's own client/server carry the Chord
 * wire grammar inside pi-protocol CBOR frames. Pace already owns a JSON IPC
 * between the backend and each Session process (`session-process-protocol.ts`),
 * so this spike asks: can Pace be a presentation host for Chord plugins using
 * only Chord's public wire API and its own JSON channel, without pi-server,
 * pi-client or pi-protocol?
 *
 * The adapters below mirror what pi-server (`serveChordFacetHost`) and
 * pi-client (`createChordPortTransport`) do around Chord, reduced to the
 * minimum. Everything that crosses the port is strict JSON, which is exactly
 * what `child_process` IPC with the default `json` serialization preserves.
 * `relayChordFrames` is the exception: it only looks at `kind` and does not
 * host Chord at all.
 *
 * This is exploratory code. It is not wired into any driver.
 */
import type { ChildProcess } from "node:child_process";
import type { MessagePort } from "node:worker_threads";
import {
  createRemoteServiceBinding,
  createRemoteServiceEndpoint,
  createServiceCatalogueCall,
  createServiceStateDecoder,
  createServiceStateEncoder,
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
  decodeServiceControlCall,
  parseServiceCatalogue,
  parseServiceSubscriptionSnapshot,
  parseWireServiceProviderUpdate,
  parseWireServiceSubscriptionSnapshot,
  type Context,
  type FacetHost,
  type JsonValue,
  type RemoteServiceSource,
  type RemoteServiceTransport,
  type ServiceCall,
  type ServiceProviderUpdate,
  type ServiceStateDecoder,
  type ServiceStateEncoder,
  type ServiceSubscription,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/** The only three message shapes needed to carry Chord over a JSON channel. */
export type ChordWireMessage =
  | { kind: "chord_call"; id: number; call: ServiceCall }
  | { kind: "chord_result"; id: number; result?: JsonValue; error?: string }
  | { kind: "chord_update"; subscriptionId: string; update: JsonValue };

/** Minimal duplex JSON port, the shape both `process.send` and `child.send` already have. */
export type JsonMessagePort = {
  send(message: ChordWireMessage): void;
  onMessage(listener: (message: ChordWireMessage) => void): () => void;
};

/**
 * Session-process side: expose a facet host's non-local services on a port.
 *
 * Updates published while a subscribe call is still in flight are held back
 * until the snapshot response has been sent, so the consumer always sees the
 * snapshot before any delta that follows it (same rule as pi-server).
 */
export function serveChordFacetHost(host: FacetHost, port: JsonMessagePort): () => void {
  const endpoint = createRemoteServiceEndpoint(host.services);
  const encoders = new Map<string, ServiceStateEncoder>();

  const sendUpdate = (subscriptionId: string, update: ServiceProviderUpdate) => {
    const encoder = encoders.get(subscriptionId);
    if (encoder === undefined) return;
    port.send({
      kind: "chord_update",
      subscriptionId,
      update: encoder.encodeUpdate(update) as unknown as JsonValue,
    });
  };

  const stop = port.onMessage(async message => {
    if (message.kind !== "chord_call") return;
    const control = decodeServiceControlCall(message.call);
    const subscribing = control?.type === "subscribe" ? control : undefined;
    const held: ServiceProviderUpdate[] = [];
    let snapshotSent = subscribing === undefined;
    const publish = (subscriptionId: string, update: ServiceProviderUpdate) => {
      if (subscribing !== undefined && subscriptionId === subscribing.subscriptionId && !snapshotSent) {
        held.push(update);
        return;
      }
      sendUpdate(subscriptionId, update);
    };
    try {
      let result = await endpoint.invoke(message.call, publish, BACKGROUND_CONTEXT);
      if (subscribing !== undefined) {
        if (result === undefined) throw new Error("Service subscription did not return a snapshot");
        const encoder = createServiceStateEncoder();
        result = encoder.encodeSnapshot(parseServiceSubscriptionSnapshot(result)) as unknown as JsonValue;
        encoders.set(subscribing.subscriptionId, encoder);
      } else if (control?.type === "unsubscribe") {
        encoders.delete(control.subscriptionId);
      }
      port.send(
        result === undefined
          ? { kind: "chord_result", id: message.id }
          : { kind: "chord_result", id: message.id, result },
      );
      snapshotSent = true;
      if (subscribing !== undefined) for (const update of held.splice(0)) sendUpdate(subscribing.subscriptionId, update);
    } catch (error) {
      port.send({ kind: "chord_result", id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return () => {
    stop();
    encoders.clear();
    endpoint.dispose();
  };
}

type ActiveSubscription = {
  decoder: ServiceStateDecoder;
  listener: (update: ServiceProviderUpdate, context: Context) => void;
  hydrated: boolean;
  ready: boolean;
  /** Wire updates that arrived before the snapshot response was processed. */
  queuedWire: JsonValue[];
  /** Decoded updates that arrived before the binding called `activate()`. */
  queued: ServiceProviderUpdate[];
};

export type ChordPortTransport = RemoteServiceTransport & { dispose(): void };

/**
 * Presentation side: a `RemoteServiceTransport` over the same port.
 *
 * Chord hands us one `ServiceSubscription` per (service, subscriber); each owns
 * its own decoder because path dictionaries are per subscription stream.
 */
export function createChordPortTransport(port: JsonMessagePort): ChordPortTransport {
  let callSequence = 0;
  let subscriptionSequence = 0;
  const pending = new Map<number, { resolve: (value: JsonValue | undefined) => void; reject: (error: Error) => void }>();
  const subscriptions = new Map<string, ActiveSubscription>();

  const stop = port.onMessage(message => {
    if (message.kind === "chord_result") {
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) request.reject(new Error(message.error));
      else request.resolve(message.result);
      return;
    }
    if (message.kind === "chord_update") {
      const active = subscriptions.get(message.subscriptionId);
      if (active === undefined) return;
      if (!active.hydrated) {
        active.queuedWire.push(message.update);
        return;
      }
      const update = active.decoder.decodeUpdate(parseWireServiceProviderUpdate(message.update));
      if (active.ready) active.listener(update, BACKGROUND_CONTEXT);
      else active.queued.push(update);
    }
  });

  const request = (call: ServiceCall): Promise<JsonValue | undefined> =>
    new Promise((resolve, reject) => {
      const id = ++callSequence;
      pending.set(id, { resolve, reject });
      port.send({ kind: "chord_call", id, call });
    });

  return {
    invoke: call => request(call),
    async subscribe(serviceId, mode, listener): Promise<ServiceSubscription> {
      const subscriptionId = `sub-${++subscriptionSequence}`;
      const active: ActiveSubscription = {
        decoder: createServiceStateDecoder(),
        listener,
        hydrated: false,
        ready: false,
        queuedWire: [],
        queued: [],
      };
      subscriptions.set(subscriptionId, active);
      let snapshot;
      try {
        const raw = await request(createServiceSubscribeCall(subscriptionId, serviceId, mode));
        snapshot = active.decoder.decodeSnapshot(parseWireServiceSubscriptionSnapshot(raw));
      } catch (error) {
        subscriptions.delete(subscriptionId);
        throw error;
      }
      active.hydrated = true;
      for (const wire of active.queuedWire.splice(0)) {
        active.queued.push(active.decoder.decodeUpdate(parseWireServiceProviderUpdate(wire)));
      }
      return {
        snapshot,
        activate() {
          if (active.ready) return;
          active.ready = true;
          for (const update of active.queued.splice(0)) listener(update, BACKGROUND_CONTEXT);
        },
        async close() {
          if (!subscriptions.delete(subscriptionId)) return;
          await request(createServiceUnsubscribeCall(subscriptionId));
        },
      };
    },
    dispose() {
      stop();
      const error = new Error("Chord port transport disposed");
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      subscriptions.clear();
    },
  };
}

/** Make a port transport usable as a `serviceSources` entry of `createFacetHost`. */
export function createChordPortServiceSource(transport: RemoteServiceTransport): RemoteServiceSource {
  return {
    acceptsUnavailableServices: false,
    async catalogue(context) {
      return parseServiceCatalogue(await transport.invoke(createServiceCatalogueCall(), context));
    },
    open({ services, assertAccess, onError }) {
      return createRemoteServiceBinding({ services, transport, bound: true, assertAccess, onError });
    },
  };
}

/**
 * In-memory stand-in for `child_process` IPC: every message is round-tripped
 * through JSON and delivered asynchronously, so anything non-JSON or any
 * ordering assumption breaks here the same way it would across processes.
 */
export function createJsonMessagePortPair(): [JsonMessagePort, JsonMessagePort] {
  const listenersA = new Set<(message: ChordWireMessage) => void>();
  const listenersB = new Set<(message: ChordWireMessage) => void>();
  const port = (own: typeof listenersA, peer: typeof listenersB): JsonMessagePort => ({
    send(message) {
      const copy = JSON.parse(JSON.stringify(message)) as ChordWireMessage;
      queueMicrotask(() => {
        for (const listener of peer) listener(copy);
      });
    },
    onMessage(listener) {
      own.add(listener);
      return () => own.delete(listener);
    },
  });
  return [port(listenersA, listenersB), port(listenersB, listenersA)];
}

function isChordPortMessage(message: unknown): message is ChordWireMessage {
  if (typeof message !== "object" || message === null) return false;
  const kind = (message as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.startsWith("chord_");
}

/**
 * Parent-side port over a forked child's IPC channel.
 *
 * Node delivers every payload to every `message` listener, including the
 * existing `{ id, method, args }` driver protocol. Only `chord_*` frames are
 * forwarded so the two grammars can share one channel.
 */
export function createChildProcessChordPort(child: ChildProcess): JsonMessagePort {
  return {
    send(message) {
      child.send(message);
    },
    onMessage(listener) {
      const handler = (message: unknown) => {
        if (isChordPortMessage(message)) listener(message);
      };
      child.on("message", handler);
      return () => {
        child.off("message", handler);
      };
    },
  };
}

/**
 * Child-side counterpart of `createChildProcessChordPort`. Same `chord_*`
 * filter so driver commands stay invisible to Chord.
 */
export function createParentProcessChordPort(): JsonMessagePort {
  return {
    send(message) {
      process.send?.(message);
    },
    onMessage(listener) {
      const handler = (message: unknown) => {
        if (isChordPortMessage(message)) listener(message);
      };
      process.on("message", handler);
      return () => {
        process.off("message", handler);
      };
    },
  };
}

/**
 * Renderer-side port over one end of a structured-clone `MessageChannel`.
 *
 * Node's `MessagePort` emits the cloned value itself (not a DOM `MessageEvent`).
 * Attaching `message` refs the port; callers must `unref()` or `close()` it or
 * the test process will not exit.
 */
export function createMessagePortChordPort(port: MessagePort): JsonMessagePort {
  return {
    send(message) {
      port.postMessage(message);
    },
    onMessage(listener) {
      const handler = (message: unknown) => {
        if (isChordPortMessage(message)) listener(message);
      };
      port.on("message", handler);
      return () => {
        port.off("message", handler);
      };
    },
  };
}

/**
 * Backend between a session child and a renderer: forward `chord_*` frames
 * both ways. Payload grammar stays on the two Chord hosts; this process only
 * looks at `kind`, so it does not need to host Chord itself.
 */
export function relayChordFrames(childPort: JsonMessagePort, rendererPort: JsonMessagePort): () => void {
  const forward = (from: JsonMessagePort, to: JsonMessagePort) =>
    from.onMessage(message => {
      if (!message.kind.startsWith("chord_")) return;
      to.send(message);
    });
  const stopChild = forward(childPort, rendererPort);
  const stopRenderer = forward(rendererPort, childPort);
  return () => {
    stopChild();
    stopRenderer();
  };
}
