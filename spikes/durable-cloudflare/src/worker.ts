import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";

export interface Env {
  SESSIONS: DurableObjectNamespace<SessionObject>;
  SPIKE_TOKEN: string;
}

export class SessionObject extends DurableObject<Env> {
  readonly instanceId = crypto.randomUUID();
  private readonly faux = fauxProvider({ tokensPerSecond: 200 });
  readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
      const faux = this.faux;
      const respond: FauxResponseFactory = (transcript) => {
        faux.appendResponses([respond]);
        const input = transcript.messages.findLast((message) => message.role === "user");
        const text = typeof input?.content === "string" ? input.content
          : input?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
        return fauxAssistantMessage(`Faux: ${text}`);
      };
      faux.setResponses([respond]);
      const models = createModels();
      models.setProvider(faux.provider);
      return Harness.open(storage, { models, registry: createRegistry() }, context);
    },
    defaults: { model: this.faux.getModel() },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.split("/");
    if (request.method === "GET" && path[3] === "events") {
      const events = await this.harness.session().events();
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      const encoder = new TextEncoder();
      const send = (batch: unknown) => writer.write(encoder.encode(`${JSON.stringify(batch)}\n`));
      // Await writes so Pi can replace queued batches with a snapshot for a slow reader.
      this.ctx.waitUntil((async () => {
        try {
          await send([events.snapshot]);
          events.start(send);
          await events.closed;
          await writer.close();
        } catch (error) {
          await writer.abort(error);
        } finally {
          await events.stop();
        }
      })());
      // Reader cancellation must release the Pi watch, without aborting the agent's work.
      this.ctx.waitUntil(writer.closed.then(() => events.stop(), () => events.stop()));
      return new Response(stream.readable, {
        headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
      });
    }
    if (request.method === "POST" && path[3] === "submit") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      if (!body || typeof body !== "object" || !("input" in body) || typeof body.input !== "string"
        || !body.input.trim() || body.input.length > 8000 || !("operationId" in body)
        || typeof body.operationId !== "string" || !/^[\w-]{1,128}$/.test(body.operationId)) {
        return new Response("Expected input (1–8000 characters) and operationId (letters, digits, _, -)", { status: 400 });
      }
      return Response.json(await this.harness.submit(body.input, { operationId: body.operationId }), { status: 202 });
    }
    if (request.method === "GET" && path[3] === "operations" && path[4]) {
      return Response.json(await this.harness.wait(path[4], { signal: request.signal }));
    }
    if (request.method === "GET" && path.length === 3) {
      return Response.json({
        instanceId: this.instanceId,
        messages: await this.harness.messages(),
        pending: await this.harness.pending(),
      });
    }
    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.SPIKE_TOKEN) return new Response("Set SPIKE_TOKEN before starting the spike", { status: 503 });
    if (request.headers.get("authorization") !== `Bearer ${env.SPIKE_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    const path = new URL(request.url).pathname.split("/");
    if (path[1] !== "sessions" || !/^[\w-]{1,64}$/.test(path[2] ?? "")) {
      return new Response("Not found", { status: 404 });
    }
    return env.SESSIONS.getByName(path[2]).fetch(request);
  },
};
