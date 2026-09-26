# Sidebar、Header 与 Settings 的动画图标

2026-09-12 选型：先从现成动画库挑选语义与外观合适的图形，再映射到 Pace。现有 glyph 不构成兼容性要求。Trajectory 选 Hugeicons Animated 的 `history`；Usage 选 Lucide Animated 的 `chart-pie`；Packages 选 Hugeicons Animated 的 `puzzle`。插件入口的图标后续另选。

本批用于 AppShell 的 Sidebar、Header 与 Settings 弹窗的五个分类导航。Header 右上角的 Dock 开关也使用动画，Dock 内部的栏位图标保持原实现；项目目录的展开指示已有状态反馈，不叠加悬停动画。

| 使用位置 | 导出 | 来源图标 | 动作 |
| --- | --- | --- | --- |
| Trajectory 导航与 Open Trajectory 菜单 | `AnimatedHistory` | Hugeicons `history` | 外环与指针倒转 |
| Usage 导航 | `AnimatedChartPie` | Lucide `chart-pie` | 扇区向右上方分离，在同一轮内归位 |
| Packages 导航 | `AnimatedPuzzle` | Hugeicons `puzzle` | 拼图片抬起、轻转后落位 |
| New Chat 导航 | `AnimatedNewChat` | Hugeicons `message-add-01` | 对话框轻动，加号弹出 |
| Settings 导航 | `AnimatedSettings` | Hugeicons `settings-01` | 外齿轮转动，轴心静止 |
| Header 的 Sidebar 开关 | `AnimatedSidebar` | Hugeicons `panel-left` | 分隔线沿外框收起、展开 |
| Header 的右侧 Dock 开关 | `AnimatedSidebarRight` | Hugeicons `panel-left` 水平镜像 | 右侧分隔线沿外框收起、展开 |
| Chats / Projects / 项目行的新增按钮 | `Plus` | 原有 Hugeicons 静态图标 | 无动画 |
| 项目与会话的更多菜单 | `MoreHorizontal` | 原有 Hugeicons 静态图标 | 无动画 |
| Settings → Providers | `AnimatedKey` | Hugeicons `key-01` | 钥匙轻推、转动后回位 |
| Settings → Models | `AnimatedRobot` | Hugeicons `robot-01` | 天线摆动、轻微歪头与眨眼 |
| Settings → Chats | `AnimatedMessage` | Hugeicons `message-01` | 气泡展开，文字线随后伸展 |
| Settings → Changelog | `AnimatedFile` | Hugeicons `file-01` | 纸张微动，内部文字线伸缩 |
| Settings → About & Updates | `AnimatedInformationCircle` | Hugeicons `information-circle` | 圆框、字干与圆点轻弹 |

## 接入与状态

- 只从 `shared/ui/icons.tsx` 导入。实现集中在 `animated-icons.tsx`，保留原库 SVG 几何与动作含义，用现有 CSS 动效机制接入，不增加 Motion 运行时依赖。
- 根节点是 SVG；接受 `className`、`size` 与其余 SVG props，React 19 的 `ref` 直接指向 SVG。默认 `size=24`、`currentColor`、`strokeWidth=1.5`，导航仍使用现有的 16px 尺寸。Lucide 的单枚图形也采用相同线宽。
- 默认装饰性图标 `aria-hidden=true`；可访问名与 tooltip 留在现有按钮。新增图标不创建按钮或新的焦点节点，也不改变点击逻辑。
- 只有鼠标实际移入按钮或菜单项时播放一轮，持续悬停不循环。点击不重播，也不产生图标按压缩放；路由重建时若光标停在控件上，保持静止。离开悬停恢复静止，不额外播放归位动画。键盘聚焦、触屏和系统减少动态效果设置均不触发动画。
- `isAnimated=false` 强制静态。禁用按钮保持静态；只读状态标记、列表批量图标不用这些动画导出。
- 不放大按钮，也不改变 Sidebar 既有的颜色反馈与透明背景。动画只作用于 SVG 内部部件，静止态不保留 `transform` 或 `will-change`。
- 所有图标整轮时长统一使用 `--pigui-icon-motion-duration`，按用户指定固定为 800ms，不随主题变化；部件的延迟包含在这一轮内，不因顺序动作延长总时长。SVG 内部的坐标、角度、关键帧百分比是原图几何参数，不是界面间距 token。
- `panel-left` 的分隔线通过 CSS `d: path()` 做 SVG 几何插值，运行于 Electron Chromium；减少动态效果时直接使用 SVG 的原始 `d`。右侧版本用 SVG 组的 `translate(24 0) scale(-1 1)` 镜像绘制坐标，共用同一份图形与动画；不在根节点保留 CSS transform。

`/design → Components → AnimatedIcons` 展示全部 14 个导出（13 种图形，含侧栏左右两个方向）的导航尺寸、常规尺寸、禁用与强制静态状态。

Settings 的供应商品牌标志、Pace Logo 与版本时间轴圆点保持静态；窄屏仍使用原有文字标签。`robot-01` 保留静止图形与天线、头部、眨眼动作，省去悬停时临时生成的三段屏幕线条，以适应 16px 导航。`message-01` 的文字用伸展与淡入表达写入，不引入路径描边动画。选型理由见 [Settings 图标评估](settings-icons-evaluation.md)。

来源与授权见 [动画图标许可证](../licenses/animated-icons.md)。
