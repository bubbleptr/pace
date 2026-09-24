# 字体与动效

## 字体

- 字族：正文与标题都是 Montserrat（`styles.css:46-51` 覆盖 `--font-family-body` / `--font-family-heading`）；代码用 `--font-family-code`。系统里**没有** `--font-family-mono`。
- 阶梯：Astryx 几何阶梯 `round(14 × 1.2^n)`。可用的只有 `--font-size-sm`(12px) `base`(14) `lg`(17) `xl`(20) `2xl`(24) 及以上；`xs`(10px) 及更小不用于 UI 文字。
- **下限 12px。** 微标签（`USER` / `TOOL` 这类大写小字）= `--font-size-sm` + `--muted` + `uppercase` + `tracking-wider`。现存 18 处 `text-[11px]` 以下是债务，不作范本。

```tsx
// 正确
<span className="text-sm font-semibold uppercase tracking-wider text-muted">Tool</span>

// 错误 — pi-trajectory-ledger.tsx:56 的写法，字号脱离阶梯
<span className="text-[10px] font-semibold uppercase tracking-wider">Tool</span>
```

- Astryx `Text`：默认 `type="body"`；辅助说明、表单提示、空态副标题用 `type="supporting"`（仓库 41 处里 32 处是它）；次要色传 `color="secondary"`。`Text` 的类型 prop 叫 `type`，不叫 `variant`。
- `Heading`：页面标题 `level={2}`，区块标题 `level={3}`，再往下 `level={4}`。没有 `level={1}` 的调用，页面只有一个 h1 由 AppShell 管。
- AppShell 顶部会话标题使用正常字重（`font-normal`）；名称与侧栏共用会话投影，随自动命名、手动重命名和会话切换同步，新对话草稿显示 `New Chat`。
- **对话标题阶梯**（`chat.css:39-93`）：Markdown 以 `headingLevelStart=3` 渲染，`#` = `--font-size-lg` semibold，`##` = base semibold，`###` 及以下 = base medium。规则是"比正文大一档，其余永不小于正文"，因为聊天里的标题是分节，不是文档层级。
- **数字一律 `tabular-nums`**（时长、token 数、百分比、时钟）。原因：`1.2s` 变 `4.7s` 时宽度不变，旁边的 chevron 不会抖。
- 聊天正文行高 1.6，段落间距 `--spacing-3`（`chat.css:53,100`）；这两个值只在 `.chat-message` 作用域内，别处沿用 Astryx 默认。
- 元信息用 `--muted`，不用 `--color-text-disabled`：12px 灰字在白底约 2.6:1，过不了 AA（`chat.css:481-484, 620-626`）。

## 动效

### 时长与缓动

| 场景 | 值 | 来源 |
| --- | --- | --- |
| 悬停 / 按压的 opacity、background 微反馈 | `120ms` `ease-out`（比 `--duration-fast-min` 还短，是白名单例外） | `styles.css:238,248,359` |
| 弹层、tab 切换的 scale + opacity | `150ms cubic-bezier(0.32, 0.72, 0, 1)` | `styles.css:396-406,520-537` |
| 其余进场 / 退场 | `--duration-fast`(175) / `--duration-medium`(410) + `--ease-standard` | Astryx |
| Session Dock 开合 | 进 `250ms` / 出 `180ms`（`sessionDockExitMs`） | `styles.css:554-586` |
| 思维链翻页 | `--cot-flip-duration: 300ms` / 退出 `220ms` | `chat.css:255-256` |
| Draft → Live 交接（composer 从居中下沉到底部、Live Chat 淡入） | `--duration-medium` + `--ease-standard`；`transform` 只在 `[data-draft-handoff]` 期间存在，JS 侧 `draftHandoffMs` 同步为 410ms | `styles.css` `.pigui-draft-handoff__*`、`widgets/live-chat/live-session-column.tsx` |
| 列表行进出场（队列、Surface tab） | `200ms` / `150ms`，退场兜底 `exitTimeoutMs` | `chat.css:1148-1176`、`surface-bar.tsx:88` |
| 像素心跳 | `860ms` 周期（`ChatPixelLoader` 的 `periodMs`） | ADR-0030 |

这张表之外不再新增字面量时长；要新值先从 `--duration-*` 三档九级里选。`--duration-slow-max` 是 1300ms，不能拿来当翻页时长（chat.css:252-254 踩过）。

### 规则

1. **每个动画都写 `@media (prefers-reduced-motion: reduce)` 分支**：过渡直接切换、心跳静止、翻页不产生 `[data-motion]`。仓库 8 处都这么做。
2. **静止态不写 `transform` / `will-change`。** 它们会让元素变成独立 stacking context，Dock 里 surface 第一行的 `z-index: 51` 就压不过 fixed 的 header 拖拽区，tab 点不到（2026-09-06 实测）。动画期间加、`transitionend` 后撤。
3. **只有 Session Dock 的分栏 pane 允许对 `width` 做 transition。** 它是全项目唯一刻意动画的布局属性，因为只有布局变化能让分隔线和 Chat 列跟着走。别处动 `opacity` / `transform`。
4. **列表行进出场用 `usePresenceList`**（`shared/ui/chat/use-presence-list.ts`）：首帧不播进场、移除保留到 `transitionend`、减动效下立即增删。不引入 Motion / Framer：项目没有手势驱动的交互，纯 CSS transition 已可中断。
5. 持有原生视图的 surface（Browser 的 `WebContentsView`）跟不了 CSS transform：动画前截快照、隐藏原生视图，`transitionend` 后重同步 bounds。新 surface 若持有原生资源，走 `SessionDockMotionContext`。
6. 心跳（`ChatPixelLoader`）全局只出现在 `ChatStatusLine` 一处。它是情绪层，信息在 step 行里；两处心跳等于两个"正在跑"的主语。

Sidebar / Header 的图标部件动作遵循 [animated-icons.md](animated-icons.md)：静止态无 transform，只有精细指针悬停且系统未开启减少动态效果时运行，全部沿用 CSS。SVG 分隔线的 `d: path()` 插值是明确限定的图标几何动画，不扩展为布局属性动画。

```css
/* 正确 — chat.css 的减动效分支形态 */
@media (prefers-reduced-motion: reduce) {
  .chat-inline-pager__page { transition: none; }
}

/* 错误 — 静止态常驻 transform，Dock 内会吃掉 surface 第一行的点击 */
.pigui-session-dock { transform: translateX(0); will-change: transform; }
```
