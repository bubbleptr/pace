# 模型选择器精做 — 决策记录

Issue: [#99](https://github.com/BubblePtr/PiGUI/issues/99) · 前身规格见 `.scratch/composer-redesign/PRD.md` 的"模型/思考力度选择器"节 · 原型探索于 `/proto/model-selector`(已拆除),2026-08-13 定稿。

## 定稿方向:Flat(扁平列表 + 模型选项飞出层)

### 一级面板

- **扁平模型列表,不按 provider 分组**。fast 兄弟模型归并为一族,列表只显示 base 模型一行。
- 顶部**搜索框**:按名称 / modelId / provider 分词过滤;过滤后飞出层若目标模型不在可见列表中则关闭。
- 底部 **Add Models** 入口(禁用态),指向设置页的可见模型管理([#102](https://github.com/BubblePtr/PiGUI/issues/102),future)。
- **边距收紧**(容器 p-1),信息密度优先;无 "Model" 标题行,搜索框即标题。

### 二级飞出层(悬停/点击模型行弹出)

- 纵向结构:头部 = 模型名 + 只读规格行(context window / max output / 图像输入图标);**Reasoning** 竖排列表(含 Off,选中打勾,点击 = 一次提交模型 + 档位);**Fast Mode** 开关(仅当存在 fast 兄弟时渲染)。
- 位置:顶部对齐悬停行,**对视口 clamp**(列表被过滤得很短时飞出层可上移越过面板顶,但永远完整在屏幕内)。
- 与面板留 28px 缝隙 + 32px 隐形悬停桥(沿用 composer-redesign 轮验证值)。

### 悬停意图:safe triangle(几何法)

- 顶点 = 指针 ~200ms 前的轨迹点(`POINTER_TRAIL_MS`),底边 = 飞出层实时 `getBoundingClientRect()` 左边缘 ± 8px(`TRIANGLE_PAD_PX`)。
- 指针在三角形内 → 判定"正在赶往飞出层",每 100ms 重估;**离开三角形或原地停下(200ms 内位移 < 3px)→ 立即切换**,无固定延迟。
- 指针已达飞出层 → 放弃待定切换;点击行 → 绕过三角形立即提交。
- **高亮与飞出层只属于指针所在之处**:指针在面板内移到列表/飞出层集群之外(搜索框、`Add Models` 行、面板内边距)→ 立即收起(2026-10-07 修正;此前 `Add Models` 悬停时上一行仍保持高亮与飞出层)。
- 离开整个面板保留 300ms 关闭宽限期兜底(Radix/Floating UI 同款混合策略),该宽限期仍服务于"行 → 飞出层"的 28px 缝隙跨越。
- 曾用时间法(120ms 停留阈值)过渡,因主动换行有钝感被几何法替换。

### 事实依据(调研结论,勿再翻案)

- **价格不展示**(用户裁定)。
- **fast 是独立模型条目**(Pi 目录 `grok-3`/`grok-3-fast`),SDK 无 fast 字段;UI 按 modelId `-fast` 后缀归并为族。切 Fast 可能 snap 掉 thinking 档位(fast 版档位更少)。
- **contextWindow 是模型只读硬上限**(超出 provider 直接 4xx),Pi 目录每个 model id 仅一条记录一个窗口值,无 256K/1M 双条目,pi-ai 未实现 Anthropic context-1m beta。只做展示。
- **自动压缩配置**(CompactionSettings)不在本 issue;context usage 实时指示器已立 [#101](https://github.com/BubblePtr/PiGUI/issues/101)。

## 被否掉的方向(原型变体)

| 变体 | 轴 | 否因 |
| --- | --- | --- |
| Baseline | 现状复刻:单层列表 + Thinking 滑杆 | 模型多后列表过长;能力配置不可见 |
| Ledger | provider→模型两级,每行满规格标注 | 每次打开都有视觉噪音;两级导航属多余(模型数可控) |
| Focus | 两级 + 悬停详情条 + 主面板 Fast 开关 | Fast 开关"选中才出现",可发现性差(用户直接反馈找不到) |
| Stack | 两级,每模型卡片内嵌 thinking chips | 飞出层过高过重 |
| Inspector | provider→模型→选项三栏 | 中间栏在模型少的 provider 下大片空白;provider 分组本身被裁掉 |

## 落地实现(2026-08-13)

- 协议:`RuntimeModelCapability` 增加可选 `contextWindow` / `maxTokens` / `input`(`packages/core/src/runtime-gateway.ts`)。
- 后端两条映射路径透传:`pi-sdk-runtime-adapter.capabilityFromModel`(活会话)与 `available-model-controls.capabilityFromRegistryModel`(draft)。
- 组件:`apps/desktop/src/shared/ui/model-selector/`,替换 `agent-workspace.tsx` 内联的 `ModelThinkingControl`,注册 `/design` 页。
