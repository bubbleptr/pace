# ADR-0043：Model Catalog 单一拥有 Model 可用性

- 状态：Accepted
- 日期：2026-09-23
- 来源：架构评审（2026-09-23，`/improve-codebase-architecture` + grilling）；model availability PRD `.scratch/model-availability/PRD.md` S2 / S4 的遗留项

## 背景

"当前有哪些 Model 可用、各自的 capability 是什么"在代码里没有 module 拥有它。后端有四个 `ModelRuntime` 实例（`provider-auth.ts` 长期缓存一个；`listAvailableModelControls` 与 `refreshAvailableModelCatalog` 每次调用各新建一个；每个 Session 进程再持一个），两套 model → capability 映射（`workspace/available-model-controls.ts` 与 `drivers/pi-sdk-runtime-adapter.ts`）已经漂移（name 兜底一处 `trim() || id`，一处直接用 `model.name`）。凭证变化后的刷新组合按操作分档散在 `service.ts` 的 switch 里：setApiKey / loginOAuth 拉账号模型再扇出，remove / logout 只扇出，`refresh_model_catalog` 另加 offline 判断。

渲染层同样分散：`list_available_model_controls` 在 Settings、Session Draft composer、Live composer 三处各自 fetch，结果存在一个 TanStack key 和一个模块级缓存里，Settings 要手动互相失效。`model_catalog_changed` 由 Session 进程按 piSessionId 发出，借用 Session 事件通道，core 为它加了"不进 journal"的特例；`runtime-gateway-client` 收到它只改 state 不通知 listener，page 因此另外裸订阅 `onBackendEvent`。启动时的后台刷新和在 Pi TUI 里登录只有 live Session 收得到，已挂载的 Draft 和 Settings 一直显示旧列表。

代价是 locality 缺失：修一个 bug 动多层多文件。24a98eb 17 个文件、943db0a 11 个文件、3c3bc2a 8 个文件，后者的修法是往 core 加一个比较函数再给两个生产者各打一个补丁。PRD S4 自己写了"放到一个共享模块"，只完成了钩子那一半。

## 决策

### 1. 一个 deep module：Model Catalog

在 `packages/backend/src/workspace/model-catalog.ts` 建立 **Model Catalog** module，它是后端唯一拥有 Model 可用性的地方。它持有主进程内唯一的 Pace `ModelRuntime`（`createPaceModelRuntime` 对 Pi `ModelRuntime` 的包装，由组合根创建，同一实例注入 provider auth；每个 Session 进程仍按 ADR-0040 持有自己的实例），统一映射 capability，决定凭证变化后的刷新策略，并把刷新扇出到运行中的 Session。Settings、Session Draft composer、Live Session View 都只读它。

interface 只有四个入口：`list()`（懒建、缓存优先）、`refresh({ allowNetwork, force })`（联网重算 → 扇出 → 发信号）、`onCredentialChanged()`（统一策略，等价于联网 refresh）、`subscribe(listener)`。扇出超时是构造参数（默认 5 秒），超时只记日志不阻塞调用方，也不进 refresh 的 errors；errors 保持 provider 维度。启动时后台刷新是构造选项而不是 service 的旁路。

Model Catalog 放在 workspace 层而不是 Runtime Gateway：Gateway 是 Session 语义的 seam（ADR-0018），Model 可用性跨 Session、跨 Draft、跨 Settings。

### 2. 刷新策略统一，不再按凭证操作分档

任何凭证变化都走同一条规则：重算账号模型（有网联网，没网走缓存）→ 扇出到 live Session → 发全局信号。分档规则是 service.ts 里逐个 case 长出来的，没有人证明过 remove 之后不需要重算。若实测发现某种操作下联网刷新会报错，在 catalog 内部处理，不暴露给调用方。`service.ts` 的凭证 case 缩成"调 provider auth，再通知 catalog"。

### 3. capability 映射只有一份，放在 core

`capabilityFromModel`、`thinkingLevelsForModel`、`defaultSelection` 做成纯函数放 `packages/core`，与已有的 `compareModelCapabilities` 同处；主进程 catalog 和 Session 进程 adapter 都 import 它。子进程不能只上报原始列表：`selected` 只有 Session 进程知道，snapshot 必须自带 `modelControls`（ADR-0024 §1）。

### 4. 两种信号，各管一头

- 全局 `model_catalog_changed`：seq 0、不经 Gateway、不进 journal，复用 ADR-0038 `workspace.invalidated` 的"失效信号与真值读取分离"模式。它只表达"请重新拉取"，供 Draft 和 Settings 使用。
- 按 piSessionId 的 `model_catalog_changed` 保留，因为它携带该 Session 的 `selected`。它只由 `runtime-gateway-client` 处理并正确通知 listener；page 删掉裸订阅。把它从 runtime event 降级为 Gateway snapshot patch、随之删掉 core 的 journal 特例，记为后续项。

### 5. Pi settings 默认模型是独立的小 module

`readSettingsPreferredModel` 有两个调用方（draft 默认选择、连接测试的探测顺序），独立成 Pi settings 读取 module，catalog 与 provider auth 都调它，provider auth 不依赖 catalog。

### 6. 渲染层一个读取点

一个 hook 拥有唯一 TanStack key、全局信号失效和 refresh 门（从 `settings.tsx` 搬来）；visible 过滤（`entities/model/visible-models.ts`）和 last-selection overlay（`entities/session/last-model-preference.ts`）仍是各自的小 module，由 hook 组合。模块级 `model-catalog-cache.ts` 删除。

### 7. 不动的东西

`list_available_model_controls`、`refresh_model_catalog` 等命令名和返回形状不变，命令面的类型化是另一个候选的事。`PiRuntimeDriver` 与 Gateway API 不变（ADR-0018 / ADR-0041）。capability 只即时发现不持久化（ADR-0024 §2），catalog 只做内存缓存。

## 实施顺序

三个 stacked PR，每个单独可 review、可回滚：

1. 后端 Model Catalog module：行为不变，只收拢四个 runtime、两份映射、分档规则和扇出。
2. 信号：新增全局 `model_catalog_changed`；按 Session 的推送改由 `runtime-gateway-client` 完整处理。
3. 渲染层读取点：三处 fetch 和两个缓存收成一个 hook。

## 测试边界

interface 是 test surface。保留 `account-models.test.ts`（过滤逻辑本身）和 adapter 里关于 snapshot 的测试。用 fake `ModelRuntime` 和 fake live-session port 在 catalog 的 interface 上重写 `available-model-controls.test.ts` 与 `service.test.ts` 的六个模型 describe：两条路径（draft 与 live）产出同一形状且顺序一致；凭证变化后先拉账号列表再扇出；扇出超时不阻塞；凭证变化只发一次全局信号且不写 journal。PR 3 后删掉 943db0a 加进 `agent-workspace.test.tsx` 的 167 行和 `settings.test.tsx` 的 refresh 门测试。旧的 shallow module 测试不保留，留着会绑住重构。

## 后果

- 凭证 → 模型列表的 bug 只剩一处；三个调用方共用一个 interface。
- `service.ts` 少六个凭证 case；`agent-workspace.tsx` 少一处裸订阅和一段 fetch 守卫。
- Draft 和 Settings 能收到启动刷新和 Pi TUI 登录的结果。
- 每个 `list()` 不再新建 runtime。
- 未做：把按 Session 的 `model_catalog_changed` 降级为 snapshot patch；命令面类型化。
