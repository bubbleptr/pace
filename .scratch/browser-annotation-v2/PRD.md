# Browser Annotation v2：对齐 Codex 的标注体验

> 前身：`.scratch/embedded-browser/PRD.md`（v1，S2 / S3）与 `docs/adr/0029-embedded-browser-surface.md`。
> 调研对象：Codex / ChatGPT 桌面端内置浏览器的 Annotation mode（官方文档 `developers.openai.com/codex/app/browser`、Annotations Extensibility 文档、openai/codex#22719 等 issue）。
> 用户拍板（2026-10-10）：**标注以结构化附件进入 composer（推翻 v1「只落草稿、不新增结构化附件」）；评论框里 Enter 默认「保存并继续攒」。**
> 落地：切片开成 GitHub Issues 后在本文「切片」段回链。

## 问题

v1 的标注能用，但每一步都比 Codex 多一次操作、少一份反馈：

1. 点元素只落一个序号，要再点序号才能写评论；不写评论也算一条标注（`(no comment)`），同一元素可重复标。
2. 评论框是 220px 单行 `input`，没有保存 / 取消 / 删除，失焦即提交；只能「全部清空」，不能删单条。
3. 命中的是 `composedPath()[0]`（最深节点），常选中 `span` / `svg path`；没有办法选父元素；高亮框没有任何标签。
4. 已标注元素只在左上角留一枚徽章，没有轮廓；嵌套元素的徽章叠在同一角；评论框贴边时不翻转。
5. 覆盖层颜色硬编码（`#6d28d9`、白底），与 Pace 主题、暗色模式脱节；进入模式后页面上看不出「正在标注」。
6. `To composer` 把一整段 markdown 追加进草稿 + 一张整视口截图：草稿里混着模板文本；视口外的标注拍不到；发出后标注仍留在页上，再点一次就重复发送。
7. 每个新文档（整页刷新、HMR 失败回退刷新）主进程直接清空标注，评论全丢。

Codex 的对应体验：点选即打开评论编辑器、保存后作为下一条消息的附加上下文、可拖拽框选区域、编辑 / 删除已有评论、标注不再混进用户自己写的文本。

## 决策

### 1. 标注生命周期：先编辑，保存才算数

```
hover ──click──▶ editing ──Save / Enter──▶ saved（pending）──消息发出──▶ consumed（从页面和 composer 移除）
                    │                         │
                    └──Cancel / Esc──▶ 丢弃     └──Delete──▶ 移除
```

- 点击元素**立即**在元素旁打开编辑器并聚焦；此时还不是标注，取消即无痕。
- **评论必填**：空评论时 Save 禁用、Enter 无效。v1「没评论的标注也是标注」的取舍作废：先编辑后保存的流程里，空评论只是误点。
- 点击已保存的元素或它的徽章 → 打开该条的编辑器（编辑态多一个 Delete），**不再新增重复标注**。
- 一次只开一个编辑器；编辑器开着时点别的元素 = 先按 Cancel 语义丢弃未保存内容，再开新的（未保存且有内容时编辑器抖动一下提示，不切走；Codex 同款）。

### 2. 键位

| 键 | 编辑器内 | 标注模式、编辑器未开 |
|---|---|---|
| `Enter` | 保存，留在标注模式继续攒 | — |
| `Shift+Enter` | 换行 | — |
| `Cmd/Ctrl+Enter` | 保存并**立即发送** composer（见决策 4） | 立即发送 composer（有 pending 评论时） |
| `Esc` | 取消编辑 | 退出标注模式 |
| `↑` / `↓` | — | 悬停目标切到父元素 / 回到子元素 |
| `Cmd/Ctrl+Shift+A` | — | 切换标注模式（页面内由 overlay 监听，Pace 窗口内由 Browser 面板监听） |

Codex 默认是 Enter 直发、`Cmd+Enter` 攒（#22719 下大量反对）；Pace 反过来，与 composer 自身「Enter 发送」不冲突，因为评论框的「发送」是保存到待发区。

### 3. 覆盖层交互

