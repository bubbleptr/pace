# Cloudflare 官方 PiHarness 集成核实

核实日期：2026-10-03。本文记录官方文档、已发布包信息与对应源码；后续本地验证见 [Cloudflare Spike](durable-cloudflare-spike.md)，未调用真实模型或部署云端服务。

## 结论

**Cloudflare Agents SDK 已直接支持 Pi Durable，后续 Spike 应先用官方 `PiHarness`。** 它同时提供 Durable Object SQLite 存储适配和 Lifecycle 唤醒，不需要从头编写 SQLite adapter 与 alarm 调度桥。该能力于 2026-10-02 发布，目前为 Beta；Pi Durable 自身也仍是实验性能力。[官方公告](https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness/)、[Pi 文档](https://developers.cloudflare.com/agents/harnesses/pi/)

## 已发布的包与 API

查询 npm 时，`agents` 最新版为 `0.26.0`。`0.25.0` 首次加入 Pi 集成，`0.26.0` 将 `@earendil-works/pi-durable` 和 `@earendil-works/pi-ai` 的可选 peer dependency 更新为 `^1.0.0`。[0.25.0 release](https://github.com/cloudflare/agents/releases/tag/agents%400.25.0)、[0.26.0 release](https://github.com/cloudflare/agents/releases/tag/agents%400.26.0)、[0.26.0 package.json](https://github.com/cloudflare/agents/blob/agents%400.26.0/packages/agents/package.json)

后续实验的固定版本安装命令：`bun add --exact agents@0.26.0 @earendil-works/pi-durable@1.0.0 @earendil-works/pi-ai@1.0.0`。

主要入口：`agents/harness/pi` 导出 `PiHarness` 和 `openPiSessionStore`；`agents/lifecycle` 导出 `Lifecycle`；`agents/models/pi-ai` 导出 `createAI`，通过 `AI` binding 接入 Workers AI / AI Gateway。

以上入口来自已发布版本的 [package exports](https://github.com/cloudflare/agents/blob/agents%400.26.0/packages/agents/package.json) 与 [Pi 导出源码](https://github.com/cloudflare/agents/blob/agents%400.26.0/packages/agents/src/harness/pi/index.ts)。0.25.0 release note 中出现的 `agents/harnesses/pi` 是复数写法；实际使用的包出口是单数 **`agents/harness/pi`**。

接入方式是 `new PiHarness({ harness: ({ storage, context }) => Harness.open(storage, { models, registry }, context), defaults })`，再调用 `this.lifecycle.use(harness)`。普通 DO 可用 `Lifecycle.install(this).use(harness)`。模型和 Pi extensions 仍由应用配置；官方示例已经展示这两种宿主方式。[版本化使用文档](https://github.com/cloudflare/agents/blob/agents%400.26.0/docs/agents/harnesses/pi.md)、[普通 DO 示例](https://github.com/cloudflare/agents/blob/agents%400.26.0/examples/next/harnesses/pi/src/server.ts)

## 官方已处理的边界

- **SQLite。** `openPiSessionStore` 使用 Pi 的 portable `SqliteStorage`，默认为表和索引增加 `pi_` 前缀。其 async facade 已实现操作排队、事务句柄失效、二进制值转换，以及超出安全整数范围的 bigint 拒绝。事务通过 `storage.transaction(async ...)` 执行。[session-store.ts](https://github.com/cloudflare/agents/blob/agents%400.26.0/packages/agents/src/harness/pi/session-store.ts)
- **恢复与唤醒。** `PiHarness` 为有工作的每个会话创建 Lifecycle job；提交前先安排唤醒，再交给 Pi 接收输入。重新启动时打开存储、恢复根会话并调用 `pi.resume()`。源码默认 heartbeat 为 30 秒，单次等待预算为 10 分钟；超过 60 秒的 generation deferred/retry 等待交给 job 的下次 alarm。[harness.ts](https://github.com/cloudflare/agents/blob/agents%400.26.0/packages/agents/src/harness/pi/harness.ts)
- **提交去重。** `session.submit(input, { operationId })` 将稳定 ID 映射成 Pi 的 request ID；`prompt` 是提交并等待，`wait` 可以重新查询同一操作，`sessions.create/fork/list` 管理 Pi conversations。应用仍要保留自己的请求 ID，并处理回复丢失。[PiHarness 与 PiSession 实现](https://github.com/cloudflare/agents/blob/agents%400.26.0/packages/agents/src/harness/pi/harness.ts)

这取代了先前考虑的自写 adapter 路线。平台边界仍然存在：DO 的 `transactionSync` 不能接 async 回调，SQL 不能直接执行 `BEGIN` / `SAVEPOINT`；alarm 是至少一次执行，因此恢复后的外部副作用仍需依据工具的 replay 语义处理。官方集成已经承担底层适配，不代表所有应用工具自动获得 exactly-once 语义。[SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Alarm API](https://developers.cloudflare.com/durable-objects/api/alarms/)、[工具 replay 说明](https://github.com/cloudflare/agents/blob/agents%400.26.0/docs/agents/harnesses/pi.md#add-tools-and-prompt-sections)

## 现有多端 Spike 仍需对接什么

`PiHarness` 没有规定聊天协议或 UI。`session.events()` 提供 Pi 的初始 snapshot 与后续事件批次，应用负责 WebSocket / HTTP / RPC 转发；对象重建后应重新打开流并发送快照。官方 [可运行示例](https://github.com/cloudflare/agents/tree/agents%400.26.0/examples/next/harnesses/pi) 自行实现了 socket 与 transcript glue。[官方 Pi 文档](https://developers.cloudflare.com/agents/harnesses/pi/)

本仓库已有 [`frames.ts`](../../spikes/durable-multiview/protocol/frames.ts) 的 `hello/snapshot/ops/result` 协议、文档和任务订阅，以及依赖 Node `ws` 的 [`gateway.ts`](../../spikes/durable-multiview/host/gateway.ts)。因此下一次实验需要将宿主入口迁到 DO，并决定保留现有多流协议还是采用官方事件流；不能把两套帧当作直接兼容。官方 `await harness.pi()` 可以取得底层 Harness，为现有文档和任务订阅提供接缝。[源码](https://github.com/cloudflare/agents/blob/agents%400.26.0/packages/agents/src/harness/pi/harness.ts)

执行环境也需要另选：`NodeExecutionEnv` 依赖 `node:child_process`，Workers 的该模块属于不可执行的兼容 stub；Workers 文件系统是虚拟文件系统，不能当成本机工作区。官方例子使用 `@cloudflare/computer` Workspace 和 Dynamic Worker JavaScript backend。这是可参考的云端工具环境，尚未证明可替代 Pace 的本地 shell / checkout。[Node 兼容性](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#non-functional-stub-modules)、[Workers 文件系统](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)、[官方宿主示例](https://github.com/cloudflare/agents/blob/agents%400.26.0/examples/next/harnesses/pi/src/server.ts)

## 当前证据与待验证项

现已增加 [本地 Cloudflare Spike](durable-cloudflare-spike.md)：官方 `PiHarness` 在 workerd 的 SQLite-backed DO 中运行，HTTP 网关验证了提交去重、双观察者及重连快照；专用恢复 fixture 验证了对象崩溃后由 SDK alarm 唤醒，以及 safe / unsafe 工具的不同恢复行为。TypeScript 检查与 Wrangler bundle dry-run 已通过。恢复证据来自专用 fixture，不能当作 HTTP 网关同一实例的 crash 验证。**Pace / Web / TUI 三端接入、真实模型、云端部署和本地执行环境迁移仍未验证。**
