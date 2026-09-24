# ADR-0045：agent-workspace 按领域概念切为 FSD 切片

- 状态：Accepted
- 日期：2026-09-24
- 来源：架构评审候选 5（2026-09-23）+ grilling（2026-09-24）；事实核查基于 main @ 8920b42
- 取代：[ADR-0016](0016-fsd-layers-in-apps-desktop.md) 中「刻意不引入 widgets 和 features，直到 agent-workspace 被切分」的推迟条款。ADR-0016 的其余决定不变。

## 背景

ADR-0016 写推迟条款时 `apps/desktop/src/pages/agent-workspace.tsx` 是 1341 行，现在 4614 行，测试 9402 行 139 个用例。CONTEXT.md 里彼此独立的概念全在这一个文件里：Project Selector、Session Draft、Session Creation 交接、Live Session View、Follow-up Draft、Queue、Fork、Execution Checkout、Chain of Thought、Changes、Surface。Draft 专属的修复（35d9d68、e701abf）也得经过这个文件。ADR-0043、ADR-0044 落地后，Model 与 Session Projection 各有 module 拥有，切分不再有「一起切走四个写者」的顾虑。

import 方向规则一直靠约定维持，已有反向 import 存在一段时间没人发现：六个 page import `@/app/app-shell` 的 `AppFrame`，一个 page import app 层的 fixture 数据；`getVisibleProjectRegistry` 在 app-shell 与 agent-workspace 各定义一份，registry 被订阅三次；agent-workspace import 三个同层 page（Files / Terminal / Browser panel）；生产组件里有八处 browser fixture 回退与默认 props；`shared/runtime.ts` 从 `pages/session-detail` import 类型；`entities/session/session-detail.fixtures.ts` 也从 pages import。

两个测试按文件路径读源码做字符串断言（`fixtureWorkspace` 文案、`createDefaultPiRuntimeBridge` 存在），任何移动都会让它们挂。`dev/ui-intent/regions.ts` 按组件显示名字符串绑定 CONTEXT.md 词条，测试只查词条存在，不查组件名还在。

## 决策

### 1. 引入 `features/` 与 `widgets/` 两层

层与方向：`app → pages → widgets → features → entities → shared`。`dev/` 与 `fixtures/` 是开发期例外，可被任何层 import，但不得被生产代码在运行时依赖默认值。`features/` 放带用户意图的交互切片；`widgets/` 放组合多个 entity 的大块 UI；`pages/` 只剩路由参数、组合与布局。

### 2. 每个 CONTEXT.md 概念一个切片

| 目标位置 | 内容 |
| --- | --- |
| `entities/session/live-chat-model.ts` | 纯 view-model（projection → LiveMessage[] / RunTimelineItem[]，约 20 个无 hook 函数）与 watchdog 常量 |
| `entities/checkout/` | Execution Checkout：`GitBranchPicker`、`CheckoutStrategyPicker`、label 助手、两个 composer 共用的 `ComposerLocationRow` / `ComposerStaticChip` |
| `entities/project/visible-registry.ts` | `getVisibleProjectRegistry` 唯一定义与 `useVisibleProjectRegistry()` 唯一订阅 hook；app-shell、page、landing 都读它 |
| `features/session-draft/` | `SessionDraftComposer`、Hero、Suggestions、ExitEcho、`ProjectPicker`（Project Selector）、`SessionCreationFailureDetail` |
| `widgets/live-chat/` | `LiveSessionColumn`、`FullChatComposer`（Follow-up Draft）、`QueuedMessageList`、`LiveChatMessage`、`AssistantRunTrajectory`、`AssistantMessageContent`、runtime state 恢复助手。Queue / Steer / Stop / Fork / Retry / 改模型是共享 `liveProjection` 与 `apply` 的闭包，随 widget 走，在目录内按文件拆，不硬切成 feature 造 prop drilling |
| `widgets/session-dock/` | `SessionSurfaceContent`、`SessionToolbarActions`、Changes panel；`session-files-panel` / `session-terminal-panel` / `session-browser-panel` 从 pages 搬入 |
| `widgets/app-frame/` | `AppFrame` 依赖同文件内的侧栏导航、`HeaderChrome` 与 `getActiveTab`，与之不可分，所以 `app/app-shell.tsx` 整个文件原样移为 `widgets/app-frame/app-frame.tsx`；六个 page 改为向下 import |
| `dev/fixtures/agent-workspace.ts` | `fixtureWorkspace`、`defaultSidebarProjectSessionProjections`；生产 props 不再有 fixture 默认值。`workspaceFromProject` 由 registry 条目构造真实 workspace，不是 fixture，留在 page；`AgentWorkspaceFixture` 类型是生产类型，移到 `widgets/live-chat/restore-runtime-state.ts` 并由 barrel 导出，消除类型环 |
| `pages/agent-workspace.tsx` | 只剩 `AgentWorkspaceSessionsView`、`AgentWorkspaceSessionsPage`、`TitlebarBand`、`firstSessionIdForProject` |

组件名全程不改：`regions.ts` 按显示名绑定。`regions.test.ts` 补一条断言，每个绑定的组件名在 `apps/desktop/src` 里存在为 `function X` 或 `const X` 声明，以后改名会挂。

### 3. 五个 stacked PR，每个只做「移动 + 改 import + 拆对应测试」，零行为变化

1. entities：view-model、Execution Checkout、registry hook；Location row 的 describe 随之搬
2. `features/session-draft`
3. `widgets/live-chat`
4. `widgets/session-dock`（修 page→page）
5. 页面组合；fixture 进 `dev/`；`AppFrame` 进 widgets；`shared→pages`、`entities→pages` 两处类型 import 修正；两个读源码的测试处理；lint 规则与 CI

`agent-workspace.test.tsx` 按切片拆成多个测试文件随各自 PR 移动，公用的 render helper 与 fake 抽到一处测试工具模块。每个 PR 更新它搬动的部分在 `docs/design/*.md`、`docs/self-built-ui.md` 里引用的路径；README「Where things live」的 UI 行在 PR 5 改。

### 4. 两个读源码的测试

`createDefaultPiRuntimeBridge` 那条改成行为断言：用已有的 bridge spy module 断言 View 默认走 gateway bridge。`fixtureWorkspace` 文案那条删除，它只镜像字面量。

### 5. import 方向由 linter 检查，接入 CI

用 ESLint flat config 表达第 1 条的层方向规则（`eslint-plugin-boundaries` 或等价的 `no-restricted-imports` 路径规则），配置只含这一条规则，保证引入当天全绿；`bun run lint` 脚本；新增在 `pull_request` 上运行 `typecheck` 与 `lint` 的轻量 workflow（ubuntu）。仓库里已有的 `@hyperse/eslint-config-hyperse` 未被使用，本 ADR 不采用它做基线，是否采用另行决定。不用 vitest 做静态检查。

## 后果

- 概念名等于目录名，改 Session Draft 不再经过 4614 行的 page。
- 页面测试按切片拆开，Draft feature 用自己的 props 测。
- 反向 import 被 lint 拦住；`pages → app` 的 `AppFrame` 依赖消失。
- 未做：`app-shell.tsx`（1815 行）本身的切分；`settings.tsx`（1237 行）。
