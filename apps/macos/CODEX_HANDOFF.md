# Mac Codex 接手：手机连接服务在用户 Mac 启动失败

更新时间：2026-09-07。先核对当前 Git；本文描述一个尚未解决的用户环境问题，不是“已修复”的验收报告。

## 目标与当前状态

用户有 Windows 和 Mac 两台电脑。此前 Windows 端通过 GitHub 的 Apple silicon runner 编译 Mac App，再把 ZIP 传给用户。现在转为在用户 Mac 上由 Codex 拉取完整公开源码、本地编译、运行和定位故障。

- 原症状：“连接手机”显示“手机连接没有准备好，本机连接服务未能正确启动，请重试”。
- 用户原来只知道安装的是“0.2.0 未签名版”，无法识别具体构建。
- 最近已提供 `0.3.1 / 76f9533099fc` 测试包；用户明确确认：**这个新版仍有相同问题**。
- 最近一次 GitHub macOS 26 / Xcode 26 编译、99 项 Swift 合同、205 项 UI 源码合同、长笔记及三次 App 启动检查通过。人工看过 runner 截图，手机页显示二维码。
- 该成功仅覆盖 runner，不能证明用户 Mac 的故障已修复。根因目前未知。
- 设置 → 通用 已加入版本、构建和复制按钮；ZIP 文件名也包含构建编号。本次应保留。

## 已经存在的修复，不要无依据重做

1. Sidecar 启动有 15 秒超时和重试状态。
2. 手机宿主默认端口 1051；仅在 `EADDRINUSE` 时改用操作系统分配端口，二维码使用实际端口。
3. 普通启动不恢复在线 AI Provider 密钥；AI 密钥仍在 Keychain，显式 AI 使用时才读取。
4. 本机手机宿主 token 已改为受文件权限保护的存储，不再查询旧宿主 Keychain 条目。
5. Tailscale 查询只读；普通启动不执行 `tailscale serve --bg` 或任何配置修改。
6. Android 二维码采用已有一次性 challenge 协议；手机侧身份、授权与正文写入边界不得为了绕过连接失败而放宽。

## 优先读取的代码

- `apps/macos/Sources/MathNotesMac/SidecarSupervisor.swift`：`start`、`launch`、`readReady`、`stop`；进程监督、stdout 第一行、状态竞争。
- `apps/macos/Sources/MathNotesMac/SidecarConfiguration.swift`：内置 Node/脚本定位、环境、数据目录与本机连接 token。
- `apps/macos/Sources/MathNotesMac/SidecarProtocol.swift`：`invalidReadyJSON` 与启动信息验证。
- `apps/macos/Sources/MathNotesMac/MacUserPreferences.swift`：`DirectoryBookmarkStore`；书签优先级和真实目录隔离。
- `apps/macos/Sources/MathNotesMac/PhoneConnectionSheet.swift`：失败信息及二维码界面。
- `packages/core-server/src/sidecar/main.ts`、`macosSidecar.ts`：ready 输出之前的初始化、持久状态读取和监听端口。
- `test_tool/package_macos_native.mjs`：Node 随包复制、strip/ad-hoc 签名、ZIP。
- `test_tool/diagnose_macos_connection.command`、`.mjs`：现有空目录诊断。

已核实的错误语义：这句中文来自 `SidecarProtocolError.invalidReadyJSON`。当前 `readReady` 在 stdout 第一行没有任何字节时抛出它，包括子进程在 ready 前结束或空行。JSON 解码错误本身走另一条错误。stderr 当前转给父进程 stderr，UI 没有保留实际退出原因。不要据此直接断言是 Tailscale、端口、签名或钥匙串。

## 建议执行顺序

1. 读取本文件及 `DEVELOPMENT.md`，核对 checkout、分支、dirty 文件，保留已有改动。记录本机架构、系统、Node、Swift/Xcode，以及故障 App 的真实版本/构建。
2. 按开发文档完整编译，先用隔离空目录运行；从终端捕获本次 stderr 和子进程退出码/信号，不把用户笔记作为测试夹具。
3. 对比本地编译包、现有故障包、终端与 Finder 启动。判断失败是在 Node 还没执行时、初始化数据时、网络监听时、ready 管道读取时，还是重试/取消竞争时。
4. 根据真实证据缩小范围；需要进一步读取用户既有状态时明确范围并使用副本。不要删除整个 user-data、钥匙串条目或用户偏好来“修复”。
5. 做最小修复并补能复现原问题的测试。用 mock/空数据验证，不发起付费 AI 调用。
6. 在该 Mac 上验证首次启动、退出重启、失败重试、连接页面二维码及实际手机配对。明确区分“已生成二维码”和“实际手机已经连接”。
7. 提交代码、测试、可公开结论；通过公开分支/PR 交回 Windows。原始日志留在本地，只提交去掉凭据、个人路径、笔记内容的诊断摘要。

## 边界

- 不修改、重启或重配代理、VPN、DNS、防火墙、路由、网卡、Tailscale 等主机联网服务。
- 不删除或迁移真实笔记、密钥、配对信息；不关闭 Gatekeeper 或通过批量移除 quarantine 掩盖问题。
- 保留共享模型、忠实转写、锁定保护与传输优先级；重大安全/协议改变先与用户对齐。
- 不把 GitHub 干净 runner 的成功当作用户 Mac 的验收，不宣称未知根因已修复。
- 没有委派其他 Agent 的授权；默认在当前 Codex 任务内完成。
