# ADR-0042：Pace 作为 Pi chord 插件架构的 presentation host

- 状态：草案（待讨论；第二个 spike 完成后再定稿）
- 日期：2026-09-21
- 来源：`.scratch/chord-plugin-gui/SPIKE.md` 的调研与 spike；`.scratch/extension-host-contract/HANDOFF.md` 的遗留问题
- 关联：[ADR-0018](0018-runtime-gateway-api-and-pi-drivers.md)、[ADR-0031](0031-bundled-pi-runtime-and-extension-compatibility.md)、[ADR-0032](0032-session-dock-and-trajectory-vocabulary.md)、[ADR-0040](0040-root-session-process-isolation.md)、[ADR-0041](0041-remove-pi-rpc-driver.md)

## 背景

`README.md`「Extensibility」路线图第 1 条承诺一个由 Pace 自定的 **Extension Surface 协议**：让 Pi 扩展注册自定义面板并接入事件流。ADR-0018 为「extension UI request」在 Gateway 协议上预留了槽位，ADR-0031 承诺原生扩展兼容但明确「可视化协议的具体形式由真实扩展验证后另行设计」。`extension-host-contract/HANDOFF.md` 记录了另一面：扩展需要向宿主要能力（如何起子会话、SDK 在哪），当时的候选方案是 `globalThis` 上的 Symbol 注册表。

2026-08 起 Pi 上游把这两个问题一起解决了。`@earendil-works/chord`（随 `pi-coding-agent` 0.85+ 一起安装，Pace 锁定 0.86.0）是一个应用无关的插件组合运行时：

- 一个插件包按宿主拆成多个 **facet**（约定入口 `src/session.ts` 与 `src/tui.ts`），只共享 `contract.ts` 中用 `defineService` 声明的 token。
- Service 成员只能是 `ReplicatedState<Json>` 或 `(...json, Context) => Promise<Json>`；`{ local: true }` 的服务永不跨进程。
- `createFacetHost` 校验依赖图、hydrate 远端服务、按依赖序激活，并支持 `reload()` 热替换。
- 跨进程边界由应用实现 `RemoteServiceTransport`（只有 `invoke` 与 `subscribe` 两个方法），framing、路由、传输不由 chord 规定。
- 上游设计稿（`packages/agent/docs/mobile-handoff/02-plugins/01-facets/facets.md`）把拓扑定为 server → session worker → presentation，并明确 **GUI 是一种 presentation host**（"TUI A / web B"），slot 由宿主独占声明与挂载。

上游的稳定 API（Pace 走的 `createAgentSession`）至今不碰 chord；实验路径需 `PI_EXPERIMENTAL=1`，且 npm 包不发布 `dist/experimental`，所以 Pace 今天 import 不到 `AgentController` / `Transcript` / `PresentationUI` 这些内置 token。chord 自身也声明「not a stable public API contract yet」。

第一个 spike（`packages/backend/src/drivers/chord-plugin-spike.ts`）只用 chord 公开的 wire API，在每条消息都经 JSON 序列化的管道上跑通了 session facet 与 presentation facet 之间的状态 hydrate、delta 推送与 RPC，未引入 pi-server / pi-client / pi-protocol。

## 决策

> Pace 不再自研 Extension Surface 协议，而是把自己实现为 chord 的 presentation host。插件与 Pace 之间的契约层、状态同步、RPC 与热重载全部由 chord 提供；Pace 只负责 transport 适配、presentation 服务与 slot 挂载。

### 1. 契约层交给 chord

- 扩展面板的契约就是插件 `contract.ts` 里的 chord service。Pace 不定义自己的面板事件格式、增量协议或注册表格式。
- README 路线图第 1 条改写为「Pace 成为 chord presentation host」；ADR-0018 预留的 extension UI 槽位由此实现，不再另起协议。
- 扩展向宿主要能力（HANDOFF §5）改为宿主 `provide` 一个 chord service（例如 Pace 提供的子会话 spawner），插件在 facet 里 `env.use`。`globalThis` Symbol 注册表方案不再推进。

### 2. transport 复用 Session 进程的 IPC

- session facet 运行在该根 Session 的子进程内（ADR-0040），与 Pi 会话同进程，由一个 `FacetHost` 承载。
- backend 与子进程之间的 chord 流量复用 `session-process-protocol.ts` 的 Node IPC 通道，只新增三种消息：`chord_call`、`chord_result`、`chord_update`。它们与现有的 `{ id, method, args }` 驱动命令共用通道，按 `kind` 字段分流。
- chord 适配器集中在一个模块里，随 Pi 版本锁一起升级；其他代码不直接 import chord 的 wire 函数。

### 3. Pace 的 presentation 服务是 Gateway 能力的投影

Pace 向插件 presentation facet 提供的内置服务，对标上游的 `AgentController` / `Transcript` / `PresentationUI`，但实现为 Runtime Gateway 已有能力的投影，不另开一条到 Pi 的路径。Session Dock 的面板挂载对应上游的 `slots.claim / add`：`surface-registry.ts` 已预留的 `provider` 字段用来标记面板来源插件。

### 4. 分阶段推进

