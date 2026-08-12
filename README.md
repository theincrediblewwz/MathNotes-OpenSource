# MathNotes

MathNotes 是一个 GPLv3、本地优先的数学笔记项目，包含 Windows、macOS、Android 与 PWA。它围绕“图片/PDF → 忠实 Markdown 草稿 → 人工校订与锁定 → 连续阅读与导出”工作。

当前版本：`0.1.11 alpha`。源码可以使用和修改，但自动测试不能替代真实 Windows、Apple silicon Mac、Android 与 iPhone 验收。

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
git clone https://github.com/theincrediblewwz/MathNotes-OpenSource.git
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

本仓库不会提供 API key、配对 token、签名密钥或第三方服务额度。当前 npm 审计仍有已知 high 级依赖链问题，升级需独立回归。

## 许可证

MathNotes 自有源码采用 [GNU GPL v3.0 only](LICENSE)。第三方组件继续遵循各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 报告。
