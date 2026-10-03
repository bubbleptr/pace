# PiHarness 在 Cloudflare Durable Objects 上的本地 Spike

日期：2026-10-03。代码位于 [`spikes/durable-cloudflare`](../../spikes/durable-cloudflare)。官方能力与版本核实见 [平台调研](durable-cloudflare-platform.md)。

## 结论与边界

官方 `PiHarness` 可以作为这个本地实验的宿主：它负责把 Pi 状态写入 Durable Object 的 SQLite，并通过 Lifecycle job 与 alarm 恢复未完成工作。实验没有自行实现 SQLite adapter 或 alarm 调度器。

本次运行的是本地 workerd 与 SQLite-backed DO，模型为 Pi 官方 `fauxProvider`，回答形如 `Faux: hello`。HTTP 网关已验证重复提交去重、两个观察者读取同一会话、断线重连得到新快照。专用恢复 fixture 已验证没有客户端请求时，由 SDK alarm 重建对象并恢复工作。

这还没有接入既有 Pace / Web / TUI 三端，没有调用真实 LLM，没有部署 Cloudflare 云端，也没有提供本机 shell、checkout 或完整编程工具环境。专用恢复 fixture 与 HTTP 网关是不同的 Worker 入口；恢复用例不能解释为后者已完成同实例崩溃验证。

## 设计

请求进入 Worker 后先校验 `SPIKE_TOKEN`，再按 URL 中的名称定位 DO。每个名称对应一个 `SessionObject`，它通过 `Lifecycle.install(this).use(harness)` 持有一个官方 `PiHarness`，HTTP API 使用其中的根 Pi session。对外名称如 `demo` 和 Pi 内部根 session ID `1` 是不同层的标识。[宿主代码](../../spikes/durable-cloudflare/src/worker.ts)

`submit` 要求调用者提供稳定 `operationId`，便于回复丢失后用同一 ID 重试。事件流直接转发 `session.events()`：每行是一个 `AgentEvent[]`，第一行包含 snapshot，后续为事件批次。写入流时等待消费者，取消读取时释放 Pi watch；断开观察连接不取消任务。它不是既有多端 Spike 的 `snapshot/ops` 帧协议。

固定依赖为 `agents@0.26.0`、`pi-durable@1.0.0`、`pi-ai@1.0.0`；配置启用 SQLite DO 和 Node 兼容性。具体依赖、命令与 binding 见 [package.json](../../spikes/durable-cloudflare/package.json) 和 [wrangler.jsonc](../../spikes/durable-cloudflare/wrangler.jsonc)。

| HTTP API | 返回内容 |
| --- | --- |
| `POST /sessions/:name/submit` | 接收 `{ input, operationId }`，返回 202 和提交 receipt |
| `GET /sessions/:name/operations/:operationId` | 等待该操作结束，返回结果 |
| `GET /sessions/:name` | `instanceId`、Pi 原始 `messages`、`pending` |
| `GET /sessions/:name/events` | `application/x-ndjson`，逐行事件批次 |

所有入口要求 `Authorization: Bearer <SPIKE_TOKEN>`。未配置 token 返回 503；token 不符返回 401；非法提交返回 400。名称允许 1–64 个字母、数字、下划线或连字符；operation ID 最多 128 个同类字符；输入必须为非空文本且不超过 8000 字符。这是本地实验的共享 token 校验，没有用户身份、按操作授权或生产级公网协议。

## 本地运行：一个宿主，两个观察者

从仓库根目录安装依赖，再启动宿主。下面的 token 仅用于 loopback 本地演示：

```sh
bun install --frozen-lockfile
cd spikes/durable-cloudflare
bun run dev --port 8788 --var SPIKE_TOKEN:local-spike-token
```

`dev` 脚本固定监听 `127.0.0.1`。Wrangler 默认把开发状态写入此目录下的 `.wrangler/state`；重复演示时换一个 session 名称或 operation ID，可避免先前状态干扰。

在终端 A、B 分别运行同一条命令，保持两个观察连接：

```sh
curl --no-buffer \
  -H 'Authorization: Bearer local-spike-token' \
  http://127.0.0.1:8788/sessions/demo/events
```

在终端 C 提交一轮：

```sh
curl -sS \
  -H 'Authorization: Bearer local-spike-token' \
  -H 'Content-Type: application/json' \
  --data '{"input":"hello from terminal C","operationId":"demo-turn-1"}' \
  http://127.0.0.1:8788/sessions/demo/submit
```

首次 receipt 的 `accepted` 为 `true`。随后取结果：

