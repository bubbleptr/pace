# ADR-0046：在 SDK 会话中加载 Pi 内建扩展

- 状态：Accepted
- 日期：2026-09-30
- 来源：Pi 0.99 升级

## 背景

Pi 0.99 新增了 codemode、tool_search、MCP 三项能力，形态是 CLI 内建扩展：`pi` 二进制在启动时以 `{ name, factory, replaceable: true, builtin: true }` 的形式注册它们，但 SDK 会话（`createAgentSession` / `DefaultResourceLoader`）不会自动加载。Pace 每个 root Session 都跑在独立进程里嵌 Pi SDK（`SessionProcessDriver` + `pi-sdk-driver`，ADR-0040/0041），不补上这三个工厂，Pace 会话里就没有 codemode、`/mcp`、tool_search，`mcp.json` 里配置的服务器也不会连接。

Pi 同时改了打包形态：codemode 的脚本在 QuickJS WASM VM 里跑（`quickjs-wasi`），执行发生在独立 worker 线程里。`dist/config.js` 用 `createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")` 找 wasm，并用 `new URL("./codemode-worker.js", import.meta.url)` 找打包构建里与 config 同 chunk 目录的 worker 入口（`dist/extensions/codemode/worker.js`，只做 `import "@earendil-works/pi-codemode/worker"`）。Pace 把 Pi SDK 打进 `apps/desktop/out/main`（electron-vite），打包产物里没有任何 node_modules，所以这两个相对资源都得由我们的构建产出。

## 决策

1. 新增 `packages/backend/src/drivers/pi-builtin-extensions.ts` 导出 `createPaceBuiltInExtensions(): InlineExtension[]`，按 CLI 的形状返回 codemode、tool-search、mcp 三条（各自 `replaceable: true, builtin: true`，工厂为无参 `createCodemodeExtension()` / `createToolSearchExtension()` / `createMcpExtension()`，让用户设置如 `codemode.mode` 生效）。两处构造 `DefaultResourceLoader` 的地方——`service.ts` 与 `session-process-entry.ts` 的 `sessionOptionsFor`——都传 `extensionFactories: createPaceBuiltInExtensions()`。`builtin: true` 让这些条目以 `builtin:<name>` 资源加载：默认启用、`settings.json` 里 `-builtin:<name>` 可禁用、`pi config` 可见；`replaceable: true` 让注册了同名 tool/command 的第三方扩展接管而不是报冲突，与 CLI 行为一致。llama.cpp 内建（`builtin:llama.cpp`）刻意先不加载。
2. 打包（`apps/desktop/electron.vite.config.ts`）：
   - main 构建新增 rollup input `chunks/codemode-worker` → Pi 包的 `dist/extensions/codemode/worker.js`，配合 `entryFileNames: "[name].js"` 产出 `out/main/chunks/codemode-worker.js`，正好落在 `getCodemodeWorkerUrl()` 的相对 URL 上。
   - 一个 `transform` 插件对 pi 的 `dist/config.js`（按 realpath 匹配）把 `createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")` 替换为相对同 chunk 的 `new URL("./quickjs.wasm", import.meta.url)`；目标文本必须恰好出现一次，否则构建报错，Pi 升级改动这段代码时会立刻暴露。
   - `copyMainRuntimeAssets` 另外把 `quickjs.wasm`（经 pi-codemode 包解析，因为它是 pi-codemode 的依赖而非 pi-coding-agent 的）复制到 `chunks/quickjs.wasm`。
   - `generateBundle` 里加守卫：找到包含 pi `dist/config.js` 的输出 chunk，若不在 `chunks/` 下则构建失败——两个相对 URL 都依赖这个位置。

## 后果

- Pace 会话恢复 codemode / tool_search / MCP，且 `-builtin:<name>` 禁用与第三方替换语义与 CLI 完全一致。
- `scripts/test-bundled-runtime.mjs` 新增一条端到端断言：打出的 `out/main` 在无 node_modules、空 PATH 下跑通「模型发起 codemode 调用 → 脚本调用 `mcp__probe__echo` → 拿到回显」，回归覆盖 worker/wasm 的相对布局。
- 已知缺口，留给后续 PR：
  - MCP 扩展的状态与错误只经 `ctx.ui.notify` 上报，OAuth 登录要求 `ctx.hasUI`；Pace 的 `bindExtensions` 目前只传 `onError`，这些提示会被丢弃，`/mcp login` 在 Pace 里不可用（用户可在 shell 里跑 `pi mcp login`，凭据共享同一 agent dir）。
  - 嵌套工具调用带 `parentToolCallId`，Pace 尚未投影，嵌套调用在 UI 上不呈现父子关系。
  - llama.cpp 内建未加载。
