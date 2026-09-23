# ADR-0044：Session Projection 在渲染层只有一个写者

- 状态：Accepted
- 日期：2026-09-24
- 来源：架构评审候选 2（2026-09-23 `/improve-codebase-architecture`）+ grilling（2026-09-24）；事实核查基于 main @ d07889f

## 背景

Live Session View 屏幕上显示的 Session Projection 没有 module 拥有它。同一个 Session 的 projection 在渲染层有五份拷贝：`LiveSessionColumn` 的 `interactionProjection` 与 `creationProjection` 两个 state、`liveProjectionRef`、app 级 `SessionProjectionsProvider` 的扁平数组、以及 `createSessionFromDraft` 闭包里的 `projection`。写者有：`syncProjection` 同步 prop、history 加载 effect、bridge 订阅 effect、`commitInteractionProjection`、创建交接回调、页面的 `handleProjectionChange`（按 id 最后写入者胜，无守卫）、Provider 的整批回灌、app-shell 的三处裸 `setSessionProjections`。屏幕取值是 `interactionProjection ?? creationProjection ?? sessionProjection`，靠 lastSeq 守卫、stale-commit 守卫、historyKey / nonce / loaded / failed 四个 ref 互相补偿。

两个已核实的缺陷：

- `createSessionFromDraft` 成功路径返回的 `unsubscribeRuntimeEvents` 在生产代码里没有任何调用方，每个创建成功的 Session 都留下一个进程生命周期的订阅，在自己的副本上累积事件并继续写 Provider。侧栏里后台 Session 的状态更新今天正是靠这个泄漏。
- Provider 的整批回灌产出冷快照（lastSeq 0），会覆盖 store 里更新的 projection；屏幕那份只靠 `syncProjection` 的 lastSeq 守卫保住，lastSeq 相等时本地队列状态被 prop 抹掉。

代价：每修一个时序 bug 加 25 到 170 行驱动 DOM 的测试。ec7bab6 的测试要从 `useLayoutEffect` 里点击 Retry，才能卡进 commit 与 passive effect 之间的窗口。行为没有 interface，测试只能耦合 React 调度。`agent-workspace.tsx` 4951 行，`LiveSessionColumn` 1253 行、20 个 prop、10 useState、10 useEffect、11 useRef。

## 决策

### 1. 一个 store 拥有渲染层的全部 Session Projection

`apps/desktop/src/entities/session/session-projections-store.ts` 替换 `use-session-projections.tsx` 的实现，Provider 与 `useSessionProjections()` 名字不变。它是渲染层里 Session Projection 唯一的写者：按 sessionId 持有一份 projection，所有变更都经 `apply(sessionId, event)` 走既有的 `applySessionProjectionEvent` reducer。reducer 不变。`LiveSessionColumn` 的两个 state、ref 和 view 本地的第二个 in-memory store 删除；页面只通过 `useLiveSession(sessionId)` 读。

不建独立于 Provider 的 live store。两个 store 只是把「两份真值谁新」从五份减到两份。

### 2. store 拥有 bridge 订阅，按 Session 生命周期而不是按视图

store 为每个绑定了 piSessionId 且未归档的 Session 保持一个 bridge 订阅，从 `runtime-bound`（创建或 resume）起到 `session-archived` / `remove` 为止，与用户是否正在看它无关。侧栏的 Session Status 和 Unread Result Indicator 从它派生。这把今天靠泄漏订阅得到的后台更新变成明确行为。`onBackendEvent` 本来就收全部事件，按 session 过滤没有额外成本。

store 同时订阅 legacy `subscribeToEvents` 与 `subscribeToAgentEvents`（以及 `subscribeToModelControls`）。reducer 已把两条流合进 `runtimeModel`；user / steer echo 今天只走 legacy 流，退役 legacy 通路要先给它们 Agent-event 等价物，属后端改动，放在本 ADR 之后单独做。退役时只改 store 内部。

