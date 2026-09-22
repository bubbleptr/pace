# Spike：Pi 的 chord 包对 Pace 插件 GUI 的影响

- 日期：2026-09-20
- 状态：调研 + 可运行 spike，不是决策记录
- 代码：`packages/backend/src/drivers/chord-plugin-spike.ts` 与同名 `.test.ts`（分支 `chore/chord-plugin-gui-spike`）
- 关联：README「Extensibility」路线图第 1 条（Extension Surface 协议）、ADR-0018、ADR-0031、`.scratch/extension-host-contract/HANDOFF.md`

## 1. 一句话结论

chord 就是 Pi 官方正在做的「插件多宿主运行时」：一个插件拆成 `session` facet（跟着 agent 跑）和 `tui` facet（跟着 UI 跑），两者只共享 `contract.ts` 里的 service token，靠 replicated state + JSON RPC 通信。GUI 在 Pi 的设计里就是一种 presentation host（文档明写 "TUI A / web B"）。Pace 不需要发明自己的 Extension Surface 协议，应该把自己做成 chord 的 presentation host。spike 已证明：只用 chord 公开的 wire API，走 Pace 现有的 JSON IPC，不引入 pi-server / pi-client / pi-protocol，就能让 presentation facet 拿到 session facet 的状态并调用其方法。

## 2. chord 是什么（0.86.0 已随 pi-coding-agent 安装）

| 概念 | 含义 | 对 Pace 的意义 |
|---|---|---|
| Facet | 插件的一个入口，`defineFacet({ id, setup(env) })`，setup 同步声明 `use / provide / replicatedState / onActivate / own` | 一个插件包可以同时带 `session.ts` 和 `tui.ts`；未来加一个 GUI 入口只是多一个约定文件名 |
| Service | `defineService<T>(id)`，成员只能是 `ReplicatedState<Json>` 或 `(...json, Context) => Promise<Json>`；`{ local: true }` 的永不上线 | 这就是 Pace 期望的「插件面板契约」，且类型层面强制 JSON |
| Replicated state | 生产者改 `state` 代理后 `publish(ctx)`，消费者收到完整不可变值；delta 编码由 chord 负责 | 面板状态同步不用 Pace 再设计增量协议 |
| FacetHost | `createFacetHost({ facets, serviceSources })`，校验依赖图、hydrate 远端服务、按依赖序激活，支持 `reload()` 热替换 | Pace 的渲染进程 / 后端都可以各起一个 host |
| RemoteServiceTransport | 只需实现 `invoke(call)` 和 `subscribe(serviceId, mode, listener)`，framing / 路由 / 传输由应用自选 | Pace 可以复用 `session-process-protocol.ts` 的 JSON 通道 |
| Bundler / Node loader | `bundleFacetPackage` 用 esbuild 把每个 facet 打成独立 `.cjs`，`createFacetBundleLoader` 用 `node:vm` 加载并校 SHA-256 | 加载器是 Node-only；浏览器端（Electron renderer）需要另一条加载路径 |

运行时部分（`@earendil-works/chord` 根入口）没有任何 `node:` import，可以直接跑在 renderer 里。

## 3. Pi 上游现状（origin/main @ 3390bd9，2026-09-20）

- **稳定路径没变。** 0.86 的 `pi-coding-agent` 稳定 API（Pace 走的 `createAgentSession`、扩展加载器）完全不碰 chord。Pace 现有的 SDK driver 不受影响。
- **实验路径已成型。** `PI_EXPERIMENTAL=1 pi server / pi client` 走 server → session worker → presentation 三层拓扑。presentation 侧内置服务：`AgentController`（prompt / steer / abort / compact / navigate）、`Transcript`（replicated state）、`Models`、`SlashCommands`（local）、`PresentationUI`（local，仅 `select` + `showStatus`）。插件公开 API 只导出 `@earendil-works/pi-coding-agent/experimental/plugin`，**npm 包不含 `dist/experimental`**，所以 Pace 今天无法 import 这些 token，只能自己重新 `defineService` 同名 id。
- **插件入口约定是 `src/session.ts` + `src/tui.ts`**（`DEFAULT_PLUGIN_FACETS`），server 把 `tui` 产物随 attach 下发给 client。没有 `web` / `gui` 入口。GUI 入口需要上游加一个约定名，或 Pace 在自己的 host 里用 `chord.facets` 读自定义键。
- **pico3 / Pico5** 是另一条并行线（新 harness），也用 chord 暴露 `PicoConversationService`；文档里的 canvas / diff-review 例子就是「插件在 GUI 里画面板」的目标形态。
- **facets.md 设计稿明确 GUI 是 presentation host**，并且讨论了 web 端的隔离（iframe per facet 作为升级路径）、slot 独占声明（`slots.claim("footer")` 重复即装配错误）、mount 由宿主管理。这些和 Pace 的 Session Dock surface registry（`provider` 字段）几乎一一对应。

