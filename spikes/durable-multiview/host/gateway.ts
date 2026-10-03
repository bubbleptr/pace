import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  type AgentState,
  type Conversation,
  type ConversationDocToken,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
  type JsonObject,
  ROOT_CONVERSATION_ID,
  type WatchHandle,
} from "@earendil-works/pi-durable";
import { WebSocket, WebSocketServer } from "ws";
import type { ApprovalDecision, PendingApproval } from "../protocol/demo.ts";
import {
  type CallMethod,
  type CallMethods,
  type ClientFrame,
  isClientFrame,
  type ServerFrame,
  type StreamName,
  UNAUTHORIZED_CLOSE_CODE,
} from "../protocol/frames.ts";
import type { ConversationSummary, ModelSummary, Notice, SessionInfo } from "../protocol/view.ts";

const context: Context = BACKGROUND_CONTEXT;

/** Tool calls held for a human decision, and the way to decide them. */
export interface ApprovalSource {
  readonly value: readonly PendingApproval[];
  subscribe(listener: (pending: readonly PendingApproval[]) => void): () => void;
  decide(conversationId: ConversationId, id: string, approved: boolean, by: string): Promise<{ decision: ApprovalDecision; first: boolean }>;
}

export interface GatewayOptions {
  readonly harness: Harness;
  readonly models: Models;
  readonly modelSummaries: () => readonly ModelSummary[];
  readonly session: SessionInfo;
  readonly token: string;
  readonly port: number;
  /** Exact browser origins permitted to connect. Native clients send no Origin. */
  readonly browserOrigins?: readonly string[];
  readonly approvals?: ApprovalSource;
  /** Conversation documents offered as `doc:<kind>:<conversationId>` streams. */
  readonly docs?: readonly ConversationDocToken<JsonObject>[];
}

