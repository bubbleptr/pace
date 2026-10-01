# macOS 打包与发布

Pace 使用 `electron-builder` 生成 Apple Silicon `.app` 与 DMG。发布产物的固定标识为 `com.bubbleptr.pace`，最低支持 macOS 12。

## GitHub Actions

仓库提供两条流程。手动验证只构建 macOS ARM64；发版流程同时构建 macOS ARM64 与 Linux x64：

- [Validate macOS ARM64 (manual)](../../.github/workflows/ci.yml)：仅在 Actions 中手动运行，用于按需验证未签名应用，不会由普通 PR、分支推送或合并自动触发。冻结安装依赖，运行发布预检与发布行为测试和完整单元测试，再执行类型检查、构建、内置运行时冒烟、未签名 `.app` 打包与完整 packaged-app E2E。不需要 Apple 凭据。
- [Release](../../.github/workflows/release-macos.yml)：推送 `v*` tag 时执行，也可以手动指定一个**已存在的 tag**重跑。macOS job 校验版本与凭据后，执行测试、构建、原生依赖复制、签名、公证，挂载 DMG 后检查架构、签名、staple 和 Gatekeeper，并从镜像里的 App 运行完整 E2E。构建命令带 `--publish never`：`electron-builder.yml` 里的 GitHub `publish` 只用来生成 `latest-mac.yml` / `latest-linux.yml`，真正的上传仍由 `scripts/publish-release.sh` 完成。Linux x64 job 并行产出 AppImage、deb 与 `latest-linux.yml`（见 [Linux 打包与发布](linux.md)）。发布 job 等两边都成功，把资产放进同一个草稿；macOS 与 Linux 的必需资产都在之后才公开发布。缺任一资产都不会公开。已公开发布的版本不能再追加文件。

macOS 构建机器固定为 `macos-15`（GitHub 标准 ARM64 runner），并在运行时确认 `darwin/arm64`。`stage:node-pty` 根据宿主平台选择原生模块，因此不能换成 Intel runner 后仅传 `--arm64`。Linux 构建固定为 `ubuntu-latest` x64，同样在该宿主上执行 `stage:node-pty`。Node 使用 24，Bun 固定为 1.3.12；升级 Bun 时同步修改 workflow。Release 上传 job 使用 Ubuntu，只传输两边已经验证的文件，本身不再打包。Apple 凭据只进入 macOS 预检与签名步骤。

构建 job 只有 `contents: read`；仅上传 Release 的 job 获得 `contents: write`，使用 GitHub 自动提供的 `GITHUB_TOKEN`，不需要额外 PAT。Apple 凭据仅传入预检与签名步骤，`.p8` 写入 runner 临时目录并在使用后删除。失败的 E2E 诊断保留 7 天。

### 首次运行需要准备什么