## 4. Spike 做了什么

`chord-plugin-spike.ts` 只有两个适配器，分别是 pi-server 和 pi-client 围绕 chord 那一圈逻辑的最小版本：

- `serveChordFacetHost(host, port)`：会话进程侧。`createRemoteServiceEndpoint(host.services)` 处理调用；订阅时用 `createServiceStateEncoder` 编码快照，之后每次 publish 用同一个 encoder 编码 delta；订阅响应发出前到达的更新先扣住，保证消费者先看到快照。
- `createChordPortTransport(port)`：presentation 侧。实现 `RemoteServiceTransport`，每个订阅一个 decoder；快照到达前的 delta 先排队，`activate()` 前的 delta 也排队。
- `createChordPortServiceSource(transport)`：让上面的 transport 成为 `createFacetHost` 的 `serviceSources`。
- `createJsonMessagePortPair()`：内存版 IPC，每条消息 `JSON.parse(JSON.stringify())` 再异步投递，模拟 `child_process` 的 json 序列化。

测试三条全过（`bun run typecheck` 与全量 `bun run test` 142 文件 / 1609 用例同样绿）：

1. presentation host 激活前，远端 replicated state 已 hydrate（`progress.value` 立即可读）。
2. presentation 调 `advance()` 得到返回值；session 侧 `publish` 后 presentation 副本与订阅者都收到 `[0, 2, 5]` 三个版本。
3. 线上所有消息 `isJsonValue()` 为真，且只有 `chord_call / chord_result / chord_update` 三种。

## 5. 对 Pace 的影响判断

**可以直接采纳的：**

- 把 README 路线图第 1 条「Extension Surface 协议」重新定义为「Pace 成为 chord presentation host」。契约层、状态同步、RPC、热重载都由 chord 提供，Pace 只需实现 transport 适配器 + slot/surface 挂载。
- Transport 落点就是现有的 `session-process-protocol.ts`：在 `SessionProcessMessage` 联合类型上加上面三种消息即可，session facet 在会话子进程里的 `FacetHost` 中运行，与 Pi 会话同进程。
- 这同时回应了 `extension-host-contract/HANDOFF.md` 的问题：「宿主向扩展暴露能力」在 chord 里就是宿主 `provide` 一个 service（例如 Pace 自己的 `SessionSpawner`），不再需要 `globalThis` Symbol 注册表。

**还没解决、需要下一步设计的：**

1. **renderer 侧如何加载 facet 代码。** chord 的 loader 是 `node:vm`。Electron renderer 需要：a) 在 backend 加载 presentation facet，把 UI 抽象成 DTO 推给 React（安全，但插件写不了真正的 React 组件）；或 b) renderer 用 `<script type=module>` / iframe 加载 esbuild 产物（facets.md 里的 iframe 升级路径）。这是 spike 之后最大的开放问题。
2. **Pace 对插件提供哪些 presentation 服务。** 对标 pi 的 `AgentController / Transcript / PresentationUI`，Pace 的版本应该是 Runtime Gateway 已有能力的投影，再加 Session Dock 的 `slots.claim / add`。
3. **上游依赖。** 内置 token（`pi.agent-controller` 等）的 id 和类型今天不可 import。要么等 `experimental/plugin` 进 dist，要么 Pace 与上游对齐一份 contract 包。同时需要推动一个 GUI 入口约定名（如 `src/web.ts`）。
4. **信任模型。** 项目目录里的插件代码会在用户的 GUI 进程执行，facets.md 也把这列为 ship 前必须解决的开放决策。
5. **版本耦合。** chord 0.86 明确写着 "not a stable public API contract yet"，接口还在变（0.85 → 0.86 换了 delta tracker）。Pace 应把 chord 适配器隔离在一个模块里，随 Pi 锁版本一起升级。

