# 模型可用性链路 — PRD

2026-09-22 立项。起因:用户在 Kimi 官网完成 OAuth 授权但未购买 Kimi For Coding 套餐,Settings → Models 把四个 Kimi 模型全部列为可用,composer 里却选不到;另外 Grok 4.7 上线后 Pace 的模型目录不更新。

## 问题

三个独立缺口叠在一起,让"添加成功"和"能不能用"脱节:

1. **可用性 = 凭证存在**。Pi SDK 的 `checkProviderAuth`(`pi-ai/dist/models.js:223-226`)对 OAuth 凭证直接返回可用,不发请求;只有 GitHub Copilot 实现了按凭证过滤模型。套餐不覆盖的模型要到发 prompt 时才被拒,而且 403 落在通用 "Run failed"(`apps/desktop/src/shared/ui/chat/chat-run-failure.tsx`)。
2. **两个 ModelRuntime 互不通知**。Settings 用 `provider-auth.ts` / `available-model-controls.ts` 各自新建的 runtime;live session 的 runtime 在会话启动时创建(`pi-sdk-runtime-adapter.ts:708-711`),之后从不 `refresh()`。新登录的 provider 在旧会话的 composer 里看不到,直到开新会话。
3. **目录静态且禁网**。模型 ID 来自 `@earendil-works/pi-ai@0.86.0` 内置 JSON;Pace 三处 `ModelRuntime.create` 全部 `allowModelNetwork: false`;没有刷新按钮或定时器。SDK 本身支持 `refresh({allowNetwork: true, force: true})`,带 etag 与 `models-store.json` 持久化。

## 方案

三个切片,共享一条"凭证或目录变了,通知 live session 刷新"的通道。

### S1 Provider 连通性检测(Settings → Providers)

- 新增 backend RPC `test_provider_connection { providerId, modelId? }`:用 provider-auth 的 runtime 取该 provider 第一个可用模型(或指定模型),`completeSimple` 发一条 `maxTokens: 1` 的最小请求,返回 `{ ok: true, modelId, latencyMs } | { ok: false, kind, message, modelId }`。
- `kind` 分类器放 `packages/core`:`auth`(401)/ `entitlement`(403 或 provider 文案含 plan/subscription)/ `network` / `unknown`。`chat-run-failure.tsx` 复用同一分类器,让 403 显示"该模型不在你的订阅套餐内"而非通用失败。
- UI:两种 provider 卡片都加 "Test connection" 按钮,结果以三态 chip 显示:未测试 / 已验证 · 用的模型 · 耗时 / 失败 · 原因。结果保存在 query 状态,不落盘。
- 明确不做:逐模型探测(先按 provider 一次;若 Kimi 实测同一 provider 下不同模型套餐不同,再开后续 issue)。

### S2 凭证变化后刷新 live session 的模型列表

- `set_provider_api_key` / `remove_provider_auth` / `login_provider_oauth` / `logout_provider_auth` 成功后,backend 向所有 live session 进程发 `refresh_model_catalog` 命令;session 进程调 `session.modelRuntime.refresh({allowNetwork: false})`,重新计算 `modelControls` 并写入 projection,composer 随 projection 更新。
- 这条通道同时是 S3 的下游:目录刷新后也走它。

### S3 模型目录联网刷新(Settings → Models)

- 新增 RPC `refresh_model_catalog { force?: boolean }`:对 available-model-controls 的 runtime 调 `refresh({allowNetwork: true, force})`,返回 `{ refreshedAt, errors: Record<providerId, string> }`,然后触发 S2 的通道。
- 打开 Models 页时自动刷新一次(非 force,尊重 SDK 的 etag/freshness);页面顶部 "Refresh models" 按钮走 force,并显示上次刷新时间与失败的 provider。
- 尊重 `PI_OFFLINE`:设置了就禁用按钮并提示。
- 不做定时轮询。Grok 4.7 能否出现取决于 Pi 上游远程目录是否收录,Pace 不兜底。兜底入口是 `~/.pi/agent/models.json`,在 Models 页底部给一句提示和路径。

## 切片

- S1 → #357
- S2 → #358
- S3 → #359(Blocked by #358)

## 待定

- 逐模型探测是否必要,等 S1 上线后用 Kimi 实测。
- 探测结果是否要落盘供 About 页 "Copy diagnostics"(#350)使用。
