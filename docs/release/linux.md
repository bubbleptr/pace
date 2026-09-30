# Linux 打包与发布

Pace 的 Linux 发行版是 **x64 AppImage** 与 **deb**，与 macOS ARM64 打在同一个 `v*` tag 上。应用标识仍是 `com.bubbleptr.pace`。没有 rpm、snap、flatpak、arm64 或 GPG 签名。

## 产物

| 文件 | 用途 |
| --- | --- |
| `Pace-<version>-x64.AppImage` | 首次安装，也是应用内更新的安装包 |
| `Pace-<version>-x64.AppImage.blockmap` | AppImage 差分更新 |
| `latest-linux.yml` | electron-updater 的 Linux feed。必须原样上传 |
| `Pace-<version>-x64.deb` | Debian / Ubuntu 安装包。**不会**自动更新，升级需要重新安装 |
| `SHA256SUMS-linux.txt` | 覆盖上面四个文件 |

deb 只负责安装。应用内更新只走 AppImage（ADR-0033）。

## GitHub Actions

[Release](../../.github/workflows/release-macos.yml) 在推送 `v*` tag 时同时构建 macOS ARM64 与 Linux x64，也可以手动指定一个已存在的 tag 重跑。两条构建并行；发布 job 等两边都成功，把资产放进同一个草稿，确认 macOS 与 Linux 资产都在之后才 `draft=false`。已公开的版本不能再追加文件。

Linux job 跑在 `ubuntu-latest`（x64）上：

1. `scripts/release-linux.mjs` 校验 tag、两处 `package.json` 版本，并确认宿主是 `linux/x64`。不读取 Apple 凭据。
2. `stage:node-pty` 在这台 Linux 机器上复制宿主原生模块，不能改到 macOS runner 上交叉编译。
3. `electron-builder --linux --x64 --publish never` 生成 AppImage、deb 和 `latest-linux.yml`。全局 `forceCodeSigning: true` 只约束 macOS；`linux.forceCodeSigning` 显式为 `false`，避免 Linux 构建继承这个开关。
4. 打包后的 E2E 在 Xvfb 里跑：`env -u WAYLAND_DISPLAY`，`PACE_E2E_ELECTRON_ARGS=--ozone-platform=x11`。先对 `linux-unpacked` 跑完整 packaged E2E，再对 AppImage 跑一次预检冒烟。`--ozone-platform=x11` 只给 Xvfb / 平铺 Wayland 下的测试用，**不会**打进正式包。
5. 窗口能打开，说明打包后的 `isPackaged` 路径仍先 `setVersion`，electron-updater 不会因为 Linux 上版本变成 `0.0` 而在创建窗口前退出。

Apple 的证书与公证 secret 只进入 macOS job。发布 job 只有 `contents: write`，用 `GITHUB_TOKEN` 上传。

构建机没有 FUSE 时，打包和 AppImage 冒烟会设置 `APPIMAGE_EXTRACT_AND_RUN=1`，让 appimagetool 和 AppImage 解压运行。

## 安装

**AppImage（推荐，可应用内更新）。** 从 [GitHub Releases](https://github.com/BubblePtr/pace/releases) 下载 `Pace-<version>-x64.AppImage`，加上可执行权限后运行：

```bash
chmod +x Pace-*-x64.AppImage
./Pace-*-x64.AppImage
```

若提示缺少 FUSE（常见于没有 `libfuse2` 的发行版，或用户命名空间受限的环境），解压运行即可：

```bash
./Pace-*-x64.AppImage --appimage-extract-and-run
```

或 `APPIMAGE_EXTRACT_AND_RUN=1 ./Pace-*-x64.AppImage`。之后的升级在 **Settings → About & Updates** 里完成，和 macOS 一样只推给同为预发布或同为正式版的安装。

**deb（仅安装）。** 

```bash
sudo apt install ./Pace-*-x64.deb
```

新版本需要再次安装对应的 deb。设置页不会为 deb 安装提供原地更新。

## 数据目录

| 数据 | 安装版 | `bun run dev` |
| --- | --- | --- |
| 会话日志、投影、预检 | `~/.pace` | `~/.pace-dev` |
| Electron 配置（项目注册表、草稿、Chromium profile） | `~/.config/Pace` | `~/.config/Pace-dev` |

Linux 上 Electron 的 `appData` 是 `~/.config`。`app.setName("Pace")` 之后，userData 就是 `~/.config/Pace`。Pi 的会话仍在 `~/.pi/agent`，卸载 Pace 不会删它。显式 `PACE_DATA_DIR` 与 `--user-data-dir` 优先。

## 本地检查

```bash
bun run package:linux
bun run test:e2e:packaged:linux
```

`package:linux` 只出 `dist/linux-unpacked`。`dist:linux` 额外出 AppImage 与 deb。两者都带 `--publish never`。