## 6. 建议的下一步

- 把本文提炼成 ADR 草案：「Pace 作为 chord presentation host」替代自研 Extension Surface 协议。
- 第二个 spike：在真实 `session-process-driver` 里跑一个 `session.ts` facet，presentation host 放在 backend，验证 fork IPC 而不是内存管道。
- 在 pi 上游开 issue 询问 GUI 入口约定与 `experimental/plugin` 的发布计划。

## 7. Spike 2（2026-09-21）：真实 fork 子进程 + 与驱动协议共用 IPC

代码：`chord-plugin-spike-process.test.ts`、`fixtures/chord-session-process.mjs`、`chord-plugin-spike-demo.ts`（共享 token 与 session facet），`chord-plugin-spike.ts` 新增 `createChildProcessChordPort` / `createParentProcessChordPort`（只转发 `kind` 以 `chord_` 开头的消息）。

做法：子进程同时运行真实的 `serveSessionProcess`（假 driver）和一个承载 demo session facet 的 `FacetHost`，两者共用 `process` IPC；父进程（backend 角色）起 presentation host，并在同一通道上发一条 `createSession` 驱动请求。

结果（复核：2 文件 4 用例通过，`bun run typecheck` 通过，全量 143 文件 1610 用例通过）：

- hydrate、RPC、delta 推送与驱动回复在同一通道并行到达，快照先于 delta 的顺序保持。
- fork 默认 `json` 序列化与内存管道的 `JSON.parse(JSON.stringify())` 等价，没有观察到乱序。
- 跨进程比内存慢约一个数量级（约 120ms 对约 7ms 的用例耗时），对面板场景可接受。
- 关闭顺序：先 dispose presentation host 与 transport，再发 `dispose` 让子进程退出；反过来 unsubscribe 会挂在已死的 IPC 上。

接入生产前必须处理的两点（已写入 ADR-0042 阶段 A）：

1. `session-process-server.ts` 无条件解构 `{ id, method, args }`，每个 `chord_call` 都会回一帧 `Unsupported Session command: undefined`，且数字 id 会与驱动请求撞车。要按 `kind` 分流或分离 id 空间。
2. Node 只把 listen 之前的 IPC backlog 冲给第一个 `message` handler，而 `createFacetHost` 是异步的。子进程入口必须同步注册分流 handler 并缓冲，或由 driver 在会话建立后才开放 chord 流量。spike 用 `spike_ready` 握手绕过，这不是生产协议。

## 8. Spike 3（2026-09-22）：renderer 侧 presentation host、backend 只做转发、热重载

代码：`chord-plugin-spike.ts` 新增 `createMessagePortChordPort`、`relayChordFrames`；测试为 `chord-plugin-spike-browser.test.ts`、`chord-plugin-spike-relay.test.ts`、`chord-plugin-spike-reload.test.ts`；fork 用例的 `waitFor` / `waitForSpikeReady` / `waitForDriverResult` / `disposeChild` 抽到 `chord-plugin-spike-test-helpers.ts`。根 `devDependencies` 增加 `esbuild@0.28.2`，只为下面的浏览器打包探测。`fixtures/chord-session-process.mjs` 未改。热重载两条用例连续跑了 3 次，断言结果相同。

复核：`bunx vitest run packages/backend/src/drivers/chord-plugin-spike` 5 文件 9 用例通过，`bun run typecheck` 通过，全量 `bun run test` 146 文件 1615 用例通过。

### Q1. chord 运行时能否进浏览器

esbuild 配置：`platform: "browser"`、`bundle: true`、`format: "esm"`、`write: false`、不设 external。入口同时 import `@earendil-works/chord` 与 `@earendil-works/chord/context`，并导出 `createFacetHost`、`defineFacet`、`BACKGROUND_CONTEXT`。包自己写了 `sideEffects: false`，不导出的话运行时会被 tree-shake 掉，探测就没有意义。

构建成功。产物 124987 字节，全文没有 `node:`。

