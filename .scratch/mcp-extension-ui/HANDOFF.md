# Handoff：MCP 与扩展交互在 Pace 中的呈现

- 日期：2026-09-30
- 状态：已决（2026-10-01）。不做 `ctx.ui` 桥，MCP 管理放进设置页，见 [mcp-settings/PRD.md](../mcp-settings/PRD.md)；会话内 notify 暂缓，见 #416。下文保留为当时的交接材料。§3.3 “不能依赖 `pi` CLI” 已被推翻：`pi mcp` 的核心函数 `runMcpCommand` 可以打包进 Pace。
- 关联：PR #412（Pi 0.99.1，加载内置 codemode / tool_search / MCP，[ADR-0046](../../docs/adr/0046-load-pi-builtin-extensions.md)）、PR #414（Nested Tool Execution 呈现）、[ADR-0018](../../docs/adr/0018-runtime-gateway-api-and-pi-drivers.md)、[ADR-0031](../../docs/adr/0031-bundled-pi-runtime-and-extension-compatibility.md)、[ADR-0040](../../docs/adr/0040-root-session-process-isolation.md)、[ADR-0042](../../docs/adr/0042-pace-as-chord-presentation-host.md)（草案）、[extension-host-contract/HANDOFF.md](../extension-host-contract/HANDOFF.md)
- 目的：Pi 0.99 适配的前两步已经完成，第三步有设计取舍。本文把已查明的事实和待决问题交给新会话，避免重查。

## 1. 结论

MCP 在 Pace 里已经能连接服务器、调用工具。但 MCP 扩展汇报状态、报错、做 OAuth 登录全都经过 `ctx.ui`，而 Pace 没有给扩展提供 UI 上下文，所以这些信息被静默丢掉，在 Pace 里也无法登录。

要决定的是先做哪一种：

- A. 通用的扩展交互桥：让 `ctx.ui` 的通知和对话框在 GUI 里生效。
- B. MCP 专用的管理面板。
- 先 A 后 B。

我的建议是先做 A（理由见 §5）。

## 2. 前两步合并后的现状

能用的：

- 读取 agentDir 下的 `mcp.json`。agentDir 由 `resolveAgentDir()` 决定：`PI_CODING_AGENT_DIR`，否则 `~/.pi/agent`，与 CLI 相同。
- stdio / streamable HTTP 连接。
- 默认 exposure 下自动激活 codemode，以及 tool_search。
- 打包版能跑 codemode（QuickJS worker 与 wasm 已打进 `out/main/chunks/`）。
- 嵌套调用挂在父调用下显示；MCP 工具显示为 `server/tool`。

不能用的，原因都一样：Pace 没传 `uiContext`，`ctx.ui` 是空实现。

| 场景 | MCP 扩展的行为 | Pace 里的结果 |
|---|---|---|
| 启动后发现配置错误、连接失败、需要登录 | 汇总后 `ctx.ui.notify` 一次 | 丢失 |
| codemode 和 tool_search 都未激活，MCP 工具不可达 | `notify` 警告一次 | 丢失 |
| `/mcp`（无参数） | 非 TUI 模式下 `notify(formatStatus())` | 丢失 |
| `/mcp login <server>` | 先检查 `ctx.hasUI`，为 false 时 `notify` 报"requires interactive mode" | 静默失败 |
| `/mcp logout` / `reconnect` | 动作执行，结果走 `notify` | 执行了，但看不到结果 |
| 启用/禁用服务器、改 exposure | 只在 TUI 管理器里提供（`ctx.ui.custom`） | 不可用 |

现有变通：在终端运行 `pi mcp login <server>` / `pi mcp list`（需要用户自己装了 CLI）。凭据写在 agentDir 的 `mcp-auth.json`；按 Pi 文档，运行中的会话会在下一轮使用新凭据。

## 3. 已核实的事实（不必重查）

### 3.1 Pi 的扩展 UI 契约