| 阶段 | 内容 | 验收 |
|---|---|---|
| A（已完成，2026-09-21） | 第二个 spike：真实 fork 子进程内跑 session facet，presentation host 放在 backend，与现有驱动命令共用 IPC（`chord-plugin-spike-process.test.ts` + `fixtures/chord-session-process.mjs`） | 通过：hydrate / RPC / delta 与 `createSession` 回复在同一通道上并行到达；快照先于 delta 的顺序保持；fork 默认 json 序列化与内存管道等价。接入生产前必须处理的两点见下 |
| B0 | 先给 Session 进程通道一个统一的判别字段（见下），不带任何 chord 代码，单独一个小 PR | 三个 session-process 文件与 fixture 改成按 `type` 分发；现有测试全绿 |
| B | 把适配器接进 `session-process-driver` / `session-process-server`；backend 侧 presentation host 只暴露 DTO 给 renderer | 一个真实插件的 session facet 状态能出现在 Session Dock 的一个面板里 |
| C | 决定 renderer 侧 facet 代码的加载方式（见开放问题 1），实现 slot 挂载 | 插件贡献的面板在 Dock 中可开关、随 Session 切换销毁 |

阶段 A 暴露的两个接入前提，进入阶段 B 时必须一并处理：

- **通道协议先统一判别字段（阶段 B0）。** 现有 `session-process-protocol.ts` 靠形状推断区分消息：请求看有没有 `method`，回复看有没有 `id`，只有事件带 `type: "event"`；`session-process-server.ts` 更是无条件解构 `{ id, method, args }`。ADR-0040 引入这条通道时只打算承载驱动命令，从未设计成可承载第二套协议。spike 里 chord 消息用 `kind` 前缀自我标记，结果每个 `chord_call` 都被 server 当成未知命令回一帧 `{ id, error }`，而两套协议的数字 `id` 又各自从 1 起计，driver 侧按 `id` 找 pending 时可能把驱动请求错误 reject。靠「谁先忽略谁」的分流是在延续形状推断，不是修复。B0 的做法：所有消息统一带 `type`，形成一个联合类型 `request | response | event | chord_call | chord_result | chord_update`，driver 与 server 都改成按 `type` 分发；chord 的 id 空间与驱动请求分开。这一步不含 chord 代码，逻辑不变，可先单独合入。
- **子进程必须先同步挂上分流 handler，再做异步装配。** Node 只把 listen 之前的 IPC backlog 冲给第一个 `message` handler；`createFacetHost` 是异步的，若 parent 在子进程 ready 前发送 chord 流量会丢消息。spike 用一条 `spike_ready` 握手绕过，生产实现应在入口同步注册 handler 并缓冲，或让 driver 在 `createSession` 返回后才开放 chord 流量。

## 后果

- **正面**：不重复造协议；与 Pi TUI 共用同一套插件包格式，履行 ADR-0031「同一个扩展包在不同宿主提供不同呈现」；类型层面强制 JSON 边界，天然满足跨进程与未来 apps/server 的 WebSocket 场景（ADR-0015）。
- **负面**：Pace 与一个尚未稳定的上游 API 绑定，升级 Pi 时适配器可能要改（0.85 → 0.86 已换过一次 delta 实现）；内置 token 的 id 与类型目前只能与上游对齐后手抄；GUI 入口约定（如 `src/web.ts`）需要推动上游增加。
- **不改变的**：ADR-0018 的 Gateway / Driver 分层与 ADR-0041 的删除决定。chord presentation host 不是一个新的 `PiRuntimeDriver`，Pi 会话本身仍走进程内 SDK；chord 只承载插件的附加服务。

## 开放问题

1. **renderer 侧如何加载 facet 代码。** chord 的加载器是 `node:vm`，Electron renderer 不能直接用。候选：a）presentation facet 在 backend 加载，UI 抽象成 DTO 推给 React，插件不写 React 组件；b）renderer 用独立 module script 或 per-facet iframe 加载 esbuild 产物（上游设计稿的隔离升级路径）。阶段 B 先走 a，阶段 C 再定。
2. **Pace 提供哪些 presentation 服务**，以及 slot 的命名与 CONTEXT.md 词汇对齐。
3. **信任模型。** 项目目录中的插件代码会在用户 GUI 进程执行；上游也把这列为 ship 前必须解决的决策。
4. **上游依赖**：`experimental/plugin` 何时进 dist、是否提供 GUI 入口约定。需向上游开 issue。
   - chord 0.87.0（Pi 上游，2026-09-21，commit `10d1ad621` "feat: add transactional replicated state"）把 `MutableReplicatedState.state` + `publish(ctx)` 换成了 `change(ctx, draft => …)` + `replace(ctx, value)`。该 commit 没有改 wire API（`createRemoteServiceEndpoint`、state codecs、`createRemoteServiceBinding`）。Pace 仍锁定 0.86.0。

## 与已有文档的冲突

- 与 `README.md` 路线图第 1 条冲突：本 ADR 定稿时同步改写该条。
- 与 `.scratch/extension-host-contract/HANDOFF.md` §5.2 的方案 B（Symbol 注册表）冲突：HANDOFF 是交接材料而非决策，本 ADR 取代其方向。