- **目标收敛**：从最深节点向上，跳过行内装饰节点（`span`/`b`/`i`/`em`/`strong`/`svg` 子节点/小于 8×8 的元素），停在最近的「有意义目标」：交互控件（`a`/`button`/`input`/`select`/`textarea`/`label`/`[role=button]`）、媒体（`img`/`svg`/`video`/`canvas`）、带 `id` 或 `data-testid` 的元素、或块级文本容器。`↑`/`↓` 在这条祖先链上手动移动。
- **悬停标签**：高亮框上方一枚小标签 `tag.firstClass · W×H`，有 `source` 时追加 `file:line`。
- **已保存标注**：保留细轮廓 + 徽章；徽章贴在轮廓**外侧**右上角，与已有徽章重叠时依次错开。编辑器默认在元素下方，空间不足翻到上方，水平方向夹进视口。
- **模式可感知**：视口内侧 2px 主题色描边 + 顶部居中一枚「Annotating · Esc to exit」标签（均在 closed shadow root 内，`pointer-events: none`）。
- **主题**：渲染层在开启标注模式时从计算后的语义 token（`--primary`、`--primary-foreground`、`--background`、`--foreground`、`--border`、`--muted-foreground`）读出颜色值，随 `set-design-mode` 命令下发；overlay 用 `CSS.supports("color", v)` 逐个校验，不合法回落内置默认值。不在页内加载任何 Pace 样式表。
- **工具条**：`Design` 改名 `Annotate`（ToggleButton，仍是准星图标）；`Clear marks` 只清当前 tab 的评论；**移除 `To composer`**（被决策 4 取代）；右侧计数改为 `N comments`。
- 编辑器仍在页内 closed Shadow DOM 里，用 textarea + 原生按钮实现。「透明子 `WebContentsView` 承载 React 编辑器」不在本轮（见范围外）。

### 4. 结构化附件：Browser Comment 进 composer

- **单一事实来源在主进程**：Session 级评论仓（不是 tab 级），每条：`{ id, tabId, url, title, viewport, element(selector/tag/text/rect/source), comment, kind: "element" | "area", stale, createdAt }` + 一张局部截图。关闭 tab 只移除页上标记，评论仍在仓里；窗口关闭/应用退出即丢（与图片附件不落盘的策略一致）。
- **composer 拉取，不复制**：`FullChatComposer` 订阅本 Session 的评论仓（新增只读命令 + 事件），在附件抽屉里渲染为独立分组「Browser comments」，每条一个条目：缩略图 + `#n 评论摘要`（单行截断）+ 移除。移除 = 调主进程删除，页上标记同步消失；页上删除，composer 条目同步消失。没有第二份副本，因此不存在同步漂移。
- **编号**：`#n` 是发送前 Session 内 pending 列表的顺序号，增删后重排；页上徽章同步显示同一编号。局部截图**不含任何覆盖层元素**（截取前整层隐藏），所以重排编号不会让截图与文本对不上。
- **发送**：composer 的 `submitDraft` 在用户草稿之后追加 core 格式化的评论块，图片按评论顺序附在 `images` 里；Pi 收到的仍是 `string + RuntimePromptImage[]`，Gateway / Pi 侧零改动。`send_prompt` / `queue_follow_up` / 从队列 steer 三条路径天然覆盖（评论在入队时已烤进消息）。
- **消费**：提交成功后按**构建时快照的 id 列表**调 `browser_consume_annotations`；提交期间新存的评论不受影响。提交失败则全部保留。
- **Cmd/Ctrl+Enter 直发**：页面 → 主进程 `submit-requested` → 渲染层事件 → composer 执行与点击发送相同的 `submitDraft`（新增 `requestComposerSubmit(sessionId)`，与 `injectIntoComposer` 同范式，返回是否有 composer 接住；没接住时 Browser 面板一行提示，评论保留）。
- **局部截图**：保存时由 overlay 隐藏整层、等两帧，再通知主进程；主进程 `capturePage(rect)`，rect = 元素矩形外扩 48 CSS px、最小 320×200、夹进视口，按 CSS 像素降采样（沿用 `downsampleToCssWidth`）。状态事件只带 `hasImage`，图片走单独的只读命令按 id 取（缩略图与发送时用），不在每次状态广播里搬 data URL。
- **格式化**：core 新增 `formatBrowserComments(comments)` 替换 `formatBrowserAnnotationPrompt`：每条 `#n` + selector/tag + 评论（多行保留，逐行缩进）+ text/source；无截图的条目附 rect；`stale` 条目注明「元素已不在当前页面，按保存时描述」。模板由测试锁定。

