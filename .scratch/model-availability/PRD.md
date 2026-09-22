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

### S4 按账号过滤模型列表(订阅与 API 分通道)

2026-09-23 追加。起因:ChatGPT 订阅已停用 `gpt-5.3-codex-spark`,Pace 仍列出它;订阅新上的 `gpt-6-sol` / `gpt-6-luna` 却看不到。S3 救不了:pi.dev 目录(`openai-codex` 与 `openai` 两份)线上仍含 Spark,且 `remote-catalog-provider.js:7-17` 的合并只增不删,内置 JSON 里的模型只能靠升级 SDK 移除。

**已验证(2026-09-23,真实账号):**

- `GET https://chatgpt.com/backend-api/codex/models?client_version=<ver>`,头 `Authorization: Bearer <access>` + `chatgpt-account-id: <accountId>`(均在 Pi 的 `auth.json` → `openai-codex`)。返回 200 + etag,`models[]` 每项含 `slug`、`display_name`、`context_window`、`visibility`(`list` / `hide`)等。
- 返回:gpt-6-astra、gpt-6-sol、gpt-6-luna、gpt-5.6-sol/terra/luna、gpt-5.5(`list`),gpt-reserve、codex-auto-review(`hide`)。与 Codex CLI 本地 `~/.codex/models_cache.json` 一致。
- `client_version=0.1.0` 返回空列表:版本号过低会拿到空集。决定:Pace 写死一个较新的版本号,随 Pace 发版更新,不依赖用户本机是否装了 Codex CLI。

**规则:**

```
通道内:可用模型 = Pi 目录 ∩ 该账号在该通道实时查到的列表
通道间:选择器列表 = 各通道结果的并集
```

- 通道 = Pi provider。订阅(`openai-codex`)和 API(`openai`)是两个 provider,各自过滤,**通道之间不取交集**,否则单通道独有的模型会被误删。
- 同一模型两条通道都可用时显示两条,因计费方式不同,由用户选。身份仍为 `provider + modelId`,与 Pi TUI(`model-selector.js:255-272`,`gpt-5.6-sol [openai-codex]`)和 Pace 现状(`model-selector-logic.ts:47`)一致。
- 标签用人话:`openai-codex` → "ChatGPT 订阅",`openai` → "OpenAI API";只在出现同名模型时才显示来源标签。
- 实时列表有、Pi 目录没有的模型(如 gpt-6-sol):用接口的 `display_name` / `context_window` 补一条条目照常显示,其余字段(api、baseUrl 等)沿用同 provider 已有模型,不等 Pi 更新目录。
- `visibility: hide` 的不显示。

**实现入口:**

- 用 SDK 扩展钩子 `runtime.registerProvider(id, { refreshModels })`。`provider-composer.js:340-360`:`refreshModels(context)` 拿到 `context.credential`,返回的模型列表**整体替换**该 provider 的列表,且每次 `refresh()` 都会调用。过滤因此在 runtime 内部生效,Settings、composer、live session 看到同一份结果,不用在 `listAvailableModelControls` 另做一层过滤。
- Pace 的三处 `ModelRuntime.create`(provider-auth、available-model-controls、session 进程)都要注册同一个钩子,放在一个共享模块里。
- 刷新时机沿用 S2/S3 的通道:凭证变化、打开 Models 页、手动 Refresh。结果按 etag 缓存。
- 失败回退:接口失败、超时、返回空列表或 `PI_OFFLINE` 时,不替换,保留 Pi 目录,并在 Models 页显示"未能按账号校验"。不能因为接口挂了就把列表清空。

**分阶段:**

1. 订阅(`openai-codex`):用上面已验证的接口。本切片只做这一步。
2. API key 通道(`openai`、`anthropic` 等 `/v1/models`):同一机制,另开 issue。
3. 其他没有列表接口的 provider(如 kimi-coding):保持 Pi 目录,依赖 S1 的 403 分类提示。

**上游:** 给 Pi 提 issue,建议 `openai-codex` 内置 `refreshModels` 或 `fetchModels`(`createProvider` 已支持该钩子,`models.js:437,468`)。上游落地后删掉 Pace 这层。

**风险:** 该接口不是公开 API,路径、参数或 `client_version` 门槛可能变化。回退规则保证最坏情况等于现状。

## 切片

- S1 → #357(已合并,PR #361)
- S2 → #358(已合并,PR #360)
- S3 → #359(已合并,PR #362)
- S4 → 待开 issue(先做订阅通道)

## 待定


- 逐模型探测是否必要,等 S1 上线后用 Kimi 实测。
- 探测结果是否要落盘供 About 页 "Copy diagnostics"(#350)使用。