```sh
curl -sS \
  -H 'Authorization: Bearer local-spike-token' \
  http://127.0.0.1:8788/sessions/demo/operations/demo-turn-1
```

结果应为 `status: "done"`，文本为 `Faux: hello from terminal C`。两个观察终端都会收到这一轮的事件。原样重跑提交命令，`accepted` 应为 `false`，不会重复追加用户输入。停止终端 A 的 curl 再重新连接，第一行的新 snapshot 会包含已有记录。

检查当前状态：

```sh
curl -sS \
  -H 'Authorization: Bearer local-spike-token' \
  http://127.0.0.1:8788/sessions/demo
```

`instanceId` 是本次 DO 内存实例的标记，`messages` 是 Pi 原始 entries。只读取该字段不能证明 alarm 恢复成功：读取请求本身也会唤醒对象。

## 验证命令与证据

从仓库根目录运行：

```sh
cd spikes/durable-cloudflare
bun run typecheck
bun run test
bun run build
```

`build` 实际执行 `wrangler deploy --dry-run --outdir dist`，只打包、不上传。本次 typecheck 与 dry-run 均退出 0；dry-run 输出 `Total Upload: 980.73 KiB / gzip: 182.89 KiB`、`SESSIONS (SessionObject)` binding 和 `--dry-run: exiting now.`。这些结果只证明该配置可以检查和打包。

2026-10-03 最终验证：Spike 的 2 个测试文件、6 项测试通过（30.53 秒）；根目录 `bun run typecheck`、`bun run lint`、`bun run test`、`bun run build` 全部退出 0，整仓测试为 168 个文件、1977 项通过。`bun install --frozen-lockfile` 通过。另启动真实 `wrangler dev`，经 HTTP 得到首次 `accepted: true`、`status: done`、重复请求 `accepted: false`，重连快照中用户输入只有一条。

| 实验 | 可支持的结论 | 证据 |
| --- | --- | --- |
| 重复 operation ID、另一客户端取结果 | 同一会话只接收一次用户输入，另一请求可以取得相同结果 | [gateway.test.ts](../../spikes/durable-cloudflare/test/gateway.test.ts) |
| 双事件观察者、断开后重连 | 两个观察者取得相同的已提交消息；重连从新 snapshot 开始 | [gateway.test.ts](../../spikes/durable-cloudflare/test/gateway.test.ts) |
| token 与非法请求 | 被拒绝的请求没有写入该会话 | [gateway.test.ts](../../spikes/durable-cloudflare/test/gateway.test.ts) |
| 替换整个本地 runtime 后重新打开同一持久目录 | 转录保持一致，旧 operation ID 仍去重，不同名称的 DO 状态隔离 | [gateway.test.ts](../../spikes/durable-cloudflare/test/gateway.test.ts) |
| safe 工具执行中崩溃 | 新实例由 alarm 唤醒，工具重跑并完成；用户输入只有一条 | [recovery.test.ts](../../spikes/durable-cloudflare/test/recovery.test.ts) |
| unsafe 工具执行中崩溃 | 新实例恢复后记录工具中断，不再次执行该工具 | [recovery.test.ts](../../spikes/durable-cloudflare/test/recovery.test.ts) |

测试使用 [Miniflare/workerd runtime](../../spikes/durable-cloudflare/test/runtime.ts) 和真实 SQLite DO。恢复专用 [fixture](../../spikes/durable-cloudflare/test/recovery-worker.ts) 让第一次工具调用保持未完成，再用 `ctx.abort()` 杀死对象；独立 witness 接收工具与 alarm 事件。测试等到新 `bootId` 的 alarm 和操作 `completed` 见证后，才发请求读取结果。`lifecycle.alarm()` 返回只代表已安排后台工作，不能单凭返回判断任务完成。它使用 SDK 默认约 30 秒 heartbeat，没有通过修改内部计时器加速；运行测试需要等待这一真实时间窗口。

测试环境固定使用 Miniflare 5：官方 `convertV4MiniflareOptions()` 转换 Worker 配置，但持久目录必须直接设置在新 API 的 `resourcePersistencePath` 上；旧 `durableObjectsPersist` 会被转换器丢弃。不启用 shared storage 时，单独传 `isolatedResourcePersistencePath` 也会被默认根路径覆盖。整个 runtime 重建测试专门验证了此配置实际保留数据。

上述通过的是本地实验边界，不代表跨区域故障、云端计费、真实模型流、Pace 协议兼容或外部副作用的 exactly-once 已验收。接下来若扩展实验，可先接入真实 provider，再选择如何把官方事件流映射到现有多端客户端。
