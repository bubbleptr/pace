# 对话、Composer、思维链

三类自建组件住在 `apps/desktop/src/shared/ui/chat/`、`shared/ui/composer-attachments/` 与 `entities/model/model-selector/`（模型选择器依赖 Provider 领域值，ADR-0045 后归入 `entities/model`）。**页面不直接 import `@astryxdesign/core/Chat`**：Astryx 的 ChatMessage / ChatComposer 已被下面的组件包住并修正了字号（Astryx 根字号 16px，我们钉到 14px）与滚动行为。

## 对话流

### ChatConversation + ChatMessage

消息列表用 `ChatConversation`（粘底滚动、"新消息"按钮），每条消息用复合件 `ChatMessage.User` / `.Assistant` → `.Body` → `.Content`；动作行是 `ChatMessageActions` 及其 `.Copy` / `.ThumbsUp` / `.ThumbsDown`。没有 `sender` prop，角色由子组件名决定。

```tsx
// 正确 — widgets/live-chat/live-chat-message.tsx
<ChatMessage.Assistant>
  <ChatMessage.Body>
    <ChatMessage.Content>…</ChatMessage.Content>
    <ChatMessageActions className="chat-message__actions--persist">
      <ChatMessageActions.Copy aria-label="Copy" onPress={copy} />
```

### 渲染文本：四个 Markdown 组件

```
要渲染的是什么？
 ├── 助手回复正文
 │    ├── 还在流式输出 → <ChatStreamMarkdown isStreaming>
 │    └── 已完成 → <ChatMarkdown>
 ├── 思考正文（thinking step 内）→ <ChatThoughtMarkdown text=…>（只认 ** * 反引号，流式安全，不会露出未闭合标记）
 └── 独立代码块 → <ChatCodeBlock code language>（目前只在 /design；正文里的代码块由 ChatMarkdown 自己渲染）
```

两个 Markdown 都钉死 `density="compact"`、`headingLevelStart=3`，不暴露这两个 prop。

### ChatRunFailure

一次 run 失败的恢复卡：`error` 必填；`onRetry` 只对**最近一次**失败传（页面判定 `message.id === latestFailure?.id`），历史失败不传；`onOpenProviderSettings` 与 `modelControl` 让认证失败和限流有出口。文案由 `classifyProviderFailure` 决定，调用方不用自己判断：认证（HTTP 401，或 invalid api key / unauthorized）标题 “Provider authentication failed”；套餐（HTTP 403，或文案含 plan / subscription / entitlement）标题 “This model is not included in your subscription plan”，说明是 “Test the connection in Settings → Providers.”，指向 Settings → Providers 做连通性检测；限流（429）标题 “Provider limit reached”；其余标题 “Run failed”。原始错误始终留在折叠的 Error details 里。

### ChatContextChange

prompt / 工具清单变更的居中通知，不是气泡。页面只传 `toolsAdded` / `toolsRemoved` / `sectionsChanged` / `sectionsRemoved`（名字数组），文案由组件拼：工具 `Tools changed: +write, −bash`（一侧超过 4 个改成计数），段落 `Prompt updated: …` 与 `Prompt section removed: …`，有多段时用 ` · ` 连接。空补丁返回 `null`。内部固定 Astryx `ChatSystemMessage` 的 `variant="default"`，不要从页面再 import `@astryxdesign/core/Chat`。

## Composer

### ChatPromptInput

`status: "ready" | "submitted" | "streaming" | "error"`，默认 `"ready"`。没有 `"idle"`、没有 `"loading"`。两组布尔决定运行中的行为：`allowSubmitWhileRunning`（队列模式允许提交）、`lockInputOnRun`（普通发送锁定输入）。提交正在等待接受时，统一关闭队列提交并锁定输入，使用已有 `submitted` 状态；下方用 `<TextShimmer>Sending message…</TextShimmer>` 表示等待。失败保留草稿和历史，错误留在 composer。插槽：`startActions`（Plus 菜单 + 模型选择器）、`endActions`、`drawer`（附件抽屉）、`footer`（见下）。

```tsx
// 正确 — widgets/live-chat/full-chat-composer.tsx
<PromptInput allowSubmitWhileRunning={queueMode} lockInputOnRun={!queueMode} status={promptStatus} … />

// 错误 — status 集合里没有 "loading"，TS 会拒绝，别去扩这个联合
<PromptInput status="loading" … />
```

