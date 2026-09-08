# MathNotes

MathNotes 是一个 GPLv3、本地优先的数学笔记项目，包含 Windows、macOS、Android 与 PWA。它围绕“图片/PDF → 忠实 Markdown 草稿 → 人工校订与锁定 → 连续阅读与导出”工作。

**最新发行版：0.3.4 试用版。当前 Windows / Android / PWA 开发版本：0.3.4。**

Windows 最新测试构建为 **0.3.4「Mac 目录同步测试版」**：在正文、素材和草稿保护之外，增加远程新建笔记本/笔记、改名、移入废纸篓及恢复，并修复特殊文件名图片和删除后重启的问题。设置中显示构建编号，便于区分旧包。[下载 Windows 目录同步测试包](https://github.com/theincrediblewwz/MathNotes-OpenSource/releases/tag/windows-catalog-sync-20260908) · [目录接口与逐项验收表](deploy/windows-mac-sync/CATALOG_SYNC_V1.md) · [原正文同步说明](deploy/windows-mac-sync/WINDOWS_MAC_SYNC_RESULT.md)。这次没有重新发布 Android、PWA 或 Mac 安装包；真实 Mac 跨机验收仍待完成。

[下载最新发行版](https://github.com/theincrediblewwz/MathNotes-OpenSource/releases/latest) · [0.3.4 固定发行页](https://github.com/theincrediblewwz/MathNotes-OpenSource/releases/tag/v0.3.4) · [逐项操作验收表](deploy/releases/v0.3.4-acceptance.md)

公开默认分支 `main` 包含已合入的整合源码；原 0.3.4 整合分支为 `codex/release-v0.3.4-integration`，Windows 同步源码分支为 `codex/windows-mac-sync-20260908`。源码可以使用和修改，但自动测试不能替代真实 Windows、Apple silicon Mac、Android 与 iPhone 验收。

| 平台 | 本次可用版本 | 交付内容 |
| --- | --- | --- |
| Windows | 0.3.4 | 已内置新版 PWA 的便携 ZIP，解压后运行 MathNotes.exe |
| Android | 0.3.4，versionCode 17 | APK，沿用既有测试签名 |
| PWA | 0.3.4 | 独立网页/源码更新 ZIP，附公开集成说明 |
| macOS | 本次没有新安装包 | 提供 Mac 源码和本地构建文档 |

本版提供 Windows 便携 ZIP、Android APK 和独立 PWA 更新包。Windows 为未签名测试包，Android 沿用既有测试签名；覆盖安装前请备份笔记。Mac 源码与本地开发文档公开，安装包需在 macOS 上构建。

0.3.4 修复了块拖动原地放下误报导入、重新识别未实际执行，并补齐已上传素材预览与正文定位、左上角可滚动气泡目录、阅读底栏显隐和画笔内矩形遮盖。各包的版本、SHA-256、验证范围与已知限制以该发行页为准。

## 这次改了什么，怎么自己验

本表包括前后两轮改动，便于逐项复测。“已测”指合成笔记、受控 Provider、Windows 成品、浏览器或 Android 模拟器的对应测试，不等于你的真机已经通过。完整操作和反馈编号见[验收表](deploy/releases/v0.3.4-acceptance.md)。

| 平台 | 已修改内容 | 你可以怎样验 | 当前验证范围 |
| --- | --- | --- | --- |
| Windows | 启动显示与初始化优化 | 完全退出后重开，观察白屏和正文出现时间 | 小型测试库已测；真实大库速度待复测 |
| Windows | 最近阅读重命名、删除 | 右键一条测试笔记记录 | 菜单/重命名/取消与删除服务已测 |
| Windows | 拖动时四行预览、修复原位放下误报 | 拖标题换位，再原地放下或取消 | 实际拖动与外部 Markdown 导入已测 |
| Windows | 重新识别真正执行 | 重识别已完成照片，观察进行中与新结果 | 实际测试 Provider 请求、失败/取消/锁保护已测 |
| Windows | AI 修改全文与锁定说明 | 在 AI 模式选择“修改全文”，让它统一多个块的记号 | 修改报告、锁定原文保留已测 |
| Windows | 移动/复制目标选择器圆角 | 展开“目标笔记”菜单 | 实际样式已测 |
| Android / PWA | 已上传素材预览、跳到正文位置 | 点已上传记录，再跳到所在笔记 | 成品取回/校验与真实正文定位已测 |
| Android / PWA | 左上角滚动气泡目录、轻点显隐底栏 | 在长笔记点目录按钮、滚动目录、选标题；轻点正文 | 本机/电脑阅读与浏览器流程已测 |
| Android / PWA | 编辑留白、裁剪边缘一致、画笔内白色矩形遮盖 | 拖裁剪圈、遮盖文字后加入队列，对照成品 | 几何/像素/实际上传成品已测；真机处理耗时待复测 |
| Android | 完整原相机入口与中文笔记本名 | 选“打开手机原相机 · 拍完后导入”；刷新电脑笔记目录 | 入口/同步逻辑已测；Vivo 高倍率画质待真机复测 |
| 三端 | 图形识别处显示完整处理后照片、点开放大 | 用含图形的照片识别，检查正文图片 | 图片标记、绑定与渲染已测；实际模型结果可继续反馈 |
| Android | 重启/恢复网络续传、暂停保护 | 排队后正常重启；断网后恢复；已暂停项应保持暂停 | 正常重启与两轮无进程联网恢复通过，约 6.1 秒收到测试回执；厂商后台策略待真机复测 |

仍未验证的项目没有算作完成：Vivo 厂商高倍率画质、真实手机大照片处理耗时、真实大库启动表现、Safari/Mac 真机与新的 Mac 安装包。遮盖的 8 张盲测没有发现误判，但不能保证所有模型都不会误判。

## 核心闭环

1. Android 或 PWA 拍照/选取素材；Android 既可独立识别，也可作为桌面 Companion。
2. Companion 模式可经手机热点、电脑热点、USB 网络、可信 Wi-Fi 或 Tailscale 连接桌面主机。
3. Windows/macOS 将素材写入 Notebook/Session，并交给用户选择的识别服务。
4. 识别结果只进入 Markdown 草稿 block；用户校订与锁定内容由程序保护。
5. Windows 连续渲染 PDF、图片和 Markdown，并导出便携 Markdown 或分享包。

## 隐私边界

- 照片传输不经过 MathNotes 云端；Windows 接收服务只在用户设备间工作。
- 使用联网识别服务时，图片会发送给用户在设置中选择的第三方 Provider。
- API key、配对 token、运行日志不进入笔记备份或分享包。
- 当前不上传遥测或崩溃报告。

请始终自行备份 Notebook 目录。不要把 API key、配对 token、签名密钥、私人笔记或照片提交到 Git。

## 开发

需要 Node.js 22+、npm 与 Git。Windows 桌面开发还需要 Windows 11；Android 构建需要 JDK 17 与 Android SDK 34。

```powershell
git clone --branch codex/release-v0.3.4-integration https://github.com/theincrediblewwz/MathNotes-OpenSource.git
cd MathNotes-OpenSource
npm ci
```

运行主要检查：

```powershell
npm ci
npm run test:unit
npm run build:windows
npm run test:electron-smoke
npm run test:android
```

PWA 与同域识别网关：

```powershell
npm run test:pwa
npm run test:standalone-worker
npm run package:standalone-worker
```

Windows 便携包：

```powershell
npm run package:windows:portable
npm run test:windows:portable
```

Android 调试包：

```powershell
npm run build:android
```

macOS 原生端必须在真实 Apple silicon Mac 与完整 Xcode 上构建：

在 Mac 上开发或排查“连接手机”启动失败，请先读 [Mac 本地开发](apps/macos/DEVELOPMENT.md)。应克隆整个仓库；Swift 界面依赖共享 Core、协议与 PWA，不能只复制 `apps/macos`。

```bash
npm ci
npm run test:macos:native-package
npm run package:macos:native
```

## 可选：在 Windows 中使用 WSL Codex

MathNotes 不要求固定的 WSL 发行版，也不要求本机专用 wrapper。

1. 安装任意可用的 WSL 发行版。
2. 在该 WSL 中安装并登录 Codex，确认 `codex --version` 可运行。
3. 在 MathNotes 设置中选择 `Codex CLI`，运行方式选择 `WSL`。
4. “命令”填写 `codex`；“WSL 发行版”可留空以使用系统默认发行版，也可填写自己的发行版名称。

若你自行创建了 wrapper，可在“命令”中填写它在 WSL 内的路径；不要把登录信息、token 或本机绝对路径提交到仓库。

Android 正式候选与发布体积报告：

```powershell
.\apps\android\gradlew.bat -p apps\android assembleRelease bundleRelease --no-daemon
npm run release:footprint
```

## 数据模型

Notebook 包含多个 Session；Session 由按序 block 组成。PDF 保持原文件并只读嵌入，图片保留来源，识别结果和用户笔记分别写入 Markdown block。锁定信息同时保存在 Markdown 标记和 metadata 中。

## 发布状态

- 源码：按 `GPL-3.0-only` 开放，可自行构建、修改与再分发；衍生分发需遵守 GPLv3。
- Windows：可以分发未签名便携包，但 SmartScreen 可能警告。
- macOS：未加入 Apple Developer Program 时只能提供 ad-hoc/未公证包，Gatekeeper 会警告或阻止普通双击安装。
- Android：APK 必须签名，但可使用免费、自生成的 release key；密钥不得提交仓库。
- PWA：可自行部署；同域 Worker 方案要求在托管平台安全配置 Provider secret。
- 尚不可宣称：稳定版、商店上架、已完成所有真机矩阵或无安全漏洞。

本仓库不会提供 API key、配对 token、签名密钥或第三方服务额度。发布时的依赖安全证据只是时间点快照；依赖安全状态会随时间变化，请以当前 Security 页面和本地审计结果为准。

## 许可证

MathNotes 自有源码采用 [GNU GPL v3.0 only](LICENSE)。第三方组件继续遵循各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 报告。