- `session.bindExtensions(bindings)` 的参数类型是 `ExtensionBindings { uiContext?, mode?, commandContextActions?, abortHandler?, shutdownHandler?, onError? }`。Pace 只传了 `onError`，见 `packages/backend/src/drivers/pi-sdk-runtime-adapter.ts` 约 1688 行。
- `hasUI` 的判定是 `uiContext !== noOpUIContext`（`dist/core/extensions/runner.js`）。只要传入任意 `uiContext`，`ctx.hasUI` 就是 true。runner 会用 `wrapUIPromptContext` 包一层，并发出 `UIPromptStartEvent` / `UIPromptEndEvent`；这两个事件的具体语义尚未查。
- `ExtensionUIContext` 的方法有：`select`、`confirm`、`input`、`editor`、`notify`、`setStatus`、`setWidget`、`setTitle`、`setEditorText`、`getEditorText`、`pasteToEditor`、`custom`、`onTerminalInput`、`setFooter`、`setHeader`、`setWorkingMessage`、`setWorkingVisible`、`setWorkingIndicator`、`setHiddenThinkingLabel`、`addAutocompleteProvider`、`setEditorComponent`、`getEditorComponent`、`getToolsExpanded`、`setToolsExpanded`、`getTheme`、`getAllThemes`、`setTheme`。
- **现成先例：Pi 的 RPC 模式**，见包内 `docs/rpc-extension-ui.md`。GUI 宿主要实现的就是这一子集：
  - 对话框类（`select` / `confirm` / `input` / `editor`）发出请求，阻塞到客户端回应。支持 `timeout`，超时由 Pi 一侧自动取默认值。
  - 通知类（`notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`）只发不等。
  - `custom()` 返回 undefined，其余 TUI 专属方法都是空实现。
  - RPC 模式下 `ctx.mode === "rpc"` 且 `hasUI === true`；扩展用 `ctx.mode === "tui"` 来判断能否用 `custom()`。

### 3.2 MCP 扩展对 UI 的依赖

来源：`dist/extensions/mcp/index.js`。

- `/mcp` 无参数时：`mode === "tui"` 打开 `showMcpManager`（基于 `ui.custom`），否则 `notify(formatStatus())`。
- 登录：
  - 先检查 `hasUI`。
  - 通过后 `signIn` 先 `notify` 授权 URL，再 `openUrl(url)`。`openUrl` 默认调用平台浏览器，可用 `createMcpExtension({ openUrl })` 覆盖。
  - 同时 `ctx.ui.input(..., { signal })`，让浏览器在另一台机器上的用户粘贴回调 URL；本机回调到达后这个 input 会被取消。
- 服务器名有歧义时 `pickServer` 用 `ui.select` 让用户选。
- **推论**：只要 Pace 提供一个 RPC 语义的 `uiContext`（`notify` + `select` + `confirm` + `input`），并且 `mode` 不是 `"tui"`，`/mcp` 状态、login、logout、reconnect、启动问题汇报就全部能用，不需要任何 MCP 专用代码。仍然缺的只有 TUI 管理器里的启用/禁用和 exposure 切换。

### 3.3 如果做面板，数据从哪来

- **SDK 没有公开 MCP 服务器运行状态的 API**（连接状态、工具数、错误信息都拿不到）。`createMcpExtension` 的选项只有 `loadConfig`、`createTransport`、`credentials`、`logPath`、`openUrl`、`updateConfig`、`startupWaitMs`。
- 间接来源：
  - 扩展内的 `pi.getAllTools()`：`namespace` 即服务器，另有 `exposure` 和 `annotations`。
  - `mcp.json` 文件本身（配置）。
  - agentDir 下的 `mcp.log`（服务器日志通知）。
  - `updateConfig` 钩子（写回配置）。
- `pi mcp list` 能连一遍所有服务器并打印状态，但 Pace 打包版不带 `pi` CLI，只内嵌了 SDK，不能依赖它。

### 3.4 Pace 侧的约束

