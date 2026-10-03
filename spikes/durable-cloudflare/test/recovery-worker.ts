import { DurableObject } from "cloudflare:workers";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";

interface Env {
  SESSIONS: DurableObjectNamespace;
  WITNESS: Fetcher;
}

export class SessionObject extends DurableObject<Env> {
  private readonly bootId = crypto.randomUUID();
  private readonly lifecycle = Lifecycle.install(this);
  private readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
      const faux = fauxProvider({ models: [{ id: "recovery" }], tokensPerSecond: 100_000 });
      faux.setResponses(Array.from({ length: 8 }, () => (transcript) => {
        const result = transcript.messages.findLast((message) => message.role === "toolResult");
        if (result?.role === "toolResult") {
          return fauxAssistantMessage(result.isError ? "Interrupted tool was not replayed." : "Recovered safely.");
        }
        const user = transcript.messages.findLast((message) => message.role === "user");
        if (!user || typeof user.content !== "string") throw new Error("Missing recovery input");
        const input = JSON.parse(user.content) as { operationId: string; replay: "safe" | "unsafe" };
        return fauxAssistantMessage(fauxToolCall(`gate_${input.replay}`, { operationId: input.operationId }), { stopReason: "toolUse" });
      }));
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      registry.install(defineExtension({
        name: "recovery-fixture",
        tools: (["safe", "unsafe"] as const).map((replay) => defineTool({
          name: `gate_${replay}`,
          description: "Wait until the host is killed, then report recovery.",
          parameters: Type.Object({ operationId: Type.String() }),
          replay,
          execute: async ({ operationId }) => {
            const response = await this.report("tool", operationId);
            const { attempt } = await response.json() as { attempt: number };
            // The external witness survives eviction; the first invocation never completes.
            if (attempt === 1) return new Promise<never>(() => {});
            return { content: [{ type: "text" as const, text: "Gate completed after recovery." }] };
          },
        })),
      }));
      return Harness.open(storage, { models, registry }, context);
    },
    defaults: { model: { provider: "faux", id: "recovery" } },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.harness);
  }

  private report(kind: string, operationId: string): Promise<Response> {
    return this.env.WITNESS.fetch("http://witness/event", {
      method: "POST",
      body: JSON.stringify({ kind, operationId, bootId: this.bootId }),
    });
  }

  async onStart(): Promise<void> {
    const operationId = await this.ctx.storage.get<string>("operationId");
    if (operationId) {
      // Startup must release its input gate before recovered tools can perform I/O.
      this.ctx.waitUntil(this.harness.wait(operationId).then(() => this.report("completed", operationId)));
    }
  }

  async alarm(): Promise<void> {
    const operationId = await this.ctx.storage.get<string>("operationId") ?? "not-submitted";
    await this.report("alarm", operationId);
    await this.lifecycle.alarm();
    await this.report("alarm-complete", operationId);
  }

  async onRequest(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split("/").at(-1);
    if (action === "submit") {
      const input = await request.json() as { operationId: string; replay: "safe" | "unsafe" };
      await this.ctx.storage.put("operationId", input.operationId);
      return Response.json(await this.harness.submit(JSON.stringify(input), { operationId: input.operationId }), { status: 202 });
    }
    if (action === "crash") this.ctx.abort("Intentional recovery fixture crash");
    if (action === "result") {
      const operationId = await this.ctx.storage.get<string>("operationId");
      if (!operationId) return new Response("Missing operation", { status: 404 });
      const result = await this.harness.wait(operationId);
      const messages = await this.harness.messages();
      const toolErrors = messages.filter(ToolResultEntry.is).flatMap((entry) =>
        entry.model?.flatMap((message) => message.role === "toolResult" && message.isError ? [message.content] : []) ?? []);
      return Response.json({ ...result, userEntries: messages.filter(UserEntry.is).length, toolErrors });
    }
    return new Response("Not found", { status: 404 });
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).pathname.split("/")[1]!;
    return env.SESSIONS.get(env.SESSIONS.idFromName(name)).fetch(request);
  },
};
