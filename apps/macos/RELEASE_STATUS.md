# Mac 0.3.6 开发与验收状态

2026-09-08 发布收尾。Mac 的本机主要功能与 PWA 集成已实现；跨 Windows 的真实互联延期，不阻塞本机版发布。本文件用于从公开仓库恢复开发，不包含私人笔记、设备地址、令牌或本机绝对路径。

| 功能 | 当前证据 | 后续范围 |
| --- | --- | --- |
| 紧凑侧栏、创建按钮、浮动操作组 | 原生界面验收 | 更多系统版本 |
| Notebook/Session 管理、单击打开 | 实际鼠标操作及合成库恢复 | 大型真实笔记库 |
| 预览与素材 | 真实 WKWebView 公式/图片/PDF 回归 | 不同来源复杂笔记 |
| 固定块、选区拆分 | 原字节、顺序、公式表格、锁定保护回归 | 更多真实内容 |
| AI 修改块及 Session | 受控 Provider 的候选、摘要、锁定建议、版本冲突验证 | 真实模型效果 |
| 原图标记与内嵌 | 原图字节、编码文件名、渲染位置及目录隔离验证 | 手机实拍质量 |
| 查找替换、双向定位、阅读位置 | 原生回归、鼠标操作及退出重开 | 大型笔记性能 |
| PWA 0.3.4 | 单测、构建、浏览器上传/裁剪/成品预览 | 手机相机和后台策略 |
| 跨主机副本与目录同步 | Windows PR #39 Core 跨版本 23 项及 Mac 正式视图 loopback 验收 | **真实 Mac ↔ Windows 尚待验证** |

## 0.3.6 分享包与滚动稳定性

源码编辑器的无变化更新不再写入 NSTextStorage 字体，不触发源码激活；阅读位置改为停滚 500 ms 后保存，卸载/退出/失去前台时补存。原生回归检查重复更新不改变布局、光标与激活状态，真实字体修改仍能应用；个别设备的间歇闪烁仍需持续观察。

本机 Notebooks 的“导入”支持 ZIP、Windows 分享目录及旁边带 assets 的 Markdown；当前打开 Notebook 时导入到其中，否则创建新 Notebook。导出菜单可生成含引用资源的 ZIP。新 Session 使用独立 ID，完整校验并准备文件后原子加入目录；失败不覆盖用户笔记。资源和 ZIP 检查由 Core 执行，手机网络 API 不开放本地文件导入。

兼容性以 Windows 现有共享导出器生成的 Markdown + assets 为准，验证目录导入、ZIP 往返、特殊文件名和图片字节。Windows 当前源码没有完整分享包导入入口，因此 Windows GUI 的反向回导仍待实现/实测，不把同格式导出宣称为双端均可一键导入。

## 0.3.5 界面修复

悬停预览已增加鼠标离开与卡片移除时的关闭处理，预览层不再拦截点击；原生编译和既有界面检查通过，实际指针的完整移动路径仍待用户验收。废纸篓改为顶部标题栏、紧凑空状态和随条目数量调整的窗口，已检查真实空弹窗及有条目组件的渲染。新建弹窗统一主题和 Escape 关闭操作。

## 接续跨机工作

1. 从此 Release 的 tag 克隆完整仓库，阅读 `DEVELOPMENT.md`、`REMOTE_CATALOG_SYNC_V1.md` 与 `deploy/windows-mac-sync/CATALOG_SYNC_V1.md`。
2. Windows PR #39 的功能提交为 `6ab10fff3eaabe2270381d64bb25712585dbf0e4`；main 合并提交为 `c78b65166ec888a78ddf5502d74d6606948e7773`。先检查是否已有更新。正在运行的 Windows 程序也必须是包含目录协议的版本。
3. 只使用独立合成笔记库和测试凭据，在两台电脑验证：新建含图笔记、双方改名、删除恢复、断网编辑重连、丢响应原请求重试、409/423 冲突及本地备份。不要用真实笔记做覆盖和删除测试。
4. 确认跨机主机身份与每台主机的独立目录，验证同名 Notebook/Session 不串库；保留 Windows 现有共享写入屏障和已打开草稿。
5. 记录双方版本、测试步骤及结果，再调整“尚待验证”的发布说明。不要因端口可达或单侧单测通过就改成“跨机已通过”。

## 构建与证据

详见 [本地开发](DEVELOPMENT.md)。主要命令：`npm ci`、`npm run build:headless-network`、Core/PWA/shared/sync-contract 单测、`npm run test:macos:preview`、`npm run package:macos:native`、`npm run test:macos:native-package`。

`test_tool/macos_windows_catalog_interop.mjs <Windows提交>` 从已 fetch 的 Git 提交读取原始主机代码，以当前 Mac 客户端跑目录和正文回归。`launch_macos_remote_acceptance.mjs --host-source=<上游归档>` 可做正式 Mac 视图的隔离验收。它们验证在 macOS 上运行的主机代码，不替代 Windows OS 的跨机实测。

历史本机测试记录：原 Mac Core 320 项、PWA 83 项，以及原生 UI/渲染测试通过。发布整合分支的 Core 已增至 409 项通过、2 项跳过；Windows 单测在 Mac 上有两项 Windows 路径假设导致失败，由 Windows CI 作最终判断。最终 CI 和发布包结果以 GitHub Actions 记录为准。