- 每个根 Session 一个进程（ADR-0040），扩展在该进程里运行。所以对话框请求的路径是：Session 进程 → backend → renderer，回应再原路返回。
- 通道是 `session-process-protocol.ts`。ADR-0042 阶段 B0 指出它靠消息形状推断类型，计划统一加 `type` 判别字段；新增一对请求/回应消息会和 B0 撞在一起。
- **每个 Session 进程各自连接一遍所有 MCP 服务器**：每个进程都加载 MCP 扩展，并在 `session_start` 时连接。开 N 个会话，每个 stdio 服务器就有 N 个进程。面板展示"哪个会话的连接状态"、资源占用是否可以接受，都要讨论。
- ADR-0031 把"标准交互在 GUI 中完成"列为后续目标。ADR-0018 在 Gateway 上为 extension UI request 预留了槽位。ADR-0042（草案）写的是"ADR-0018 预留的 extension UI 槽位由此实现，不再另起协议"，指的是 chord presentation host。但 `ctx.ui` 的标准对话框不是 chord service，二者关系要先理清。
- 输入框只拦截 TUI 内置命令。`/mcp` 是扩展命令，会走 `session.prompt` 进到 handler。
- 项目级 `.pi/mcp.json` 只有在项目被信任后才会读。Pace 创建会话时用 `SettingsManager.create(cwd, agentDir)`，没有显式处理 project trust，实际默认值尚未查。

## 4. 待决问题

1. **落点**：A 通用 `ctx.ui` 桥 / B MCP 专用面板 / 先 A 后 B。
2. **协议归属**：做成 Gateway 上新增的一对事件和命令（沿 ADR-0018 的槽位），还是做成 chord service（ADR-0042）？ADR-0042 还是草案，要不要顺带修订？
3. **通知怎么呈现**：toast、聊天流里的 notice，还是状态栏？要不要写进 Session Event Journal，replay 时再出现？MCP 的问题是每个会话都会出现，还是全局去重？
4. **对话框怎么呈现**：模态框，还是嵌在输入框里？请求来自一个不在前台的会话时怎么办？多个请求同时来怎么排队？`timeout` 和取消（`signal`）怎么映射？
5. **OAuth 打开浏览器**：沿用 Session 进程里的平台浏览器调用，还是通过 `openUrl` 覆盖改走 Electron `shell.openExternal`？
6. **面板的数据源**（选 B 时）：
   - (i) Pace 内置一个小扩展，从 `pi.getAllTools()` 的 namespace 推出各服务器的工具，并发布状态。注意 `mcp_servers_change` 只反映扩展注册的服务器列表变化，不含连接状态，所以这条路拿不到连接失败、需要登录这类信息；
   - (ii) 向上游提议暴露状态 API 或事件；
   - (iii) Pace 自己再实现一个 MCP 客户端，大概率否决，会重复一遍连接逻辑。
   - 不建议解析 `notify` 文本。
7. **每会话一份连接的资源问题**：接受现状，还是需要跨会话共享连接？跨会话共享要动 Pi 的扩展模型。
8. **项目信任**：Pace 目前如何处理，要不要给出 UI。

## 5. 建议的讨论起点

建议先做 A：实现 RPC 语义的 `uiContext`，包括 `notify` / `select` / `confirm` / `input`，`mode` 设为非 `tui`。理由：

- 不写 MCP 专用代码，就能打通 `/mcp` 状态、登录、登出、重连和启动问题汇报。
- 其他扩展的 `ctx.ui.confirm` 也会一起生效，例如权限拦截类扩展。Pi 文档里用 MCP annotations 做审批的示例就依赖它。
- 契约直接对齐 Pi 自己的 RPC 模式，不用自创。
- 以后要做 B，本来也要先解决状态数据源（§4.6），不必等它。

## 6. 关键文件

- 扩展绑定：`packages/backend/src/drivers/pi-sdk-runtime-adapter.ts`（`bindExtensions`）
- 内置扩展注册：`packages/backend/src/drivers/pi-builtin-extensions.ts`
- Session 进程通道：`packages/backend/src/drivers/session-process-protocol.ts`、`session-process-server.ts`、`session-process-driver.ts`
- Gateway 协议：`packages/core/src/runtime-gateway.ts`、`packages/core/src/agent-runtime-event.ts`
- Pi 源码（`packages/backend/node_modules/@earendil-works/pi-coding-agent/`）：
  - `dist/extensions/mcp/index.js`（`/mcp` 命令与登录）
  - `dist/core/extensions/runner.js`（`hasUI`）
  - `dist/core/extensions/types.d.ts`（`ExtensionUIContext`、`ExtensionBindings`）
  - `docs/rpc-extension-ui.md`、`docs/mcp.md`
