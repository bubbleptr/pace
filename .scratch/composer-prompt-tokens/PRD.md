# Composer Prompt Token 与补全 — 决策记录

前身:`.scratch/composer-attachments/PRD.md`(「Add to prompt」菜单首轮)。本记录取代其中 Commands / Skills / Plugins 三组的插入语义。2026-09-25 定稿范围。

## 问题

首轮菜单把「塞进这次发送的东西」简化成「往 textarea 末尾拼一串字符」,四个入口里只有 Add files 真正生效:

- Skill 插入 `/<name>`,Pi 只认 `/skill:<name>`(`agent-session.js` `_expandSkillCommand`)。
- `/compact` 是 Pi TUI(`interactive-mode.js`)的命令,`AgentSession.prompt` 不处理,Pace 也没拦截,最终作为普通文本发给模型。
- `/clear` 不是 Pi 命令(`slash-commands.js` 里只有 `/new`)。首轮 PRD 称其为「Pi 实有命令」是错的。
- Plugin 插入 `@<extension 路径>`,Pi 没有这种语法;extension 靠自己注册的 `/命令` 调用。
- skill / 模板 / extension 命令都要求**整段 prompt 以 `/` 开头**,`insertIntoDraft` 却总是追加到末尾。
- 数据来自全局 `get_config_inventory`(`projectTrusted: false`、cwd = agentDir),看不到项目级资源,也拿不到 extension 注册的命令名;`promptTemplates` 读出来了却没用上。

## 调研:其他 GUI 怎么处理 `/` 动作命令

| 工具 | `/` 菜单内容 | 对 CLI 内置命令 |
| --- | --- | --- |
| Codex app | app 级、会打开界面的命令(`/review` `/status` `/mcp` `/plan` `/goal`)+ skills + prompts | `/new` `/clear` 明确只留在 CLI |
| Claude Code(VS Code) | 附加文件、切换模型、切换思考模式、查看用量 + Customize 分区 | 大部分 CLI 命令没有搬过来;issue #8590 / #8569 抱怨命令缺失或被当成普通问题发出去 |
| Cursor | 所有可运行项:自定义命令、skills、subagents | — |
| Zed | 列表由 agent 通过 ACP `available_commands_update` 下发,客户端不写死 | — |

**结论**:`/` 只列 Pi 能执行的内容(skills、prompt 模板、extension 命令),数据来自 Pi,不硬编码任何内置命令。新建会话、fork、重命名、切换模型和思考级别都已经有按钮。手动 compact 是唯一缺 GUI 入口的动作,另开 follow-up,放到上下文用量环上。手敲 Pi TUI 内置命令(如 `/compact`)时给出提示,不静默当成 prompt 发出。

## 定稿方向

### 输入框

`ChatPromptInput` 的原生 textarea 换成 Astryx `ChatComposerInput`(contentEditable,支持 `/` 和 `@` 触发补全、行内 token、序列化)。Enter / Shift+Enter、中文输入法、粘贴和拖入文件、运行中锁定输入、自动增高,行为保持不变。本轮关闭 `hasHistory` 和 `pasteAsToken`。

### Token 语法(序列化后就是 Pi 原生语法)

| 类型 | 触发 | 序列化 | 位置与数量 |
| --- | --- | --- | --- |
| Skill | `/` | `/skill:<name>` | 一条消息最多一个命令 token,固定在开头;再选一个就替换 |
| Prompt 模板 | `/` | `/<name>` | 同上 |
| Extension 命令 | `/` | `/<invocationName>` | 同上;排队模式下从 `/` 补全和 `+` 菜单里隐藏,已有 token 时提交会被拦下并说明原因(Pi 不允许把它放进队列:`cannot be queued`) |
| 文件 / 目录 | `@` | `@<相对路径>`(目录带结尾 `/`) | 任意位置,可以有多个;纯聊天工作区不提供 |

`+` 菜单与 `/`、`@` 共用同一份数据。选中后插入的 token 和手动触发得到的完全一样(命令 token 不管光标在哪都插到开头)。菜单项:Add files / Skills / Prompts / Commands / Reference file,某组为空就隐藏。

### 数据来源