**S3 实现时的修订（#448）：**
- 不按 URL 重新分组：评论保持 Session 顺序（`#n` 升序），URL 变化时插入一个 `Page:` 段落头。重新分组会让编号乱序，与页面徽章、图片顺序都对不上。
- 评论图片附在消息图片的**最后**，按评论顺序排列；有截图的条目标 `[screenshot]`，标题句说明这一约定。用户自己附的图片在前。
- 抽屉条目是 `Token` chip（`#n 首行摘要` + 移除，stale 用黄色并带说明），**不显示缩略图**；截图只在发送时按 id 拉取。
- 页面内 Cmd/Ctrl+Enter：overlay 在 `annotation-saved` 之后发 `submit-requested`；主进程等本 Session 在途的局部截图落定后，再经浏览器事件通知渲染层；Browser 面板调用 `requestComposerSubmit(sessionId)`，没有 composer 接住时给出提示。
- v1 的 `To composer`、`browser_capture_annotation` 整视口截图路径与 `injectIntoComposer` 一并移除。

### 5. 跨文档保留与重新定位

- 新文档 `ready` 时，主进程不再清空，而是下发 `restore-annotations`：当前 tab 中 URL 与新文档相同（比较 origin + pathname + search，忽略 hash）的评论。`did-navigate-in-page`（SPA 路由切换）同样重发。
- overlay 用 selector 唯一解析元素；解析不到时用 MutationObserver 继续尝试最多 5s（等 SPA 渲染），仍失败则上报 `stale`。stale 评论在 composer 条目上显示警示，仍可发送（文本 + 保存时的截图仍有效）。
- 页上只显示与当前 URL 匹配的评论标记；其他页面的评论只在 composer 里。

### 6. 区域框选

- 标注模式下按住拖动超过 4px 即进入框选，松开打开编辑器；`kind: "area"`，记录视口矩形，`selector` 取完整包含该矩形的最小元素作为锚点，并记录相对锚点的偏移，供决策 5 重新定位。
- 单击仍是元素选择；框选不吞页面滚动。

**S4 实现时的修订（#449）：**
- 不加 `kind` 字段：`BrowserAnnotationElement` 增可选 `area: { x, y, width, height }`（相对锚点边框盒左上角），有即为区域评论；`rect` 是保存时区域自身的视口矩形，局部截图直接沿用。两个字段表达同一事实只会多一种不一致的可能。
- 锚点从按下点的最深节点沿祖先链上爬，取第一个完整包含矩形、且不是 SVG 内部节点的元素，兜底 `body`。区域评论不带 `text`（锚点文本描述的是元素而非区域）。
- 区域不「占有」锚点：点击锚点元素仍新建元素评论，多个区域可共享同一锚点。
- 拖动中 Esc / `pointercancel` / 松开在窗口外（`buttons === 0`）都取消框选，随后的 click 被吞；任一边小于 4px 视为误触。已保存区域用虚线轮廓，元素用实线。模式标签改为「Click or drag to annotate · Esc to exit」。
- 格式化：区域条目标题为 `#n [screenshot] area in \`selector\` (tag)`，**总是**输出 `- area: W×H at (x, y)`（截图有外扩边距、无框线，模型需要确切边界）；composer chip 为 `#n Area · 摘要`。
- （#455 review 修订）`area` 的偏移按锚点滚动内容计：保存时加上锚点 `scrollLeft`/`scrollTop`（锚点为文档滚动元素时除外，其 rect 已随页面滚动），否则锚点自身滚动内容时轮廓会漂。带截图的区域条目同时给出截图内坐标与视口坐标（`- area: W×H at (sx, sy) in its screenshot; (x, y) in the viewport`），截图按 `resolveCommentCropRect`（已移入 `packages/core`）的同样规则裁出。