外壳使用 Astryx `ChatComposer elevation="low"`，保留既有底色、24px 外观圆角对应的 token 计算和内容间距；不再使用 flat 变体的 border / inset ring。纯外阴影仅在 `chat.css` 的 Composer 作用域内定义，不影响 TextInput；neutral 默认 elevation token 在深色下带 inset 高光，因此这里用 `--color-shadow` 与 spacing token 组合替代。默认、悬停、聚焦保持同一层阴影，文件拖入时外阴影带强调色，不另加描边；强制颜色模式保留系统色聚焦轮廓。Design 的既有 ready / streaming / error 示例直接反映当前样式。

输入本体是 Astryx `ChatComposerInput`（contentEditable，样式挂点 `.prompt-input__input`），不再是原生 textarea：

- **受控**：`value` / `onValueChange` 不变，组件内把 `value` 映射到 `ChatComposerInput` 的 `value` / `onChange`。
- **提交**：Enter、Cmd/Ctrl+Enter 走我们自己的 `onSubmitRequest`——在 `onKeyDown` 里 `preventDefault()` 拦掉组件内置提交（内置路径会自己清空输入框，违反"清空由调用方负责、提交失败保留草稿"的约定）。Shift+Enter 换行、IME 组字中（`isComposing` 或 keyCode 229）不提交。
- **关掉的默认行为**：`hasHistory={false}`（↑ 调历史）、`pasteAsToken={false}`（长粘贴转 token），与旧 textarea 行为对齐；token 化留给后续 PR。
- **`inputRef`**：类型换成 `ChatPromptInputHandle`（`focus()` / `focusAtEnd()`，后者把 caret 放到末尾），不再是 `HTMLTextAreaElement`。建议卡等场景统一用 `focusAtEnd()`。
- **无障碍补丁**：Astryx 0.3.0 的可编辑 div 只有 `aria-multiline` / `aria-label`，没有 `role`。组件 effect 会补 `role="textbox"`、`aria-placeholder`、禁用时的 `aria-disabled`（E2E 与读屏依赖 textbox 角色）；placeholder / 禁用态变化跟着更新。不要 swizzle Astryx 源码。
- 文件拖放仍由外层 `prompt-input` div 处理；粘贴文件走 `onFiles`，粘贴文本只插纯文本。禁用 = `isDisabled`（`contentEditable="false"`）+ `aria-disabled` + CSS `cursor: not-allowed`。

`footer` 是一条**恒定高度**的插槽（`min-height: var(--size-element-sm)`，一行控件），不是"有内容才出现"的行。两个 composer（`features/session-draft/session-draft-composer.tsx` 与 `widgets/live-chat/full-chat-composer.tsx`）用它装 **Location 行**（`ComposerLocationRow`，与各 picker 同住 `entities/checkout/`）：`[Location] [Branch] …… (用量环)`，空 draft 和会话内**内容完全一致**，提交时不做任何替换，composer 因此不会改变高度。三个轴不能混：

- **Project**（在哪个项目）是 draft 的输入，会话建好后已隐含，所以 `ProjectPicker`（`features/session-draft/project-picker.tsx`）放在**标题下方、composer 上方**，随 hero 一起淡出，不进 footer。
- **Location**（在哪跑）draft 时是 `CheckoutStrategyPicker`（Project folder / Git worktree），会话内冻结为标签（`ComposerStaticChip`，`chrome="selector"` 复刻 ghost Selector 的 28px 高、14px/500 字、12px 横向内边距与图标尺寸，chevron 用 `invisible` 保留占位（只是不画出来）——draft 的 Location 选择器交接后变成这个标签，少掉 16px + gap 会把右边的 Branch chip 往左拽，行内任何东西都不许移动；Branch 侧的静态标签用 `chrome="button"` 复刻 ghost Button 的 8px 内边距与 muted 色）。Location 的图标是"地方"不是 ref：Project folder 用 `Computer`，Git worktree 用 `FolderLibrary`，**不要用 `GitBranch`**（会和旁边的 Branch chip 撞图形）。Chat 工作区两态都显示 "Chat"，且不渲染 Branch。
- **Branch** draft 时：Project folder 显示当前分支（可切，即原目录 checkout）；Git worktree 显示基准分支 "from main"，同样是 `GitBranchPicker`（`triggerLabel` 加 "from " 前缀），选项来自 `get_project_git_summary` 的 `branches`；选中只写进 draft 的 `baseRef`，**不** checkout 原目录，worktree 以该分支为起点（remote-only 分支按其 remote-tracking ref），未选时仍从 HEAD 切出；切换项目时 `baseRef` 清空，项目已不再列出的 `baseRef` 视为未选。Git 回答了但没有分支（非仓库或 detached HEAD，`branch: null`）时，两种 Location 都显示静态 "No branch"（`ComposerStaticChip chrome="button"`），不可点；读取失败则不渲染 Branch，并在控制台 `console.warn` 项目路径与错误。会话内是既有 `GitBranchPicker`；Git 还没回答新 checkout 时，保持 draft 的分支值，不出现空槽。
- 用量环两态都在：draft 是空的灰环（`usage={null}`），会话内填充。

