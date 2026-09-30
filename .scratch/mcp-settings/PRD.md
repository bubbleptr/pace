# PRD：设置页 MCP 管理

- 日期：2026-10-01
- 来源：[mcp-extension-ui/HANDOFF.md](../mcp-extension-ui/HANDOFF.md) 的第三阶段讨论
- 关联：PR #412（加载内置 MCP 扩展，ADR-0046）、#416（会话内 notify 提醒，暂缓）

## 问题

Pace 已经能加载 Pi 内置的 MCP 扩展、连接 `mcp.json` 里的服务器，但用户在 Pace 里看不到服务器状态，也无法登录 OAuth 服务器、启用/禁用服务器或修改 exposure。内置扩展把这些能力都放在 TUI 的 `/mcp` 管理器里（`ctx.ui.custom`），状态封在扩展闭包里，宿主拿不到。

## 决策

1. **MCP 管理放进设置页，UI 由 Pace 自己写**，和内置终端、浏览器一样当作 Pace 的一等功能。不把 `ctx.ui` 映射到 GUI，也不托管 TUI 组件。
2. **三方扩展的 UI 不在本范围**，等 Chord（ADR-0042）落地后统一解决。三方 MCP 扩展顶替内置扩展的情况暂不处理。
3. **数据和操作复用 Pi 包内的 `pi mcp` 实现**，不自己写 MCP 客户端：
   - `dist/extensions/mcp/cli.js` 的 `runMcpCommand(args, { cwd, agentDir, openUrl, log, error })`：`list --json` 探测状态，`login` / `logout` / `add` / `remove` 做操作。
   - `dist/extensions/mcp/config.js` 的 `loadMcpConfig`（即时读配置）和 `updateMcpServerConfig`（启用/禁用、exposure）。
   - 这两个文件不在包的 `exports` 里，按文件路径打包。这是与固定 Pi 版本的耦合，靠契约测试兜底：Pi 升级后结构一变，测试失败。
4. **会话内提醒暂缓**，见 #416。

## 范围（第一版）

- 设置页新增 “MCP” 分区。
- 打开分区时先即时显示配置里的服务器（来自 `loadMcpConfig`），再异步探测状态（`list --json`，最长可能等到单个服务器的超时，默认 60 秒）。另提供手动刷新，不轮询。
- 每个服务器显示：名称、传输方式（命令或 URL）、状态（connected / needs-auth / failed / disabled / 检测中）、错误信息、工具列表、exposure。
- 操作：
  - 登录 / 登出：只对使用 OAuth 的服务器（HTTP 且没有 `Authorization` 头）显示。登录通过浏览器授权，超时 120 秒，期间显示等待状态，不支持粘贴回调 URL，不支持中途取消。
  - 启用 / 禁用、修改 exposure：写回服务器所在的 `mcp.json`。
  - 添加服务器：名称 + stdio（命令、每行一个参数）或 HTTP（URL）+ exposure。env、headers、OAuth 客户端等高级选项仍需编辑 `mcp.json`。
  - 删除服务器：需确认。
- 显示配置错误（`mcp.json` 解析失败等）和全局 `mcp.json` 路径。
- 只管全局 `mcp.json`（agentDir 下）。项目级 `.pi/mcp.json` 与项目信任放到后续。

## 生效规则

- 会话只在启动时读取 MCP 配置，所以添加、删除、启用/禁用、exposure 的改动**只对新会话生效**。界面上明确写出。
- 登录例外：凭据写入 `mcp-auth.json` 后，运行中的会话会在下一轮开始时自动重连。

## 已知限制

- 设置页的状态是 backend 自己连接一次得到的**探测结果**，不是某个会话里的实时连接状态。每次探测都会把每个启用的 stdio 服务器启动一次再关掉。
- 每个 Session 进程仍各自连接一遍所有服务器（ADR-0040 的现状），本 PRD 不改变。

## 等上游

- MCP 扩展公开状态（例如 `createMcpExtension({ onStateChange })` 或在 `pi.events` 上发布）。有了以后，会话内的实时状态可以经 Session 进程协议上报，设置页的探测只作兜底。
- `runMcpCommand` / `config.js` 进入包的 `exports`，去掉按路径打包的耦合。

## 切片

1. Backend：MCP 服务（配置读取、探测、登录登出、启用禁用、exposure、添加删除）+ RPC 方法 + 打包别名 + 契约测试。
2. 设置页 “MCP” 分区 + 浏览器 dev fallback / mock 数据。
