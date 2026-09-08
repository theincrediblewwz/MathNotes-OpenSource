# 在 Mac 本地开发 MathNotes

当前发布：macOS 0.3.5，集成 PWA 0.3.4。[功能与延期验收状态](RELEASE_STATUS.md)；跨 Windows 真实互联暂缓，日常本机使用无需 Windows 在线。

从仓库根目录执行下面的命令。本仓库已经包含 Mac 原生界面、共享 Core/协议、PWA、打包脚本和测试，不需要私有仓库，也不需要 Windows 电脑在线。

## 工具与目录

- 已验证的环境：Apple silicon、macOS 26、Xcode 26、Node.js 22。应用声明的最低系统为 macOS 14；不代表已在每个 macOS/Xcode 组合中验收。Intel Mac 尚未验证，打包脚本当前以 arm64 命名。
- 需要 Swift 6 工具链（完整 Xcode，或下面已验证的 Command Line Tools）、Node.js、npm、Git。先读取版本；缺失时由用户决定安装，不自动切换全局工具链。
- 本次 Mac 本机也已验证：macOS 26.5.2、Command Line Tools / Swift 6.3.3、Node.js 24.15.0。原生编译和独立 Swift 回归可使用这套现有工具链，无需为此安装完整 Xcode 或切换全局配置。
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
npm run test:macos:supervisor
npm run test:macos:transport
```

`npm run package:macos:native` 会构建 Sidecar、PWA、Swift release 程序，生成：

- `output/macos-native/bundle/MathNotes.app`
- `output/releases/MathNotes-macOS-native-arm64-<版本>-<构建>-unsigned.zip`
- 同名 `.sha256`

当前打包使用本机 ad-hoc 签名，不需要 Apple Developer ID 或公证凭据。Mac 版本从 `deploy/releases/macos-release.json` 的 `version` 写入 App，独立于 Windows/PWA 版本；构建来自本次 Git 提交，存在未提交文件时带 `-modified`。无 Git 元数据的源码目录会使用 `local-时间`。公开仓库的提交号与此前测试包的构建号可以不同，以实际包内信息为准。

打包时必须在 `strip` 后显式签署内置 Node，再签署外层 App。不要仅依赖外层 `--deep`：放在 Resources 下的 Node 曾在外层验证通过时仍被 macOS 以 `CODESIGNING / Invalid Page` 终止。打包现在还会用空目录运行签名后的真实后台，健康检查失败则不会生成 ZIP。

快速打开可手动扫码的隔离副本：

```bash
node test_tool/launch_macos_isolated.mjs
```

此工具复制构建好的 App、使用唯一 bundle ID 隔离偏好、设置独立笔记与令牌目录，并通过 Launch Services（与 Finder 相同的启动机制）打开手机连接页。它将测试数据和日志保存在忽略的 `output/macos-local-debug/isolated-run.*` 下；关闭窗口退出此副本即可停止验收。它不替换已有安装或读取已有令牌。

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

`npm run test:macos:app-launch` 现在也使用唯一 bundle ID 的副本，并同时隔离笔记书签、路径、后台状态和宿主令牌。它会启动和退出测试副本、截取测试窗口；phone 模式还会用临时监听器验证 1051 端口冲突回退，并使用只读的测试 Tailscale 地址。该模式的二维码用于界面验收，不用于真实手机连接；真实扫码请使用上面的 `launch_macos_isolated.mjs`。

## 连续预览与操作栏回归（2026-09-07）

运行 `npm run test:macos:preview`：在临时目录生成同时包含 Markdown、图片、PDF 的合成笔记，使用真实 Core、SwiftUI 和 WKWebView 检查正文及 KaTeX 上屏、草稿更新复用 WebView、缺失一个正文文件时其余内容仍可阅读。该测试不访问生产笔记或密钥，也不调用真实 AI。仅做源码字符串或 Core 接口测试无法发现 SwiftUI 一直停留在加载分支的问题。

需要人工检查操作栏时，先打包，再运行 `node test_tool/create_macos_phase1d_fixture.mjs output/macos-local-debug/preview-fixture`，然后运行 `node test_tool/launch_macos_isolated.mjs output/macos-native/bundle/MathNotes.app output/macos-local-debug/preview-fixture`。有第三个参数时，启动器会把合成笔记复制到新的临时隔离目录，避免新 bundle 等待 Documents 访问许可；打开 Notebooks 中的样例即可。省略第三个参数仍保持原来的空目录手机验收行为。

连续预览只预载和等待 Markdown；图片/PDF 不计入 Markdown 完成数量。正文分段就绪即可显示；单段读取错误提供重试，不隐藏其他正常段。按 Windows 的标题点击入口，原始素材从左侧对应 block 名称打开原生查看器，独立图片/PDF 也保留在左侧列表中。右侧不再设置“阅读预览 / 原始素材”顶部栏。

按用户最新反馈，操作组以 overlay 浮在右下角，不预留整行底栏。按钮高 30 点，从左到右常驻 AI 对话、阅读/编辑、展开按钮；展开后在其上方显示导出、活动与更多操作，AI 对话位置保持不变。编辑、导出或选择导入后自动收起；活动面板打开时保留其锚点。验收应检查宽窄布局、浮层展开前后正文尺寸不变，以及 block 标题点击预览。

隔离启动器必须把初始来源写入独立 bundle 的 UserDefaults，不能使用 `-mathnotes.workspace.source.v1 local` 启动参数，否则 AppStorage 的后续切换会被参数域覆盖。生成易操作的素材演示可运行 `node test_tool/create_macos_feature_demo.mjs <空目录>`，再将这个目录传给隔离启动器；测试不覆盖任何已有目录。

## 两台电脑协作约定

本轮 Android 功能正在 Windows 上更新，不修改 Android 文件。空目录手机接收位置由 Mac sidecar 在可信本地请求配对二维码时准备；不要移到公开 verify/exchange 接口，也不要让普通启动或通用设置创建笔记。回归命令：先 `npm run build --workspace @mathnotes/shared`，再 `npm run test --workspace @mathnotes/core-server -- src/sidecar/macosSidecar.test.ts src/api/capabilityPolicy.test.ts`。

远程令牌仍保存在原有专用 Keychain service。打开设置只加载地址；非交互读取遇到旧包 ACL 时应提示用户主动授权或重新输入。不要用删密钥、改 ACL、明文持久化或自动弹系统密码框解决开发签名变更。`test:macos:supervisor` 覆盖进程交互状态的恢复和 Session 自动准备。

在 Mac 上创建自己的 `codex/` 修复分支，提交前检查 diff 和工作树，提交最小修复、测试及可公开的结论。通过公开仓库分支/PR 交回，Windows 端再拉取和验证共享模块；不要两台电脑同时改同一条分支，也不要把 `.app`、依赖缓存、日志、数据目录或密钥当源码提交。

## 阅读定位

点击左侧源码块会把右侧预览定位到对应内容段；双击预览正文会展开源码区并定位对应块。重新打开 Session 会恢复上次阅读的内容块和块内位置，记录按本机/远程主机分开，仅存于当前 App 偏好域。Notebooks 的悬停预览不会覆盖正文阅读位置。