Branch / Location chip 都截断在 16rem 以内，44rem 宽下长分支名不会把环挤出去。决策见 `.scratch/draft-live-handoff/PRD.md`。

`accent="brand"`（可选，home-hero）在外壳上加一圈 1px 珊瑚→黄→蓝渐变描边：聚焦时静止显示，`status` 为 `submitted`/`streaming`（发送中）时缓慢流动，空闲不聚焦时完全透明、不改变尺寸；`prefers-reduced-motion` 下描边保留但不流动。用遮罩后的 `::after` 伪元素实现，不加真实 `border`（会挤占既有 padding/圆角计算）。空 draft composer 额外传 `accentFocusRing`，只有它在聚焦时显示静止描边；会话内的 composer 也传 `accent="brand"`，但不传 `accentFocusRing`——描边只标记"run 在进行"（创建期 `isCreating` 走 `submitted`，同样流动），run 结束回到 `ready` 时描边淡出，避免会话里常驻颜色。颜色来自 `apps/desktop/src/app/styles.css` 的 `--pi-coral` / `--pi-yellow` / `--pi-blue`（docs/design/brand.md）。

### 其余 Composer 件

- `ChatPromptSuggestion` + `.Items` + `.Item`：空草稿时的建议卡（Session Draft 的空态，composer 下方，`SESSION_DRAFT_SUGGESTED_PROMPTS`，住在 `features/session-draft/session-draft-composer.tsx`），点选后把文案填入草稿并聚焦输入框。文案是编码任务示例（`Explain this repo's architecture` / `Fix the failing test` / `Add a CLI flag with docs` / `Review my uncommitted changes`），不是通用文案——Pace 是编码 agent 工作台，README 截图里不该出现 "Design a launch page" 这类无关示例。
- `ChatQueuedMessage`：队列里的一条；`presence: "none" | "enter" | "exit"` 由 `usePresenceList` 给，不要自己传 `"enter"`。只有 `pending` 的整卡 `draggable`；拖动中 `isDragging`（45% 透明），目标位 `dropTarget: "before" | "after"`（顶/底边 accent 线，由指针落在卡片上半或下半决定）。`isWithdrawn` 显示 "Withdrawn"，`isSteered` 显示 "Steered"；两者都是终态，无动作、不可拖。重排 RPC 进行中卡片不可拖、drop 忽略。Pi follow-up mode 为 `all` 时整卡不可拖、drop 忽略。
- `ModelSelectorControl`：选中项来自 projection；冷会话缺少目录时异步读取 `list_available_model_controls`，不启动 Agent，读取失败不阻塞历史或发送。Session 创建期间 projection 还没有自己的 controls，此时选中项回落到 draft 提交时写入的 `last model selection`，目录则复用本次 renderer 已读到的那份，选择器因此在 Draft → Live 交接中不会消失；创建期 `isDisabled`。真正切换模型会准备运行环境。`isDisabled` 在队列模式或提交等待期间为 true；`visibleModels` 空数组 = 全显。当前选中模型即使被隐藏也保留并标注。没有第二个模型选择器，失败卡里的 `modelControl` 插槽也用它。
- `ComposerInsertMenu`：一级只有 Add files / Use skill / Chat commands / Use plugin 四项；技能与插件走 `CommandPalette` 搜索。`commands` 默认 `/compact` `/clear`。
- `ComposerAttachmentDrawer`：`items` 为空返回 null；图片走 Thumbnail，文本走 Token。附件逻辑（大小上限、拒收文案、拼进 prompt）全在 `composer-attachment-logic.ts`，从 `composer-attachments/index.ts` 导入，不在页面里重算。