在仓库 [Settings → Secrets and variables → Actions](https://github.com/BubblePtr/pace/settings/secrets/actions) 配置以下 **Repository secrets**：

| Secret | 内容 |
| --- | --- |
| `CSC_LINK` | 从钥匙串导出的 **Developer ID Application 证书及私钥**的 `.p12` 文件，经 Base64 编码后的完整内容。不是 Apple Development 证书。 |
| `CSC_KEY_PASSWORD` | 导出 `.p12` 时设置的非空密码。 |
| `APPLE_API_KEY_P8` | App Store Connect Team API key 的 `.p8` 完整文本，保留 BEGIN/END 行和换行。workflow 将其写入临时文件，再通过 `APPLE_API_KEY` 提供文件路径。 |
| `APPLE_API_KEY_ID` | 上述 API key 的 Key ID。 |
| `APPLE_API_ISSUER` | 同一 Team API key 的 Issuer ID。 |

这需要可用的 Apple Developer Program 资格、Developer ID Application 签名证书及对应私钥，以及有公证权限的 App Store Connect Team API key。本机已有证书或 `pigui-notary` 钥匙串 profile（改名前创建，未改名）**不会**自动传到 GitHub runner。

还需要确认仓库允许 GitHub Actions 运行上述官方 actions，并允许 Release job 使用 `contents: write`。workflow 不绑定 GitHub Environment，因此不需要额外创建 environment。预检只判断凭据是否齐全；证书有效性、密码与公证权限由真实签名、公证阶段确认。

缺少任一 Secret 时，Release 流程会在安装依赖前失败并列出缺少的名字。不会回退到未签名或未公证发布。`notarize: true` 本身不能保证公证发生，所以镜像中 App 的 `stapler validate` 与 Gatekeeper 检查都是必过步骤。

### 导出证书、生成密钥并填写 Secrets

1. 在 macOS「钥匙串访问」的「登录 → 我的证书」找到 `Developer ID Application`，展开后确认有对应私钥。选中该身份，使用「文件 → 导出项目」保存为 `.p12`，并设置导出密码。假设保存为 `~/Downloads/Pace-DeveloperID.p12`，执行下面的命令将 Base64 内容复制到剪贴板，粘贴为 `CSC_LINK`；导出密码填入 `CSC_KEY_PASSWORD`：

   ```bash
   base64 -i "$HOME/Downloads/Pace-DeveloperID.p12" | tr -d '\n' | pbcopy
   ```

2. 登录 [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api)，选择签名证书所属团队。进入「Users and Access → Integrations → App Store Connect API → Team Keys」，现有密钥仍名为 `PiGUI CI`（改名前创建，未改名）。新生成时显示名可沿用或改为 `Pace CI`；Secrets 只认 Key ID 与 Issuer，不认显示名。按当前 `@electron/notarize` 官方示例，Access 选 `App Manager`。若尚未开通 API，需要 Account Holder 先 Request Access；生成 Team Key 需要 Account Holder 或 Admin。
3. 下载 `AuthKey_<KEY_ID>.p8`（只能下载一次），记录 Key ID 和 Issuer ID。将 `.p8` 全文填入 `APPLE_API_KEY_P8`，Key ID 填入 `APPLE_API_KEY_ID`，Issuer ID 填入 `APPLE_API_ISSUER`。Issuer ID 是 UUID，不是证书括号内的 Team ID；`.p8` 不需要 Base64 编码。
4. 在仓库 Actions Secrets 页点击 **New repository secret**，按上面的表创建五项。完成后可运行 `gh secret list --repo BubblePtr/pace` 核对名称。GitHub CI 不需要本机的 `pigui-notary` profile；该 profile 只用于下面的本地公证流程。

操作参考：[Apple 钥匙串导出说明](https://support.apple.com/guide/keychain-access/import-and-export-keychain-items-kyca35961/mac)、[Apple Team API Key 创建说明](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/)、[@electron/notarize 凭据要求](https://github.com/electron/notarize#usage-with-app-store-connect-api-key)。

### 发一个版本

首版从 `0.0.1` 开始，标签为 `v0.0.1`。版本遵循 [SemVer 2.0.0](https://semver.org/lang/zh-CN/)：兼容修复提升 PATCH，兼容的新功能提升 MINOR，不兼容的公共接口变更提升 MAJOR。`0.y.z` 属于初始开发阶段，尚不保证接口稳定。版本号由维护者根据变更内容决定，流水线不会在每次合入时自动升版。

#### 怎么选版本号

看自上一个 tag 以来合入 `main` 的全部变更，按其中级别最高的一项决定。`v0.0.1` 至 `v0.0.16` 不论内容一律只升 PATCH，不符合下面的规则；从 `v0.1.0` 起按规则执行。

| 本次包含 | `0.y.z` 阶段 | `1.0.0` 之后 |
|---|---|---|
| 不兼容变更：journal / 投影格式需要迁移或重建、配置或数据目录变更、移除功能、平台或最低系统要求收紧 | MINOR（`0.1.3` → `0.2.0`） | MAJOR |
| 用户可感知的新功能：新分区、新面板、新平台、新安装包、内置 Pi 升级带来新能力 | MINOR（`0.1.3` → `0.2.0`） | MINOR |
| 只有修复、性能、样式与文案打磨、内置 Pi 的兼容性补丁升级 | PATCH（`0.1.3` → `0.1.4`） | PATCH |

- 提交前缀只是线索：一条用户可感知的 `feat` 就足以升 MINOR；只影响内部的 `feat(backend)` 不算。`refactor`、`test`、`docs`、`chore` 不会单独触发发版。
- 提升 MINOR 时 PATCH 归零。不要为了“看起来改动小”而降级成 PATCH。
- `0.y` 阶段 MINOR 同时承担“可能不兼容”的含义，README 已经说明 journal 与投影格式可能在 minor 版本之间变化；发布说明里要写清楚需要用户做什么。
- `1.0.0` 在 journal / 投影格式与升级路径可以承诺稳定时发布，届时单独决定。

1. 在功能分支中同步修改根 `package.json` 与 `apps/desktop/package.json` 的 `version`，同步 `bun.lock` 中桌面 workspace 的版本，并运行 `bun install --frozen-lockfile` 验证后一同提交。两处清单版本都必须与 tag 去掉 `v` 后完全一致；其他内部 workspace 包无需同步升级。
2. 通过 PR 合并版本变更及 workflow。普通 PR 不自动执行 macOS 打包或 E2E；需要提前验证时，在 Actions 手动运行 `Validate macOS ARM64 (manual)`。下一步的标签发版流程会执行完整测试。
3. 从最新 `main` 创建并推送对应 tag。例如两处版本均为 `0.0.1` 时：

   ```bash
   git switch main
   git pull --ff-only
   git tag -a v0.0.1 -m "Pace 0.0.1"
   git push origin v0.0.1
   ```

4. 在 Actions 中等待 `Release` 完成。流程先在草稿中上传 macOS 与 Linux 资产，确认两边都上传成功后自动公开发布，无需手动点击 Publish。正式版本标记为 Latest，预发布版本不替换 Latest。Linux 资产的说明见 [linux.md](linux.md)。

`electron-updater` 在 macOS 上消费 zip 与 `latest-mac.yml`（其中的 sha512 是完整性校验依据，必须原样上传，不要改写）。DMG 仍给首次安装用。`SHA256SUMS.txt` 只覆盖 DMG 与 zip，不含 blockmap / yml。

首个带 updater 的版本是分水岭：更早装上的版本没有检查更新的能力，必须手动下载一次新 DMG。从该版本起，后续升级可以在设置页的 **About & Updates** 里完成，也可通过侧栏徽标与应用菜单进入。预发布只推给当前本身就是预发布的安装；正式版用户只收到正式版。

预发布版本可使用 `0.1.0-rc.1` / `v0.1.0-rc.1`，生成的 Release 会标记为 prerelease。支持 SemVer 构建元数据，例如 `0.0.1+build.001`；标签和两处 `package.json` 必须保留完全相同的版本字符串。数字型预发布标识不允许前导零，构建元数据中的数字不受此限制。

补齐 Secrets 或遇到临时公证失败后，可以重跑失败的 workflow，或在 Actions → Release → Run workflow 输入原 tag。已有草稿会替换同名附件、保留手工编辑的发布说明，上传成功后自动公开；已公开发布的版本会拒绝覆盖，需要创建新版本。若只是最终上传失败，可仅重跑失败的 job；macOS 与 Linux 构建附件各保留 7 天，过期后需重新构建。公开前草稿里必须同时有两边的资产。

### 本地检查流水线的前置逻辑

```bash
bun run test:release
bun run test
bun run package:mac:unsigned
bun run test:e2e:packaged:mac --workers=1
```

`scripts/release-macos.mjs` 会校验 tag、两处版本号、宿主架构与五项 Secret。测试覆盖错误版本、非法 tag、预发布、构建元数据、架构不匹配和缺失凭据。`scripts/publish-release.sh` 的行为测试通过模拟 `gh` 验证公开发布顺序、失败处理与已发布版本不可覆盖；这些测试不会访问 Apple、发布真实 Release 或输出 Secret 的值。

参考：[GitHub runner 规格](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[electron-builder macOS 签名与公证](https://www.electron.build/v26/docs/mac/)。

## 重建应用图标

可编辑母版是 `build/Pace.icon`，使用 Icon Composer 打开。修改后在安装了 Xcode 26 与 Icon Composer 的 Mac 上重建资源：

```bash
bun run build:icon:mac
```

脚本用 actool 编译 `build/Assets.car`，用 ictool 渲染同一工程的默认外观；保留透明安全边距后，再由 `iconutil` 生成 16px 到 1024px 的完整 `build/icon.icns` 和开发版 `build/icon-512.png`。Icon Composer 默认查找 `/Applications/Icon Composer.app`，其次查找所选 Xcode 内置版本，也可通过 `ICON_COMPOSER_APP` 指定。

macOS 包通过 `CFBundleIconName=Pace` 与 Resources 中的 `Assets.car` 启用系统图标，`.icns` 为旧系统提供兼容外观。三个生成文件随源工程一起提交，日常打包直接使用，不在发布流程中临时重绘。详见 [Pace 品牌资源](../design/brand.md)。

## 本地验证

没有发布证书时，可以生成未签名 `.app` 并直接跑完整 packaged-app E2E：

```bash
bun run package:mac:unsigned
bun run test:e2e:packaged:mac
```

这个产物仅用于本机验证，不能对外分发。E2E 会从 `dist/mac-arm64/Pace.app/Contents/MacOS/Pace` 启动真实 bundle，覆盖主进程、preload、renderer、ASAR 内 backend utility process、持久化、Git diff 和 Pi SDK 模型控制。

## 签名 `.app`

钥匙串中需要有可用的 `Developer ID Application` 证书及私钥，并允许 `/usr/bin/codesign` 访问私钥：

```bash
bun run package:mac
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Pace.app
```

如证书存在但构建报 `errSecInternalComponent`，先在「钥匙串访问」中检查对应私钥的访问控制。不要把钥匙串密码、证书私钥或公证凭据写入仓库。

## DMG 与公证

`bun run dist:mac` 会强制签名，并在提供 Apple 公证凭据时自动调用 `notarytool`。当前流水线使用 App Store Connect Team API key（按 `@electron/notarize` 官方示例选择 App Manager access），在构建进程中提供：

- `APPLE_API_KEY`：本机 `.p8` 文件路径
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Xcode 26+ 的 `notarytool` 支持 Individual API key，但必须省略 Issuer ID。当前流水线要求 Team API key 的五项 Secrets，不采用 Individual 认证方式。本地开发可先把 Team API key 写入钥匙串。profile 名仍是 `pigui-notary`（改名前创建）：

```bash
xcrun notarytool store-credentials "pigui-notary" \
  --key "/absolute/path/AuthKey_KEYID.p8" \
  --key-id "KEY_ID" \
  --issuer "ISSUER_ID"
xcrun notarytool history --keychain-profile "pigui-notary"
```

使用默认钥匙串时，构建只需提供 profile 名：

```bash
APPLE_KEYCHAIN_PROFILE="pigui-notary" bun run dist:mac
```

只有 profile 存在自定义钥匙串时才额外设置 `APPLE_KEYCHAIN`。凭据只应存在于本机钥匙串或 CI secret store 中。

### S3 上传超时

如果默认流程在上传阶段报 `abortedUpload` 或 `deadlineExceeded`，可以保留已签名的 `.app`，改用 `notarytool` 的非加速上传。先不要把公证 profile 注入 electron-builder，避免它重复提交：

```bash
env -u APPLE_KEYCHAIN_PROFILE -u APPLE_KEYCHAIN bun run package:mac

NOTARY_ARCHIVE="dist/Pace-notary-$(date +%Y%m%d%H%M%S).zip"
ditto -c -k --keepParent dist/mac-arm64/Pace.app "$NOTARY_ARCHIVE"
xcrun notarytool submit "$NOTARY_ARCHIVE" \
  --keychain-profile "pigui-notary" \
  --wait \
  --no-s3-acceleration
xcrun stapler staple dist/mac-arm64/Pace.app

./node_modules/.bin/electron-builder \
  --config electron-builder.yml \
  --prepackaged dist/mac-arm64/Pace.app \
  --mac dmg \
  --arm64 \
  --publish never \
  -c.mac.notarize=false
```

这个 fallback 只改变上传路径，不降低签名、公证或 Gatekeeper 验收要求。

发布前执行：

```bash
bun run dist:mac
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Pace.app
xcrun stapler validate dist/mac-arm64/Pace.app
spctl --assess --type execute --verbose=2 dist/mac-arm64/Pace.app
hdiutil verify dist/Pace-*-arm64.dmg
bun run test:e2e:packaged:mac
```

本地 `bun run dist:mac` 的产物仍是 `dist/Pace-<version>-arm64.dmg`。发版流水线额外构建 zip，并上传 zip、`${zip}.blockmap`、`latest-mac.yml` 与覆盖 DMG/zip 的 `SHA256SUMS.txt`。只有签名、公证、staple、Gatekeeper 和 packaged-app E2E 全部通过后，才可发布。


## 首个 Pace 版本发布前的强制升级验证

仓库改名后，必须安装已发布的 **v0.0.2 DMG**，使用该旧包内的更新器检查首个 Pace Release。确认旧 feed `BubblePtr/PiGUI` 经 GitHub 重定向可以发现 `BubblePtr/pace` 的新版本，并完成下载、安装与重启；记录旧版本号、目标版本号和检查结果。此项必须实测，单元测试或手动打开新仓库链接不能替代，未通过前不得将首个 Pace 版本作为可升级发布交付。

首个 Pace Release 准备好且旧版更新器可访问后，先完成上述验证再宣布发布。该检查需要仓库改名和实际 Release，改名 PR 阶段只记录门禁，不宣称已验证重定向。

升级后检查 `~/.pigui` → `~/.pace` 与 Electron `Application Support/@pigui/desktop` → `Application Support/Pace` 的历史会话、项目注册表和草稿完整性。开发实例单独迁移对应 `-dev` 目录，不与安装版混用；新旧目录共存、显式覆盖与迁移失败时的策略见 [自举隔离说明](../dogfooding.md)。
