import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationId, ConversationView, TaskGraph } from "@earendil-works/pi-durable";
import {
  type CallMethod,
  type CallMethods,
  type ClientFrame,
  conversationStream,
  type ServerFrame,
  type StreamName,
  UNAUTHORIZED_CLOSE_CODE,
} from "./frames.ts";
import { type FrameConnection, type FrameTransport, webSocketTransport } from "./transport.ts";
import type {
  ConversationSummary,
  DurableController,
  DurableView,
  DurableViewSource,
  Notice,
} from "./view.ts";

export type RemoteDurableOptions = (
  | {
      /** `ws://127.0.0.1:<port>` of a host's gateway. */
      readonly url: string;
      readonly token: string;
    }
  | { readonly transport: FrameTransport }
) & { readonly reconnectDelayMs?: { readonly min: number; readonly max: number } };

export interface RemoteDurable {
  readonly view: DurableViewSource;
  readonly controller: DurableController;
  close(): void;
}

/**
 * A DurableViewSource and DurableController over a host's gateway. Holds no
 * Harness: each subscribed stream is a snapshot plus chord ops, and a lost
 * host is reconnected to and resubscribed from fresh snapshots, never replayed.
 */
export function connectRemoteDurable(options: RemoteDurableOptions): Promise<RemoteDurable> {
  return new RemoteClient(options).ready;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

class RemoteClient {
  readonly ready: Promise<RemoteDurable>;
  readonly #options: RemoteDurableOptions;
  readonly #listeners = new Set<() => void>();
  readonly #values = new Map<StreamName, unknown>();
  readonly #wanted = new Set<StreamName>(["conversations"]);
  readonly #snapshotWaiters = new Map<StreamName, { resolve(): void; reject(error: Error): void }[]>();
  readonly #pending = new Map<number, Pending>();
  readonly #transport: FrameTransport;
  #connection: FrameConnection | undefined;
  #state: DurableView | undefined;
  #current: ConversationId | undefined;
  #nextCall = 1;
  #nextNotice = 1;
  #attempt = 0;
  #closed = false;
  #notifying = false;
  #commands = Promise.resolve();
  #resolveReady!: (value: RemoteDurable) => void;
  #rejectReady!: (error: Error) => void;

  constructor(options: RemoteDurableOptions) {
    this.#options = options;
    this.#transport = "transport" in options ? options.transport : webSocketTransport(options.url, options.token);
    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#open();
  }

  #open(): void {
    const connection: FrameConnection = this.#transport.open({
      message: (data) => {
        if (this.#connection === connection) this.#receive(JSON.parse(data) as ServerFrame);
      },
      closed: (code, reason) => this.#lost(connection, code, reason),
    });
    this.#connection = connection;
  }

  #lost(connection: FrameConnection, code: number, reason: string | undefined): void {
    if (this.#connection !== connection) return;
    this.#connection = undefined;
    for (const pending of this.#pending.values()) pending.reject(new Error("Disconnected from host"));
    this.#pending.clear();
    if (this.#state === undefined) {
      this.#closed = true;
      this.#rejectReady(
        new Error(
          code === UNAUTHORIZED_CLOSE_CODE ? "Unauthorized: wrong host token" : (reason ?? `Could not connect to ${this.#transport.label}`),
        ),
      );
      return;
    }
    if (this.#closed) return;
    if (code === UNAUTHORIZED_CLOSE_CODE) {
      this.#closed = true;
      this.#update({ connection: "closed" });
      this.#notice("error", "Host rejected the token.");
      return;
    }
    this.#update({ connection: "reconnecting" });
    const { min, max } = this.#options.reconnectDelayMs ?? { min: 200, max: 2000 };
    const delay = Math.min(max, min * 2 ** this.#attempt++);
    setTimeout(() => {
      if (!this.#closed) this.#open();
    }, delay);
  }

  #send(frame: ClientFrame): void {
    this.#connection?.send(JSON.stringify(frame));
  }

  #receive(frame: ServerFrame): void {
    switch (frame.type) {
      case "hello": {
        this.#attempt = 0;
        this.#current ??= frame.root;
        this.#wanted.add(conversationStream(this.#current));
        for (const stream of this.#wanted) this.#send({ type: "subscribe", stream });
        if (this.#state !== undefined) this.#update({ session: frame.session, models: frame.models, connection: "connected" });
        else this.#awaitFirstView(frame);
        return;
      }
      case "snapshot":
        if (!this.#wanted.has(frame.stream)) return;
        this.#values.set(frame.stream, frame.value);
        this.#refresh();
        for (const waiter of this.#snapshotWaiters.get(frame.stream)?.splice(0) ?? []) waiter.resolve();
        return;
      case "ops":
        if (!this.#wanted.has(frame.stream) || !this.#values.has(frame.stream)) return;
        this.#values.set(frame.stream, applyImmutable(this.#values.get(frame.stream), frame.ops));
        this.#refresh();
        return;
      case "ended":
        this.#wanted.delete(frame.stream);
        this.#values.delete(frame.stream);
        for (const waiter of this.#snapshotWaiters.get(frame.stream)?.splice(0) ?? []) {
          waiter.reject(new Error(`Stream ${frame.stream} ended: ${frame.reason}`));
        }
        this.#refresh();
        return;
      case "result": {
        const pending = this.#pending.get(frame.id);
        this.#pending.delete(frame.id);
        if (frame.ok) pending?.resolve(frame.value);
        else pending?.reject(new Error(frame.error));
        return;
      }
      case "notice":
        this.#notice(frame.level, frame.message);
        return;
    }
  }

  #awaitFirstView(hello: Extract<ServerFrame, { type: "hello" }>): void {
    const conversation = conversationStream(hello.root);
    void Promise.all([this.#snapshot(conversation), this.#snapshot("conversations")]).then(() => {
      this.#state = {
        session: hello.session,
        conversation: this.#values.get(conversation) as ConversationView,
        conversations: this.#values.get("conversations") as ConversationSummary[],
        models: hello.models,
        notices: [],
        connection: "connected",
      };
      this.#resolveReady({ view: this.#viewSource(), controller: this.#controller(), close: () => this.#close() });
    });
  }

  /** Resolve at the stream's next snapshot; reject if the host ends it instead. */
  #snapshot(stream: StreamName): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiters = this.#snapshotWaiters.get(stream) ?? [];
      waiters.push({ resolve, reject });
      this.#snapshotWaiters.set(stream, waiters);
    });
  }

  #refresh(): void {
    if (this.#state === undefined || this.#current === undefined) return;
    const conversation = this.#values.get(conversationStream(this.#current)) as ConversationView | undefined;
    const conversations = this.#values.get("conversations") as ConversationSummary[] | undefined;
    const tasks = this.#wanted.has("tasks") ? (this.#values.get("tasks") as TaskGraph | undefined) : undefined;
    this.#update({
      ...(conversation === undefined ? {} : { conversation }),
      ...(conversations === undefined ? {} : { conversations }),
      tasks,
    });
  }

  #update(patch: Partial<DurableView>): void {
    if (this.#state === undefined) return;
    this.#state = { ...this.#state, ...patch };
    if (this.#notifying) return;
    this.#notifying = true;
    // One render per burst of frames, as the in-process view source does.
    queueMicrotask(() => {
      this.#notifying = false;
      for (const listener of this.#listeners) listener();
    });
  }

  #notice(level: Notice["level"], message: string): void {
    if (this.#state === undefined) return;
    this.#update({ notices: [...this.#state.notices, { id: this.#nextNotice++, level, message }].slice(-20) });
  }

  #call<M extends CallMethod>(method: M, args: CallMethods[M]["args"]): Promise<CallMethods[M]["result"]> {
    if (this.#connection === undefined || this.#state?.connection !== "connected") {
      return Promise.reject(new Error("Not connected to the host"));
    }
    const id = this.#nextCall++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#send({ type: "call", id, method, args } as ClientFrame);
    });
  }

  /** Serialized like the in-process controller, so toggles and switches apply in order; failures become notices. */
  #command(operation: () => Promise<unknown>): Promise<void> {
    this.#commands = this.#commands
      .then(operation)
      .then(
        () => {},
        (error: unknown) => this.#notice("error", error instanceof Error ? error.message : String(error)),
      );
    return this.#commands;
  }

  #viewSource(): DurableViewSource {
    return {
      current: () => this.#state!,
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
  }

  #controller(): DurableController {
    const conversationId = (): ConversationId => this.#current!;
    return {
      submit: (text, whenBusy) =>
        this.#command(() => this.#call("submit", { conversationId: conversationId(), text, whenBusy, requestId: crypto.randomUUID() })),
      compact: (instructions) =>
        this.#command(() =>
          this.#call("compact", { conversationId: conversationId(), ...(instructions === undefined ? {} : { instructions }) }),
        ),
      // Not queued: it resolves once the conversation is idle.
      abort: () =>
        this.#call("abort", { conversationId: conversationId() }).then(
          () => {},
          (error: unknown) => this.#notice("error", error instanceof Error ? error.message : String(error)),
        ),
      cycleThinking: () => this.#command(() => this.#call("cycleThinking", { conversationId: conversationId() })),
      setModel: (model) => this.#command(() => this.#call("setModel", { conversationId: conversationId(), model })),
      toggleTasks: () =>
        this.#command(async () => {
          if (this.#wanted.delete("tasks")) {
            this.#send({ type: "unsubscribe", stream: "tasks" });
            this.#values.delete("tasks");
            this.#refresh();
            return;
          }
          this.#wanted.add("tasks");
          const shown = this.#snapshot("tasks");
          this.#send({ type: "subscribe", stream: "tasks" });
          await shown;
        }),
      switchConversation: (id) =>
        this.#command(async () => {
          const next = conversationStream(id);
          const previous = conversationStream(conversationId());
          if (next === previous) return;
          this.#wanted.add(next);
          const shown = this.#snapshot(next);
          this.#send({ type: "subscribe", stream: next });
          await shown;
          this.#current = id;
          this.#wanted.delete(previous);
          this.#values.delete(previous);
          this.#send({ type: "unsubscribe", stream: previous });
          this.#refresh();
        }),
    };
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#update({ connection: "closed" });
    this.#connection?.close();
  }
}
