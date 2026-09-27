# ADR-0035：解冻只读 Files Surface，Changes Surface 改为堆叠式全量 diff

- 状态：Accepted
- 日期：2026-09-08

## 背景

ADR-0007 把 terminal 和 file tree 一起冻结在首版之外；Terminal（PR #147）与 Browser（ADR-0029）已先后解冻并停靠进 Dock（ADR-0028 / ADR-0032），File surface 是三者里最后一个仍受冻结的。

Changes surface 目前是「左侧文件列表、右侧单文件 diff、点一个看一个」。审阅一次 agent 的改动要把每个文件都点一遍，看不到整体；而 Dock 已经能拖到很宽，容得下把全部 diff 摊开。

用户明确提出两件事：Changes 要能从上到下一路滚完所有文件的 diff；既然有了文件列表，顺手要能看代码。两者都以 Session 的 checkout 为根，与其他 Built-in Surface 同构。

## 决策

### 1. Changes：堆叠所有 diff，右侧文件清单只是大纲

- 左列自上而下堆叠每个有变化文件的 diff，每个文件是一个可折叠区块（Astryx `Collapsible`），默认全部展开；折叠的区块不挂载 diff 渲染器。
- 右列是文件清单，标题即文件数；点一行滚到对应区块并展开。它不再是「当前选中文件」的选择器。
- 第一行工具条保留状态与刷新，并容纳「全部折叠 / 展开」。diff 固定为上下（unified）对比；Unified / Split 切换从工具条移除，若要做应放进 Settings，不再占 surface 的入口。
- 现有的 clean / non-git / 错误 / 截断状态一律不变；后端读取契约（`SessionChanges`）不变。

### 2. 新增 Built-in Surface：Files（只读）

- Rail 第二格，id `files`，与 Changes、Terminal、Browser 走同一注册表。
- 左侧目录树，目录按需懒加载；右侧文件预览，用 `@pierre/diffs` 的 `File` 渲染器，和 diff 共用高亮与主题。
- 根目录是 Session 的 diffRoot——与 Changes 显示路径的根一致，两边看到的路径指向同一个文件。
- 后端新增两个 RPC：`list_session_directory` 与 `read_session_file`。根由后端从 Session Projection 解析，渲染进程不能指定根；拒绝绝对路径、`..` 和 NUL；对目标做 realpath 校验，符号链接逃逸出根的既不列也不读。单目录最多 2000 条，单文件最多 1 MiB（超出按行截断并标记），首 8 KiB 含 NUL 视为二进制、不返回内容。
- 后续补充的第三个 RPC `resolve_session_files`（聊天行内代码文件引用用）：批量确认一组 diffRoot 相对路径里哪些是真实存在的普通文件，输入只取前 100 条，单条无效只排除自身，不影响整批。
- 只读。不做编辑、不做搜索、不做「在外部编辑器打开」。这些属于后续决策，不在本 ADR 内。

### 3. ADR-0007 的边界仍然成立

ADR-0007 要求 terminal / file tree 一旦加入必须是 Session-scoped、绑定 Execution Checkout，而不是全局 IDE。Files surface 符合这条：它没有全局工作区概念，随 Session 切换，Session 没有 checkout 时不渲染。ADR-0007 关于「不复制 IDE 面板」的精神保留——Files 不承担编辑器职责。

## 后果

- `SessionSurfaceId` 扩为四个；CONTEXT.md 的 **Built-in Surface** 词条与 **Live Session View** 的「文件树仍不包含」随之更新。
- Changes 面板同时挂载多份 diff 渲染器，上限由后端既有的 200 文件 / 2 MiB 总补丁限制兜底；折叠即卸载是性能前提，不是可选项。
- 符号链接一律列出但不可进入、不可预览，包括指向根内部的（monorepo 里 `packages/*` 软链就是这种）。这是有意收窄：realpath 校验只保证不逃逸，放行根内软链需要再做一次判定与去环，留给后续决策。
- Files 的目录列表不读 `.gitignore`：`node_modules` 之类会出现在树里，但懒加载让它不成为性能问题。若之后要隐藏忽略项，需要新的决策。