`createSessionFromDraft` 不再订阅事件，也不再持有 `projections` 参数，只对 store `apply` 创建序列（`checkout-selected` → `runtime-bound` → `model-controls-changed` → `creation-stage-changed` → 接受后的 `runtime-event-received`）。ADR-0010 的 `creation-stage-changed` 与 ADR-0039 的 `latest-message-rendered` 都是普通 `apply`。

### 3. 交互 commit 的基准永远是 store 当前值

`apply` 同步执行，基准是 store 里该 sessionId 的当前 projection，不再用 RPC 前的快照做基准。按 id 隔离后不存在跨 Session 泄漏，`follow` 与「用户已切走则忽略」两个守卫消失。Fork 在新 id 上 apply 创建序列，走同一条路。reducer 对未知 queued id 抛错的行为保留，由 handler 捕获，store 不变。

### 4. history 加载状态机在 store 里

按 sessionId 持 `history: idle | loading | loaded | failed`。`ensureHistory(sessionId)` 幂等，loading 中的并发调用共享一个请求；`retryHistory(sessionId)` 只在 failed 时发一次新读取；`runtimeGeneration` 变化让 loaded 回到 idle。history 结果在 store 当前 projection 上 rebase 后 `runtime-state-resynced`。保留 ec7bab6 的语义：失败后 projection 刷新不自动重读，只有显式 retry 才读。不交给 TanStack Query，因为 rebase 基准只有 store 知道。

### 5. 回灌与 app-shell 写入都过 store 的 interface

`rehydrate()`：store 里已有且「live 拥有」（lastSeq > 0、正在创建、或有活跃订阅）的 projection 整条保留，其余按后端记录替换；后端列表里没有但正在创建的保留。app-shell 的改名走现有 `session_info_changed` 路径，归档 dispatch reducer 里已有但无人调用的 `session-archived`，删除走 `remove(id)`。裸 setter 不再导出。

### 6. interface

```ts
createSessionProjectionsStore({ bridge, listSessions, loadSession })
  .get(sessionId)  .list()
  .apply(sessionId, event)                 // 同步；未知 id 由创建类 event 建立
  .ensureHistory(sessionId)  .retryHistory(sessionId)  .historyState(sessionId)
  .remove(sessionId)  .rehydrate()  .subscribe(listener)
useSessionProjections()                    // 列表，现有名字
useLiveSession(sessionId)                  // { projection, history, apply, retryHistory }
```

## 实施顺序

两个 stacked PR：

1. store + `useLiveSession`；session-creation 交出订阅；Provider 合并、回灌规则、app-shell 三处写入改走 store。页面行为不变，`LiveSessionColumn` 暂时把 store 当作 `sessionProjection` prop 的来源。
2. `LiveSessionColumn` 改读 `useLiveSession`，删两个 state、`liveProjectionRef`、`syncProjection`、`commitInteractionProjection`、`latestProjectionFor`、history 的四个 ref 和 view 本地 store；替换测试。

## 测试边界

interface 是 test surface。新测试在 store 上用 fake bridge 与 deferred promise，不用 sleep：晚到的旧 commit 不回退；failed 后 retry 恰好读一次；后台 Session 事件不改变选中；creation 交接无重复事件且无泄漏订阅；回灌不覆盖 live 拥有的 projection；未知 queued id 抛错不污染 store。删除 bc826ad、b82921e、28384a9、7add7f9、6c42483、ec7bab6 六组 DOM 竞态测试及同类四条（reorder 进行中被消费的 queued id、第二次拖拽、Stop 往返期间的 run end、慢 resync 晚于 prompt echo）；`session-creation.test.ts` 随接口改。断言用户所见的组件测试保留。

## 后果

- Live Chat 时序 bug 集中在一个 module；fake bridge 直测。
- 订阅泄漏消失，后台 Session 状态更新成为明确行为。
- `LiveSessionColumn` 少一半 hook，为切分 agent-workspace（评审候选 5、ADR-0016 授权）让路。
- 未做：退役 legacy `runtimeEvents` 通路（需要后端为 user / steer echo 提供 Agent-event）。