export interface Gateway {
  readonly url: string;
  /** Tell every client, for example a Harness report. */
  broadcast(level: Notice["level"], message: string): void;
  close(): Promise<void>;
}

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const conversations = await ConversationList.open(options.harness);
  const server = new WebSocketServer({ host: "127.0.0.1", port: options.port });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const clients = new Set<GatewayClient>();
  server.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    socket.on("error", () => socket.terminate());
    const token = new URL(request.url ?? "/", "ws://127.0.0.1").searchParams.get("token");
    const origin = request.headers.origin;
    if (token !== options.token || (origin !== undefined && !options.browserOrigins?.includes(origin))) {
      socket.close(UNAUTHORIZED_CLOSE_CODE, "unauthorized");
      return;
    }
    const client = new GatewayClient(socket, options, conversations);
    clients.add(client);
    socket.once("close", () => {
      clients.delete(client);
      void client.dispose();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    broadcast: (level, message) => {
      for (const client of clients) client.send({ type: "notice", level, message });
    },
    async close() {
      conversations.dispose();
      await Promise.all([...clients].map((client) => client.dispose()));
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The conversation list, kept from commit publications as the in-process TUI keeps it. */
class ConversationList {
  readonly #listeners = new Set<(list: readonly ConversationSummary[]) => void>();
  #list: readonly ConversationSummary[];
  #unsubscribe: () => void = () => {};
  #notifying = false;

  private constructor(list: readonly ConversationSummary[]) {
    this.#list = list;
  }

  static async open(harness: Harness): Promise<ConversationList> {
    const summaries: ConversationSummary[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), context);
      for (const record of page.items) summaries.push({ id: record.id, label: labelOf(record), ...(await firstInput(harness, record.id)) });
      cursor = page.next;
    } while (cursor !== undefined);
    const list = new ConversationList(summaries);
    // A commit listener only records; it calls no Session API.
    list.#unsubscribe = harness.subscribeCommits((publication) => {
      let next = list.#list;
      for (const change of publication.changes) {
        if (change.type === "conversation") {
          next = [...next, { id: change.value.id, label: labelOf(change.value) }];
        } else if (change.type === "entry" && change.value.kind === "pi.user") {
          const id = change.value.conversationId;
          next = next.map((summary) => (summary.id === id && summary.title === undefined ? { ...summary, ...titleOf(change.value) } : summary));
        }
      }
      if (next !== list.#list) list.#set(next);
    });
    return list;
  }

  get value(): readonly ConversationSummary[] {
    return this.#list;
  }

  subscribe(listener: (list: readonly ConversationSummary[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(list: readonly ConversationSummary[]): void {
    this.#list = list;
    if (this.#notifying) return;
    this.#notifying = true;
    setImmediate(() => {
      this.#notifying = false;
      for (const listener of this.#listeners) listener(this.#list);
    });
  }

  dispose(): void {
    this.#unsubscribe();
    this.#listeners.clear();
  }
}

function labelOf(record: ConversationRecord): string {
  if (record.id === ROOT_CONVERSATION_ID) return "main";
  if (record.owner !== undefined) return `subagent ${record.id}`;
  return record.parent === undefined ? `conversation ${record.id}` : `fork ${record.id}`;
}

function titleOf(entry: EntryRecord | undefined): { title?: string } {
  const message = entry?.model?.[0];
  if (message?.role !== "user") return {};
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
  return { title: text.replace(/\s+/g, " ").trim() };
}

/**
 * The oldest user message of a conversation, a subagent's task. Unlike upstream, main gets
 * one too: the commit listener titles it live, and a restarted host must list the same.
 * A fork's own first message, not one it inherits, as the listener sees it.
 */
async function firstInput(harness: Harness, id: ConversationId): Promise<{ title?: string }> {
  const conversation = (await harness.conversation(id, context))!;
  let first: EntryRecord | undefined;
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, 256, cursor, context);
    first = page.items.findLast((entry) => entry.kind === "pi.user" && entry.conversationId === id) ?? first;
    cursor = page.next;
  } while (cursor !== undefined);
  return titleOf(first);
}

type Subscription = { stop(): Promise<unknown> | void };
type SubscriptionState = { subscription?: Subscription };
type SendFrame = (frame: ServerFrame) => Promise<void>;

class GatewayClient {
  readonly #socket: WebSocket;
  readonly #options: GatewayOptions;
  readonly #conversations: ConversationList;
  readonly #subscriptions = new Map<StreamName, SubscriptionState>();
  #disposed = false;

  constructor(socket: WebSocket, options: GatewayOptions, conversations: ConversationList) {
    this.#socket = socket;
    this.#options = options;
    this.#conversations = conversations;
    socket.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        socket.close(1008, "Invalid client frame");
        return;
      }
      if (!isClientFrame(frame)) {
        socket.close(1008, "Invalid client frame");
        return;
      }
      void this.#receive(frame).catch(() => socket.close(1011, "Gateway request failed"));
    });
    this.send({
      type: "hello",
      session: options.session,
      root: ROOT_CONVERSATION_ID,
      models: options.modelSummaries(),
      docs: (options.docs ?? []).map((token) => token.definition.kind),
    });
  }

  /** Resolves once the frame is handed to the socket, so a watch callback holds its next frame until then. */
  send(frame: ServerFrame): Promise<void> {
    if (this.#socket.readyState !== WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => this.#socket.send(JSON.stringify(frame), () => resolve()));
  }

  async #receive(frame: ClientFrame): Promise<void> {
    if (frame.type === "subscribe") await this.#subscribe(frame.stream);
    else if (frame.type === "unsubscribe") await this.#unsubscribe(frame.stream);
    else await this.#answer(frame.id, frame.method, frame.args);
  }

  async #subscribe(stream: StreamName): Promise<void> {
    const previous = this.#subscriptions.get(stream);
    const state: SubscriptionState = {};
    this.#subscriptions.set(stream, state);
    const current = () => !this.#disposed && this.#subscriptions.get(stream) === state;
    const send: SendFrame = (frame) => (current() ? this.send(frame) : Promise.resolve());
    let subscription: Subscription;
    try {
      await previous?.subscription?.stop();
      if (!current()) return;
      subscription = await this.#open(stream, send);
    } catch (error) {
      if (current()) {
        await send({ type: "ended", stream, reason: error instanceof Error ? error.message : String(error) });
        if (current()) this.#subscriptions.delete(stream);
      }
      return;
    }
    // An obsolete watch can finish acquiring after its replacement has already opened.
    if (!current()) {
      await subscription.stop();
      return;
    }
    state.subscription = subscription;
  }

  async #open(stream: StreamName, send: SendFrame): Promise<Subscription> {
    if (stream === "conversations") {
      void send({ type: "snapshot", stream, value: this.#conversations.value });
      const unsubscribe = this.#conversations.subscribe((value) => void send({ type: "snapshot", stream, value }));
      return { stop: unsubscribe };
    }
    if (stream === "approvals") {
      const approvals = this.#options.approvals;
      void send({ type: "snapshot", stream, value: approvals?.value ?? [] });
      const unsubscribe = approvals?.subscribe((value) => void send({ type: "snapshot", stream, value })) ?? (() => {});
      return { stop: unsubscribe };
    }
    if (stream === "tasks") return this.#forward(stream, await this.#options.harness.watchTaskGraph(context), send);
    if (stream.startsWith("doc:")) {
      const at = stream.lastIndexOf(":");
      return this.#openDoc(stream, stream.slice("doc:".length, at), Number(stream.slice(at + 1)) as ConversationId, send);
    }
    const conversation = await this.#conversation(Number(stream.slice("conversation:".length)) as ConversationId);
    return this.#forward(stream, await conversation.watch(context), send);
  }

  /** A document that does not exist yet streams `null`, then its value from the commit that creates it. */
  async #openDoc(stream: StreamName, kind: string, id: ConversationId, send: SendFrame): Promise<Subscription> {
    const token = this.#options.docs?.find((candidate) => candidate.definition.kind === kind);
    if (token === undefined) throw new Error(`Unknown document ${kind}`);
    await this.#conversation(id);
    const { harness } = this.#options;
    let signalCreation!: () => void;
    const created = new Promise<void>((resolve) => {
      signalCreation = resolve;
    });
    let inner: Subscription | undefined;
    let stopped = false;
    // Observe creation before probing absence, so a commit cannot fall between the two.
    const unsubscribe = harness.subscribeCommits((publication) => {
      const matches = publication.changes.some(
        (change) => (change.type === "document" || change.type === "document.copy") && change.record.kind === kind && change.conversationId === id,
      );
      if (!matches) return;
      unsubscribe();
      // A commit listener must not call Session APIs; attach after it returns.
      setImmediate(() => signalCreation());
    });
    try {
      const existing = await harness.watchDoc(token, id, context);
      if (existing !== undefined) {
        unsubscribe();
        return this.#forward(stream, existing, send);
      }
      await send({ type: "snapshot", stream, value: null });
    } catch (error) {
      unsubscribe();
      throw error;
    }
    void created
      .then(async () => {
        if (stopped) return;
        const watch = await harness.watchDoc(token, id, context);
        if (watch === undefined) return;
        if (stopped) await watch.stop();
        else {
          inner = await this.#forward(stream, watch, send);
          if (stopped) await inner.stop();
        }
      })
      .catch((error: unknown) => {
        unsubscribe();
        return send({ type: "ended", stream, reason: error instanceof Error ? error.message : String(error) });
      });
    return {
      stop: async () => {
        stopped = true;
        unsubscribe();
        signalCreation();
        await inner?.stop();
      },
    };
  }

  async #forward<T>(stream: StreamName, watch: WatchHandle<T>, send: SendFrame): Promise<Subscription> {
    await send({ type: "snapshot", stream, value: watch.value });
    watch.start((_value, ops) => send({ type: "ops", stream, ops }));
    return watch;
  }

  async #unsubscribe(stream: StreamName): Promise<void> {
    const subscription = this.#subscriptions.get(stream);
    this.#subscriptions.delete(stream);
    await subscription?.subscription?.stop();
  }

  async #conversation(id: ConversationId): Promise<Conversation> {
    const conversation = await this.#options.harness.conversation(id, context);
    if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`);
    return conversation;
  }

  async #answer(id: number, method: CallMethod, args: CallMethods[CallMethod]["args"]): Promise<void> {
    try {
      const value = await this.#call(method, args);
      await this.send({ type: "result", id, ok: true, value: value ?? null });
    } catch (error) {
      await this.send({ type: "result", id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async #call(method: CallMethod, args: CallMethods[CallMethod]["args"]): Promise<unknown> {
    const conversation = await this.#conversation(args.conversationId);
    switch (method) {
      case "submit": {
        const { text, whenBusy, requestId } = args as CallMethods["submit"]["args"];
        const submission = await conversation.submit({ type: "input", content: text, whenBusy, requestId }, context);
        void submission.wait(context).then(
          (settled) => {
            if (settled.status === "unanswered" && settled.reason !== "aborted") {
              void this.send({ type: "notice", level: "error", message: `No answer: ${settled.reason}` });
            }
          },
          () => {},
        );
        return { submissionId: submission.id };
      }
      case "abort":
        await conversation.abort(context);
        return null;
      case "compact": {
        const { instructions } = args as CallMethods["compact"]["args"];
        const taskId = await conversation.compact(instructions, context);
        void this.#options.harness.waitForTask(taskId, context).then(
          (receipt) => void this.send({ type: "notice", level: "info", message: `Compaction ${receipt.state.outcome.status}.` }),
          () => {},
        );
        return { taskId };
      }
      case "setModel": {
        const { model: ref } = args as CallMethods["setModel"]["args"];
        const model = this.#options.models.getModel(ref.provider, ref.modelId);
        if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
        const thinking: ModelThinkingLevel = (await this.#agent(conversation.id)).thinkingLevel ?? "off";
        await conversation.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, context);
        return null;
      }
      case "cycleThinking": {
        const agent = await this.#agent(conversation.id);
        const model = agent.model === undefined ? undefined : this.#options.models.getModel(agent.model.provider, agent.model.modelId);
        if (model === undefined) throw new Error("No model selected");
        if (!model.reasoning) throw new Error("Current model does not support thinking");
        const levels = getSupportedThinkingLevels(model);
        const level = agent.thinkingLevel ?? "off";
        await conversation.configure({ thinkingLevel: levels[(levels.indexOf(level) + 1) % levels.length] ?? "off" }, context);
        return null;
      }
      case "approve": {
        const { approvalId, approved, by } = args as CallMethods["approve"]["args"];
        if (this.#options.approvals === undefined) throw new Error("This host has no approvals");
        return this.#options.approvals.decide(conversation.id, approvalId, approved, by);
      }
      case "fork": {
        const { entryId, removeTools = [] } = args as CallMethods["fork"]["args"];
        // Tools are stored by name; the fork's agent drops these from what its parent offered.
        const remove = (await conversation.agent(context)).tools.filter((tool) => removeTools.includes(tool.name));
        const fork = await conversation.fork(
          Number(entryId) as EntryId,
          { ownership: { kind: "ownerless" }, ...(remove.length === 0 ? {} : { agent: { tools: { remove } } }) },
          context,
        );
        return { conversationId: fork.id };
      }
    }
  }

  async #agent(id: ConversationId): Promise<Readonly<AgentState>> {
    return (await this.#options.harness.snapshot(AgentDoc, id, context)) ?? {};
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const subscriptions = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    for (const state of subscriptions) await state.subscription?.stop();
  }
}