## 思维链

### ChatChainOfThought

`phase: "hidden" | "thinking" | "acting" | "answering" | "settled"` 必填，`"hidden"` 返回 null。计时只有一个入口：run 期间传 `startedAtMs`（组件自己走表），结束后传 `elapsedMs`；两者不同时传。没有 `startedAtMs` 就不显示数字，因为"从挂载起算"会把页面打开时长当成等待。`hasSteps={false}` 时头部退化为纯标签。`outcome` 只有 `"failed"` 一个值，用于「Failed after Ns」。

```tsx
// 正确 — widgets/live-chat/live-chat-message.tsx
<ChainOfThought {...(ticking ? { startedAtMs: view.anchorMs } : { elapsedMs: view.elapsedMs })}
  hasSteps={view.steps.length > 0} phase={view.phase} outcome={view.outcome}>
  <ChainOfThought.Steps>{steps}</ChainOfThought.Steps>
</ChainOfThought>

// 错误 — 没有锚点就自己造一个，时钟从页面打开开始跑
<ChainOfThought startedAtMs={Date.now()} phase="thinking">
```

### Step 行

- `ChatThoughtStep`：`step` 是 `CotStep` 的 `thinking` 分支。live 是 shimmer 的「Thinking…」，收束为「Thought Ns」；无正文就是一行纯 label，**空正文是常态**，不要当异常渲染。
- `ChatToolStep`：`step` 是 `tools` 分支。总结行动词表在 `VERBS`（bash → Ran N commands，read → Read N files…），新工具名先补 `chat-tool-kind.ts` 的 `KIND_ALIASES`，不要在页面里拼文案。收束后的摘要保持单行：失败计数与耗时不收缩、不换行，空间不足时仅截断命令文字；完整内容仍可展开查看。`/design → Components → ChatToolStep` 提供长命令失败样例，运行 `bunx playwright test --config e2e/playwright.layout.config.ts` 验证窄宽度布局。
- `ChatTool` / `ChatToolGroup` / `ChatToolDetail`：只在 `ChatToolStep` 内部与 `/design` 使用。`ToolPartState` 联合是 `"input-streaming" | "input-available" | "output-available" | "output-error"`，映射到 Astryx 的 running / complete / error。
- `ChatStatusLine`：`phase` 只有 `"thinking" | "acting"`，由 `ChatChainOfThought` 在 run 期间自己挂在底部；页面不单独渲染它。
- `ChatChainOfThoughtRail`：Timeline 皮肤，**只在 /design**，等 Appearance 设置页（#81）再接线。不要在页面里用它替代 `ChatChainOfThought`。

```
要在聊天流里表示"正在进行"？
 ├── 整个 run → ChatChainOfThought phase="thinking" | "acting"（它自带状态行与心跳）
 ├── 一行 step → ChatThoughtStep / ChatToolStep（自带 shimmer 与翻页）
 └── 文字级占位 → <TextShimmer>；不要再放 ChatPixelLoader，心跳全局只有状态行一处
```

`TextShimmer` 默认 `tone="default"`：灰色扫光，`Thinking…` / `Loading history…` / `Sending message…` 等运行态占位都用它，`prefers-reduced-motion` 下退化为静态灰字。`tone="brand"` 是 home-hero 专属：珊瑚→黄→蓝扫光，唯一用处是空 draft 态标题里的 "Pace" 字样，reduced motion 下退化为静态三色渐变（不是灰色）。不要把 `tone="brand"` 用在运行态占位上——颜色只标记"Pi 在场"，见 docs/design/brand.md。

打开已有 Session 时先读历史快照；`LiveSessionColumn`（`widgets/live-chat/live-session-column.tsx`）在消息列表末尾渲染一行 `role="status"` 的 `<TextShimmer>Loading history…</TextShimmer>`（`data-testid="session-history-status"`），与创建阶段的 `session-creation-status` 同一形态；读取成功或失败后移除。已有时间线保持可见，冷会话不因此恢复运行环境。历史读取失败使用原有 Retry；执行准备失败在 composer 显示。不要为它引入骨架屏或 Spinner。