vitest 默认环境是 jsdom，不能在这个环境里直接 `import "esbuild"`：jsdom 换过的 `TextEncoder` 和 `Uint8Array` 不在同一个 realm，esbuild 在 `lib/main.js` 的启动检查（`instanceof Uint8Array`）里直接抛错，打包还没开始。测试把 esbuild 放进一个不带 `NODE_OPTIONS` 的 Node 子进程；chord 运行时如果真的 import 了 `node:`，这个构建仍然会失败。实测没有失败。

同一文件里另有一条用例：`typeof window !== "undefined"` 时 `defineFacet` + `createFacetHost` 能激活并 dispose。jsdom 用例约 1ms。打包用例在 esbuild 二进制已缓存时约 105ms，第一次冷启动约 1.8s。

### Q2. 三跳：子进程 session facet，backend 纯转发，renderer 侧 presentation host

子进程仍是 spike 2 的 fixture。`relayChordFrames` 只看 `kind` 是否以 `chord_` 开头，不读 call / update 的内容。renderer 侧是 Node `MessageChannel` 的一端（`postMessage` / `on("message")`，用完 `unref` 并 `close`），上面跑 `createChordPortTransport` + presentation `FacetHost`。

结果（relay 用例约 124ms；同一次里原来的 fork 用例约 121ms）：

- 激活后、调用前，`progress.value` 是 `{ step: 0, label: "idle" }`。
- `advance({ by: 2 })` 返回 `{ step: 2 }`，再 `advance({ by: 3 })`，订阅者序列是 `[0, 2, 5]`。
- 同一条子进程 IPC 上并行的 `createSession` 仍得到 `{ sessionId: "a", projectId: "a" }`。
- relay 发往 renderer 的帧共 6 条，顺序是 `chord_result`、`chord_result`、`chord_update`、`chord_result`、`chord_update`、`chord_result`。没有这三种以外的 kind。`chord_call` 只从 renderer 发往 child，所以这条 tap 里看不到它。

### Q3. 两侧热重载（内存管道）

Presentation 侧重载（用例约 6ms）：v1 在 `advance({ by: 2 })` 后记下 `[0, 2]`。`presentationHost.reload([v2])`（同一个 facet id）返回时，v2 已经拿到当前值 `{ step: 2, label: "step 2" }`，没有重新 catalogue。之后 v2 `advance({ by: 1 })`，v2 的序列是 `[2, 3]`，v1 停在 `[0, 2]`。reload 调用期间线上新增消息数是 0：没有 `unsubscribe`，也没有新的 `subscribe`。远程绑定留在 host 上，v2 只是给已经 hydrate 的 replica 再挂一个本地订阅。

Session 侧重载（用例约 1ms）：`sessionHost.reload([v2])` 不抛错。v2 同一个 facet id，同一个 service，初始状态 `{ step: 100, label: "reloaded" }`。线上新增 1 条消息，类型是 `replaced`。订阅回调再响一次，delivery kind 是 `hydrate`（不是 `update`），值就是这个新快照。`reload()` resolve 之后 `progress.value` 已经是 `{ step: 100, label: "reloaded" }`。订阅回调里读到的 `progress.value`，以及 reload 前后的轮询，都没有出现 `undefined`。轮询序列只有 `0:idle` → `100:reloaded`。

也就是说：替换帧到达之前，replica 一直显示旧快照；`replaced` 在同一次投递里被写成新的 base snapshot，调用方看不到 `value === undefined` 的空窗。README 写 replica 在 replacement 后 unready 直到 rehydrate，0.86.0 的 singleton `replace` 确实发了新快照，但没有走 `clear()`，也没有发 `unavailable`。

接入生产前必须处理：

1. 主进程现有通道是 Electron `MessagePortMain`（`apps/desktop/electron/main.ts` 里 `port1.on("message", ({ data }) => …)`），要手动 `start()`。本 spike 的 `createMessagePortChordPort` 按 Node `worker_threads` 的 `MessagePort` 写：`on("message", value)` 拿到的是值本身，挂上 listener 就会开始派发。renderer 里的 DOM `MessagePort` 则是 `MessageEvent`。结构化克隆这一跳已经通了，监听器形状不能原样搬。
2. 面板不能靠 `progress.value === undefined` 发现 provider 被热替换。session 侧重载是一帧 `replaced`，订阅者看到一次新的 `hydrate`；这一帧到达前 UI 仍是旧快照。
