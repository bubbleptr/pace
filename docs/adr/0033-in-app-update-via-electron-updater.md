# ADR-0033：应用内升级采用 electron-updater，以 GitHub Releases 为分发源

- 状态：Accepted
- 日期：2026-09-06

## 背景

PiGUI 0.0.1 已通过 `release-macos.yml` 发布签名并公证的 Apple Silicon DMG（`docs/release/macos.md`）。但 App 本身没有任何升级能力：用户装上之后不会知道新版本存在，也没有原地安装的途径。ADR-0031 规定 Pi 运行时随 App 一起发布和升级，不单独自动更新，这意味着"升级 App"是用户拿到新 Pi 组合的唯一通道，升级能力因此是发布链路的一部分，而不是可选的产品功能。

另一个时间压力：已安装的旧版本永远收不到推送。装了没有 updater 的版本的用户只能靠手动下载，所以 updater 应在尽早的版本里落地。

现有链路的关键事实：

- 打包工具是 electron-builder 26，Electron 42，ASAR 开启，`@lydell/node-pty` 解包在 ASAR 之外。
- macOS 签名、hardened runtime、公证与 staple 已在 CI 中强制执行；未签名产物不会发布。
- 发布由 `v*` tag 触发。CI 用 `--publish never` 只构建，再由 `scripts/publish-release.sh` 通过 `gh release` 上传 DMG 与 `SHA256SUMS.txt`，草稿上传完毕后自动公开；已公开版本不可覆盖。
- 主进程刻意保持薄（ADR-0013）：窗口、IPC 路由、utilityProcess 后端的生命周期。`pigui:invoke` 已有"主进程本地命令先截获，其余转发后端"的分发模式；`before-quit` 会取消后端自动重启定时器并杀掉后端。
- 仓库为 public。

## 候选方案

| 方案 | 评估 |
| --- | --- |
| **electron-updater**（electron-builder 生态） | 与现有打包工具同源，`latest-mac.yml`、blockmap 由 electron-builder 直接生成；GitHub Releases 作为 provider 不需要额外服务；支持 macOS、Windows 与 Linux AppImage；下载、校验、安装时机可控。macOS 需要额外的 zip 产物。 |
| update-electron-app（Electron 官方，update.electronjs.org） | 代码最少，public 仓库可直接用。但只支持 macOS 与 Windows，不支持 Linux；升级策略几乎不可配置；同样需要 zip。 |
| 自研（查询 Release API 后引导下载 DMG） | 没有原地安装，等于只做了"新版本提示"。 |

## 决策

### 1. 采用 electron-updater，provider 为 GitHub Releases

`electron-updater` 作为 `apps/desktop` 的运行时依赖。`electron-builder.yml` 增加 `publish: { provider: github, owner: BubblePtr, repo: PiGUI }`，它的作用只是让 electron-builder 生成 `latest-mac.yml` 并让 updater 知道去哪里查；CI 继续使用 `--publish never`，真正的上传仍由 `publish-release.sh` 完成，以保留"草稿上传完再公开、已公开不可覆盖"的既有保证。

### 2. macOS 产物增加 zip，DMG 保留给首次安装

electron-updater 在 macOS 上只消费 zip 与 `latest-mac.yml`，DMG 仅用于首次安装。`mac.target` 增加 `zip`（arm64），产物名沿用 `${productName}-${version}-${arch}.${ext}`。发布上传的资产集合变为：DMG、zip、`zip.blockmap`、`latest-mac.yml`、`SHA256SUMS.txt`（校验和覆盖 DMG 与 zip）。`latest-mac.yml` 必须原样上传，其中的 sha512 是 updater 的完整性校验依据。

### 3. 升级策略：自动检查、自动下载、用户确认后安装

- 仅在打包后的 App 中启用（`app.isPackaged`）；开发态与未签名产物禁用 updater。
- 启动后延迟检查一次，之后按固定间隔周期性检查；设置页提供手动"检查更新"。
- 发现新版本自动在后台下载；下载完成后只通知，不自动安装。安装由用户在设置页点击"重启并安装"触发。
- 不做强制升级；不做静默安装。
- 预发布版本：仅当当前运行版本本身是预发布版时才接受预发布更新（electron-updater 的默认行为），正式版用户只收到正式版。

### 4. 主进程中的位置与 IPC 形态

updater 逻辑放在独立模块 `apps/desktop/electron/updater.ts`，主进程 `main.ts` 只负责装配，符合 ADR-0013 的薄主进程约束。

- 渲染进程通过 `pigui:invoke` 的主进程本地命令 `update:status` / `update:check` / `update:install` 与之交互，走现有的截获路径，不经过后端。
- 状态变化通过新的 `pigui:update-event` 通道推送，preload 增加 `onUpdateEvent`，与 `onBrowserEvent` 同构。
- 状态机对渲染层暴露为一个可序列化对象：`idle | checking | available | downloading(progress) | ready(version) | error(message) | disabled(reason)`，并附带当前版本号。

### 5. 安装与后端退出顺序

`quitAndInstall` 会触发 `before-quit`。现有的 `before-quit` 处理已经取消后端重启定时器并杀掉后端进程，这正是安装前需要的顺序；updater 不得绕过 `app.quit` 路径，也不得在 `before-quit` 之外自行管理后端。

### 6. 与 ADR-0031 的关系

updater 更新的是整个 App bundle，随之携带经过验证的 Pi 运行时组合。这与 ADR-0031"Pi 随 App 一起升级、不独立自动更新"的规定一致；本 ADR 不为 Pi 运行时引入任何独立更新通道。

## 后果

- 每个发布版本多出 zip、blockmap 与 `latest-mac.yml` 三个资产；发布脚本与其行为测试需要同步扩展。
- 首个带 updater 的版本是分水岭：之前的版本用户仍需手动下载一次。
- Linux：x64 AppImage 与 macOS 走同一个 `v*` tag 和同一份草稿，公开前必须同时有 `latest-linux.yml`、AppImage 及其 blockmap（见 `docs/release/linux.md`）。deb 只用于安装，不自动更新。不签名，不覆盖 arm64 / rpm / snap / flatpak。
- Windows 尚无目标，不涉及。
- 版本号仍由维护者手动提升（`docs/release/macos.md`），updater 只比较 SemVer，不改变发版流程。

## 参考

- `docs/adr/0013-electron-shell-and-relocatable-backend.md`
- `docs/adr/0031-bundled-pi-runtime-and-extension-compatibility.md`
- `docs/release/macos.md`
- electron-builder Auto Update：https://www.electron.build/auto-update
