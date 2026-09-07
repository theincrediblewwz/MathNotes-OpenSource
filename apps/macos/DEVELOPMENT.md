# 在 Mac 本地开发 MathNotes

从仓库根目录执行下面的命令。本仓库已经包含 Mac 原生界面、共享 Core/协议、PWA、打包脚本和测试，不需要私有仓库，也不需要 Windows 电脑在线。

## 工具与目录

- 已验证的环境：Apple silicon、macOS 26、Xcode 26、Node.js 22。应用声明的最低系统为 macOS 14；不代表已在每个 macOS/Xcode 组合中验收。Intel Mac 尚未验证，打包脚本当前以 arm64 命名。
- 需要完整 Xcode、Swift 6 工具链、Node.js 22、npm、Git。先读取版本；缺失时由用户决定安装，不自动切换全局工具链。
- `apps/macos`：SwiftUI/AppKit 原生应用。
- `packages/core-server`：随应用启动的本机后台进程，提供笔记核心和手机连接。
- `packages/shared`、`packages/sync-contract`：共享模型与合同。
- `apps/pwa`：随 Mac 应用打包的手机网页。
- `test_tool`：构建、原生合同、连接诊断和启动测试。

```bash
git status --short --branch
git rev-parse HEAD
uname -m
sw_vers -productVersion
node --version
npm --version
xcode-select -p
swift --version
```

如需选用特定 Xcode，可以只给当前命令设置 `DEVELOPER_DIR`，不要擅自运行全局 `xcode-select --switch`。

## 安装依赖、编译和打包

```bash
npm ci
npm run test:macos:native-package
npm run test:macos:native
npm run test:macos:ui
node --test test_tool/macos_connection_diagnostics.test.mjs
npm run test:macos:sidecar
npm run test:macos:long-session
npm run package:macos:native
```

最后一个命令会构建 Sidecar、PWA、Swift release 程序，生成：

- `output/macos-native/bundle/MathNotes.app`
- `output/releases/MathNotes-macOS-native-arm64-<版本>-<构建>-unsigned.zip`
- 同名 `.sha256`

当前打包使用本机 ad-hoc 签名，不需要 Apple Developer ID 或公证凭据。版本从根 `package.json` 写入 App；构建来自本次 Git 提交，存在未提交文件时带 `-modified`。无 Git 元数据的源码目录会使用 `local-时间`。公开仓库的提交号与此前测试包的构建号可以不同，以实际包内信息为准。

## 先用空目录观察启动

以下命令只设置本次进程环境。必须同时覆盖目录偏好的参数：原有保存的笔记目录书签优先于 `MATHNOTES_NOTES_ROOT_DIR`，仅设置环境变量并不能保证避开生产笔记。

```bash
mkdir -p output/macos-local-debug
run_root="$(mktemp -d "$PWD/output/macos-local-debug/run.XXXXXX")"
mkdir -p "$run_root/notes"
printf '本轮测试目录：%s\n' "$run_root"

MATHNOTES_PHASE1A_ROOT="$run_root" \
MATHNOTES_NOTES_ROOT_DIR="$run_root/notes" \
MATHNOTES_COMPANION_TOKEN_FILE="$run_root/companion-token" \
./output/macos-native/bundle/MathNotes.app/Contents/MacOS/MathNotes \
  -mathnotes.directory.notesRoot.bookmark '' \
  -mathnotes.directory.notesRoot.path "$run_root/notes" \
  -mathnotes.workspace.source.v1 local \
  -mathnotes.open-phone-connection \
  >"$run_root/app.stdout.log" 2>"$run_root/app.stderr.log"
```

命令保持前台运行；正常退出应用后结束。参数覆盖是当前进程的参数域，不通过 `defaults write/delete` 改写原有书签。日志只保存在忽略的本地测试目录；不要直接上传原始日志，其中可能出现路径或凭据。测试时不要保存已有 Provider、切换生产目录或调用真实 AI。

先确认应用使用空笔记目录，再对比本地编译包与旧安装包。需要读原有状态或真实笔记时，先和用户确认具体范围，使用备份/副本；不要用删除状态、重新配对、关闭系统安全保护或重配网络来掩盖故障。

## 现有安装包的可选诊断

```bash
bash test_tool/diagnose_macos_connection.command
```

选择故障 MathNotes.app 后，工具读取版本/签名/内置组件指纹，并在临时空目录分别测试 Core 和手机宿主。它不读取笔记或钥匙串，不修改网络或 Gatekeeper，只报告受限错误分类、退出码和信号。终端中测试成功不等于 Finder 启动或原有用户状态也成功。

`npm run test:macos:app-launch` 是为一次性 CI Mac 设计的现有 UI 验收脚本。它对用户偏好与数据目录的隔离并不完整，**不要直接在日常使用的 Mac 上运行它**；先使用上面的隔离启动步骤，或把脚本改成完整隔离后再验收。

## 两台电脑协作

在 Mac 上创建自己的 `codex/` 修复分支，提交前检查 diff 和工作树，提交最小修复、测试及可公开的结论。通过公开仓库分支/PR 交回，Windows 端再拉取和验证共享模块；不要两台电脑同时改同一条分支，也不要把 `.app`、依赖缓存、日志、数据目录或密钥当源码提交。
