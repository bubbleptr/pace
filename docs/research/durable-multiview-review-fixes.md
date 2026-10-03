# Durable 多端 spike：高优先检视修复

本轮针对已合并 spike 的审批归属、订阅竞态、消息边界、backend 重连及 steer 按钮问题补充回归保护。其余历史检视不在本轮范围内；本轮也不代表生产迁移或安全验收完成。

## 宿主与审批边界

- 审批决定必须属于请求所在的会话。错误会话的调用在写入审批文档前失败，不释放原工具；同会话重复决定仍返回先前决定。
- 每次订阅拥有独立身份。过期订阅的快照、增量和结束消息都不能覆盖新订阅；迟到的 watch 会被关闭。
- 文档尚不存在时，先监听提交，再检查文档是否存在。创建发生在这两步之间也会触发订阅，不依赖下一次更新来补救。
- WebSocket 消息在入口解析和校验。无效 JSON、消息类型或参数只关闭发送方连接，不让异常逃逸到宿主进程；健康客户端仍可操作。
- 有 Origin 的浏览器连接必须精确匹配允许列表，并通过 token 鉴权。无 Origin 的原生 TUI、观察器和 Pace backend 中继仍必须提供 token。
- 常规启动日志只给出 token 文件路径，不输出 token 或带凭证的浏览器链接。token 仍由本地权限为 `0600` 的文件持久保存。

## 本地运行

在 `spikes/durable-multiview` 下运行：

```sh
bun run demo:faux
bun run web
bun run web:link
```

前两条需要各自运行在一个终端中。第三条显式生成浏览器连接链接；该链接含宿主控制凭证，不应写入共享日志。自定义宿主目录或地址可传 `--data-dir`、`--url`，与 TUI 的参数一致。

宿主 CLI 默认只允许 `http://127.0.0.1:5199`。其他浏览器来源用 `--browser-origin http://127.0.0.1:端口` 显式指定；此参数可重复，指定后替换默认列表。`openHost()` 默认不允许任何浏览器来源，调用方需传 `browserOrigins`。测试和验收脚本为各自的 Vite 端口配置精确来源。

## 回归边界

- `test/approval-boundaries.test.ts`：真实 Harness 上拒绝跨会话审批，检查两边文档和待审批工具，保留合法决定及重复调用。
- `test/gateway-boundaries.test.ts`：真实 WebSocket 与宿主进程，覆盖错误来源、畸形消息、订阅先后顺序、取消和文档创建间隙。并发通过显式屏障协调。
- `test/host-startup.test.ts`：从进程输出确认凭证未泄露，再从本地 token 文件连接真实宿主。

原有宿主恢复、工具热替换及完整三端脚本已改为从本地 token 文件取凭证，不再从日志读取。

## 客户端恢复与发送

backend 的 `__backend__/disconnected` 生命周期事件会关闭现存的 relay transport，交给原有重连路径建立新连接。即使该事件丢失，向不存在或未打开的 socket 发送也会明确失败，renderer 将 IPC 拒绝转换为断线；提示不会再静默消失。未完成的调用会显示错误，结果未知的命令不会自动重放。

运行中的 composer 只有在输入为空时显示 Stop。有文本时显示 Send，点击后提交 steer，并保留正在等待审批的工具；发送后输入清空，Stop 恢复可用。

- `backend-relay.test.ts`：使用实际 backend 事件结构验证断线通知及 IPC 发送失败。
- `test/relay.test.ts`：真实宿主与 backend bridge，在 backend 替换和生命周期事件丢失两种情况下重新连接，后续提示均得到模型回答。
- `test/web-ui.test.ts`：真实浏览器点击 Send 后，steer 入队且工具仍待审批；输入清空后点击 Stop 终止任务。

## 本轮验证

2026-10-02：宿主层独立通过 spike typecheck 和 60 项测试；完整修复栈通过根 typecheck、lint、build，根测试 168 个文件 / 1977 项，spike typecheck 与测试 15 个文件 / 64 项。每个具体缺陷均先运行失败用例，再实现修复。

完整 `bun run verify:demo` 通过 12 幕，包含 SIGKILL 恢复、三端审批、子会话 steer、补偿、提醒、fork、三端压缩、热替换及窄屏布局。Pace 的 steer 步骤改为实际点击 Send；已检查 [运行中发送按钮截图](../../output/durable-multiview-boundaries-20261002/05-steer-ready-pace.png)。完整本机证据目录：[output/durable-multiview-boundaries-20261002](../../output/durable-multiview-boundaries-20261002)。