- **运行中的会话**:从 Pi 会话读取,和 Pi 内部 `getCommands()` 读的是同一份数据:`extensionRunner.getRegisteredCommands()`、`promptTemplates`、`resourceLoader.getSkills()`。
- **草稿 / 冷会话**:按根目录静态解析。设置与 `session-process-entry.ts` 一样用 `SettingsManager.create(root, agentDir)`(经核实只读),但**不用 `DefaultResourceLoader`**:它的 `reload()` 调 `packageManager.resolve()` 时不传 `onMissing`,缺失或版本不符的包会被实际安装,只读查询不能有这种副作用。改用 `DefaultPackageManager.resolve(async () => "skip")`(与 `workspace/config.ts` 相同),再读 skill / 模板的元数据。只返回 skills 和 prompt 模板;extension 命令要等运行时起来才有。用一个与 `DefaultResourceLoader` 对照的测试防止两边结果漂移。
- **Trust**:Pace 会话实际上总是信任项目(`SettingsManager.create` 默认 `projectTrusted = true`,loader 没有设置 `resolveProjectTrust`),静态解析保持一致。
- **Worktree 草稿**:按项目目录解析。会话起来后改用运行时列表,两者的差异(例如项目目录里未提交的 `.pi/`)以运行时为准。
- **文件搜索**:以 Pi 的 cwd(checkout root)为根,遵守 `.gitignore`(`git ls-files --cached --others --exclude-standard`),不是 git 仓库时退回到有上限的遍历。

### 消息气泡

- Pace 发出的消息:气泡内容是 Gateway 回显的原始输入(`pi-sdk-driver.ts` `body: input.prompt`,写入 Session Event Journal),本来就不会展开;用同一套 token 定义(`ChatTokenizedText`)渲染即可。
- 只有 Pi 日志的历史:`<skill name=… location=…>…</skill>` 折叠成 skill token,后面跟用户参数。
- **不在 UI 上展开**任何 skill 或模板正文。
- 自动标题改为使用原始输入,不再读 Pi 展开后的文本。

### 实现约束(读 Astryx 0.3.0 源码确认)

- `insertToken` 会在 token 后面补一个 NBSP(`\u00A0`)。Pi 按普通空格切分命令名(`text.indexOf(" ")`),所以发送前必须把 NBSP 换成空格。这一步只能在提交时做,不能回写到 value:回写后 value 和组件刚发出的不一致,组件会用 `textContent` 重写整个输入框,token 就被抹平了。
- 外部写入 value 时组件用的是 `textContent`,会把 token 抹平成纯文本。因此菜单插入走 handle,不走 value;恢复草稿、injection 之后,再把开头的命令文本重新变回 token。
- `/` 触发只看前一个字符是不是空白,不管位置。所以只有「目前整段输入就是 `/查询`」时才把 `/` trigger 传进去。
- 只要传了 trigger,可编辑元素的 role 就是 `combobox`,不传时是 `textbox`。为了让 role 不随输入跳变,始终挂一个永远不会被触发的占位 trigger,role 固定为 `combobox`。

### 未发送草稿

仍以序列化字符串保存(含 NBSP)。重新打开时,如果开头是 catalog 里已有的命令,就重新变回 token。Astryx 在输入框内不会调用 trigger 的 `deserialize`,所以这一步由 Pace 自己做。

### Pi TUI 内置命令

`BUILTIN_SLASH_COMMANDS` 不在 Pi 的公开导出里,所以在 core 里维护一份名字清单,再用后端测试直接读 Pi 包里的 `dist/core/slash-commands.js` 做对照,防止漂移。提交时如果第一个词是这些命令、而 catalog 里又没有同名项,就拦下来,并提示「这是 Pi 终端命令,Pace 不执行」。

## 已知限制

- 只有 Pi 日志的会话,prompt 模板已经展开(`substituteArgs` 不可逆),按原文显示。
- 一条消息只能有一个 skill:这是 Pi 自己的规则。Pace 不自行展开 skill,以免绕开 Pi 作为唯一执行方的原则。

## 拆分(stacked PR)

1. 后端:`list_prompt_commands`(运行时 / 静态)与 `search_workspace_files`,core 契约,浏览器环境下的空结果兜底。
2. 输入框换成 `ChatComposerInput`,行为不变,测试迁移。
3. `/` 命令 token、`+` 菜单重组、未知 Pi TUI 命令提示、排队模式下 extension 命令置灰、草稿序列化。
4. `@` 文件 token。
5. 气泡 token、Pi 日志中 skill 块折叠、自动标题改用原始输入。

每个 PR 同步更新 `/design`、`docs/design/chat.md`,以及 UI intent 的 regions 表(若有组件改名)。

## 明确不在本轮

手动 compact 按钮(follow-up)、一条消息多个 skill、`@` 引用会话 / URL / 符号、长文本粘贴变 token、↑ 调出历史消息。