## 切片

依赖顺序：S1 → S2 → S3；S4 依赖 S1；S5 收尾。

1. **S1 覆盖层交互重写**（#446；`electron/browser-annotation-overlay.ts`、`browser-annotation.ts`、`browser-surface.tsx`）：决策 1、2（除 `Cmd+Enter` 发送）、3。标注获得稳定 `id`（overlay 侧 `crypto.randomUUID()`，主进程按字符串 ≤64 校验）；协议仍发全量列表，v1 的 `To composer` 本切片暂时保留可用。
2. **S2 主进程评论仓**（#447；`browser-host.ts`、`main.ts`、`browser-protocol.ts`、preload）：决策 4 的仓 / 局部截图 / 读、删、消费命令与事件，决策 5 的跨文档保留与 stale。
3. **S3 composer 结构化附件**（#448；`full-chat-composer.tsx`、`shared/ui/composer-attachments/`、`entities/session/composer-injections.ts`、`packages/core/src/browser-annotation.ts`、`session-browser-panel.tsx`）：决策 4 的抽屉分组、发送与消费、`Cmd+Enter` 直发、`formatBrowserComments`；移除 `To composer` 与旧注入路径。
4. **S4 区域框选**（#449）：决策 6。
5. **S5 文档收尾**（#450）：ADR-0029 追加修订节（推翻「只落草稿」、评论仓归主进程、跨文档保留）；`CONTEXT.md` 加 **Browser Comment** 词条；`/design` 页更新 `BrowserSurface` 工具条与附件抽屉新分组；`docs/self-built-ui.md`、`docs/design/` 对应条目。

## 验收标准

- [ ] 点击元素即出现已聚焦的编辑器；Esc 取消后页面无残留；空评论不可保存；同一元素再点进入编辑而非新增。
- [ ] Enter 保存并留在标注模式；Shift+Enter 换行；Cmd/Ctrl+Enter 保存并以当前草稿 + 全部 pending 评论发出一条消息。
- [ ] 保存后 composer 抽屉「Browser comments」立刻出现对应条目（缩略图 + `#n` + 摘要）；任一端删除，另一端同步消失。
- [ ] 发出的消息：用户草稿在前，评论块在后，图片按 `#n` 顺序；发送成功后页面与 composer 中这些评论消失，发送期间新存的评论保留；发送失败全部保留。
- [ ] 运行中 composer 处于队列模式时，评论随入队消息一起烤入并被消费。
- [ ] 整页刷新后同 URL 的评论标记回到原元素；元素消失的标为 stale 且仍可发送。
- [ ] 暗色主题下覆盖层使用 Pace 语义色；标注模式有可见描边与提示标签。
- [ ] 视口外（已滚走）的评论截图仍是保存时的局部图。
- [ ] Vitest：overlay 交互（jsdom）、主进程评论仓与消费的竞态、core 格式化模板、composer 抽屉与提交路径；Electron E2E：标注 → 保存两条 → Cmd+Enter → 断言发出的 prompt 与图片数。
- [ ] `bun run typecheck` / `lint` / `test` / `build` 全绿。

## 范围外

- Codex 的 **Adjust** 样式微调（字体 / 间距 / 颜色实时预览并随评论发送）。
- 页面侧扩展协议（类似 `oai-annotatable` / `oai-annotation-metadata` 的 `data-pace-*` 属性）；与 #159（reactName / source）一并后续评估。
- 文字范围标注、跨源 iframe 内元素（仍等 CDP）。
- 用透明子 `WebContentsView` 以 React + Astryx 渲染编辑器。
- 评论持久化到磁盘、跨应用重启保留。
- Browser 面板内的评论列表（composer 抽屉已承担列表职能）。

## 风险

- 评论多时图片数随之增长，占用上下文；本轮不设上限，以真实使用反馈再定。
- 选择器重新定位依赖页面结构稳定；`nth-of-type` 链在列表重排后可能命中错误元素——stale 判定只能识别「找不到」，识别不了「找错」。
