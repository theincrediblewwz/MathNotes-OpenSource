# MathNotes macOS 0.3.6

面向 Apple silicon Mac 的原生预览版，内置 PWA 0.3.4、笔记 Core 和 Node 运行时。日常本机笔记与手机连接不需要 Windows 电脑在线。本次只发布 Mac 安装包；已有 Windows、Android 和独立 PWA 发行版保持不变。

## 0.3.6 更新

- 减少滚动阅读时源码区的布局重绘：无内容变化时不再重设编辑器字体，程序更新不再误触发源码激活；阅读位置在停滚后保存，退出/切换时补存。
- “打开 Notebooks”新增“导入”：支持 Windows 分享目录、ZIP 或与 assets 相邻的 Markdown；导入为新 Session，不覆盖原笔记。
- “导出”支持包含正文和引用图片/资源的 ZIP 分享包。解压后的 Markdown + assets 结构与 Windows 分享导出一致。
- 校验资源完整性、ZIP CRC、路径与文件大小；损坏或缺图的包不会留下半份笔记。

分享包支持 UTF-8 Markdown；上限为 256 MB、4096 个文件/目录、单资源 64 MB、正文 8 MB。导入保留包内 assets，导出按 Windows 逻辑仅收集正文引用资源。分享正文不包含 AI 密钥、连接令牌或编辑历史/锁定元数据。

已验证 Windows 共享导出器生成的目录 → Mac 导入 → ZIP 导出 → Mac 再导入及实际图片渲染。**Windows 当前源码未发现带资源的分享包导入入口；Mac ZIP 在 Windows 需先解压，Windows 应用端完整回导仍待实现/实测。** 文件格式兼容不等于两端 GUI 导入均已验收。

## 已包含的主要功能

- 修复手机连接后台启动失败和局域网 HTTP 连接；首次连接手机时可自动准备缺少的接收位置。
- 修复连续预览一直加载；支持公式渲染、Notebook/Session 悬停预览、单击打开和块标题原始图片/PDF 预览。
- 紧凑侧栏和创建入口；AI 对话、阅读与展开按钮浮在正文上方，不再占据整行。
- Notebook/Session 右键重命名、移至废纸篓与恢复。
- 固定选区按原文字顺序拆成前段、固定块、后段，保持连续公式和表格的渲染。
- AI 修改单个块或整个 Session 的候选方案、差异与修改摘要；固定块由程序保护，另外列出未应用的建议。
- 识别结果可内嵌本次原图；源码/预览双向定位、阅读位置恢复、⌘F 查找替换与撤销。
- 内置最新 PWA 0.3.4，保留上传、裁剪旋转、识别预览等功能，并修复手机视口的编辑面板裁切。

## 安装与验证范围

下载 `MathNotes-macOS-native-arm64-0.3.6-…-unsigned.zip`，核对同名 SHA-256 文件，解压后将 MathNotes.app 放入 Applications。应用支持声明为 macOS 14 或更新版本；当前实际本机验收为 Apple silicon、macOS 26。Intel Mac 和较早系统尚未实测。

此包使用 ad-hoc 签名，**没有 Apple Developer ID 签名或公证**。macOS 可能拦截首次打开；确认下载来源和校验和后，可按系统“隐私与安全性”页面提供的“仍要打开”流程处理。无需关闭 Gatekeeper、修改网络或删除钥匙串。更新前建议备份自己的笔记目录。

本机合成库已验证原生预览、保存、固定块、AI 候选应用、查找替换和目录恢复；PWA 浏览器上传流程使用受控识别服务验证。真实模型输出质量、不同手机的相机权限及后台行为仍依赖各自环境，不能把合成测试当作所有设备验收通过。

## 跨 Windows 同步：实验性，尚待真实跨机验证

按主机隔离的 Mac 本地副本、编辑队列、冲突保留、新建/改名/删除/恢复协议已实现。与 Windows PR #39 的实际 Core 代码完成了 23 项跨版本协议测试和 Mac 正式界面的隔离操作验收。

**Mac ↔ Windows 的真实跨机写入、断网重连和双方同时编辑尚待验证，本次不作为已验收功能宣传。** 当前发布以各电脑独立使用为主。相关代码和复测步骤保留在仓库，今后有需要可以继续开发；详见 [Mac 开发与验收状态](https://github.com/theincrediblewwz/MathNotes-OpenSource/blob/macos-v0.3.6/apps/macos/RELEASE_STATUS.md) 和 [目录协议](https://github.com/theincrediblewwz/MathNotes-OpenSource/blob/macos-v0.3.6/apps/macos/REMOTE_CATALOG_SYNC_V1.md)。

代码、构建版本及发行资产校验和以本 Release 对应的提交和随附文件为准。
