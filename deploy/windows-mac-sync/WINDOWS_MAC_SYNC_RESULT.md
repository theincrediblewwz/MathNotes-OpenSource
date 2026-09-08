# Windows 接入 Mac 副本同步：接口与验收说明

Windows 在原 0.3.4 上增加「Mac 同步测试版」。设置会显示构建编号，便携 ZIP 文件名也含相同源码提交缩写。它是单独的 Windows 测试构建，Android/PWA 仍使用原 0.3.4。本次不包含新 Mac 安装包。

## 支持范围

Windows 宿主支持已有 Session 的正文与素材同步。Mac 客户端负责离线副本、待传操作和冲突展示；本发行版不包含新的 Mac 客户端安装包。构建提交、ZIP 和校验和见对应发行版。

## 可逐项验收的改动

所有步骤先使用测试笔记。真实跨机 Mac 联调尚待验收；下列已有受控 HTTP 客户端和实际 Windows Electron 验证。

| 编号 | 你可以怎么验 | 预期结果 | 本地验证 |
| --- | --- | --- | --- |
| S01 | Mac 用 Windows 的受信主机凭据连接；Windows 重启后再连 | hostId 持久且不随 IP/进程变化；普通手机设备凭据无全库写权限 | 六路由权限、持久身份/并发初始化通过 |
| S02 | Mac 拉取含中文/空格文件名、图片和 PDF 的已有 Session | 原始 Markdown、锁、未知兼容字段及实际素材字节完整；不改变换行 | Core 快照/哈希/图片引用测试通过 |
| S03 | Windows 打开笔记但不编辑，Mac 同步新正文 | Windows 已打开内容刷新，原手机上传和 Companion 事件保留 | 实际 Electron + HTTP 通过 |
| S04 | Windows 留一份未保存草稿，Mac 更新同一笔记，然后 Windows 点保存 | 阻止旧草稿覆盖新主机内容；草稿保留，可查看主机版本；重新载入须明确确认 | 实际保存、关闭预览、取消/确认重载通过 |
| S05 | 对一次成功提交模拟丢失响应，重试原 operationId/原请求 | 不重复写入；重用 ID 改请求返回 409；基线过期返回 409 | HTTP 重启重试和1024条持久账本通过 |
| S06 | 修改、删除固定块或旧固定选区；对多个块提交且其中一个违规 | 返回 423 或本地明确拒绝；所有块均不发生部分覆盖 | 单块/整批/旧span/AI旁路回归通过 |
| S07 | Mac 将公式或表格中间选区拆成同组的前/固定/后三块 | Windows 正文、实时预览、悬停、分享和导出连续渲染，原文直接拼接；编辑仍保留每块身份 | 实际公式/表格显示、导出和单元用例通过 |
| S08 | Windows 设置查看版本，再核对 ZIP 文件名 | 显示 0.3.4、Mac 同步测试版和构建编号；可以和旧包明确区分 | 解压后的EXE通过，编号6aa87aeb8beb |
| S09 | 把Windows窗口缩窄，连续向左、向右拖动中央分隔线 | 分隔线持续跟随指针，不会误启动块标题拖拽 | 1024×720复现后修复，原生回归通过 |

## 最终接口与兼容约定

| 方法 | 路径 | 成功结果 |
| --- | --- | --- |
| GET | `/api/v3/workspace/identity` | `{version:1,hostId,name}` |
| GET | `/api/v3/workspace/catalog` | `{notebooks:[...]}` |
| GET | `/api/v3/workspace/snapshot?notebookId=...&sessionId=...` | `ReplicaSnapshot` |
| GET | `/api/v3/workspace/asset?notebookId=...&sessionId=...&path=...&sha256=...` | `application/octet-stream`，字节校验 |
| POST | `/api/v3/workspace/asset` | `{operationId,sha256,base64}` → `{ok:true}` |
| POST | `/api/v3/workspace/push` | `{operationId,baseRevision,snapshot}` → 提交后 `ReplicaSnapshot` |

- 沿用 `trusted-host` 令牌及 `workspace.sync` 能力。不要给普通 Android/PWA 配对令牌升级写权限，不在日志中打印凭据。未装配同步服务的宿主返回 503 `workspace_sync_unavailable`；本次装配对象是 Windows 桌面应用。
- `ReplicaSnapshot={version:1,notebookId,session,markdown,assets,revision}`。修订仍为 `sha256(JSON.stringify([session, Object.entries(markdown).sort(([a],[b])=>a.localeCompare(b)), assets]))`；素材按路径排序。Mac 重试必须原样保存整个 `ReplicaPush`，不能拿响应快照替换原待传请求。
- 接收 Markdown 原始字节，不 trim 或修数学定界符。图片支持标准 `../assets/...` 和已有 `assets/...` 引用，安全解码百分号/中文/空格；连续片段先按相邻可见组拼接再收集图片。禁止目录穿越、Windows ADS/设备名/大小写别名、链接逃逸。
- 请求大小上限：push JSON 32 MiB；stage JSON 73 MiB；Base64 72 MiB，对应素材最大54 MiB。超限有界拒绝，不无界缓冲。既有超大素材超过此同步上限时需两端另行协商分块方案。
- 服务端保留 `remoteSyncOperations` 至少最近1024项，客户端不能覆盖账本。旧 baseRevision 返回409 `revision_conflict`；同ID换请求返回409 `operation_reused`；固定块/span返回423；不可变素材冲突409，未暂存素材409。
- 共享 Windows Session 写队列覆盖普通保存、AI、OCR和块操作；普通保存另带 `revisionBaseline`，缺失基线拒绝。版本基线只是 Windows IPC 合同，不要求 Mac 改用该字段。
- 固定选区的解锁必须单独提交：仅删除对应 span 包装和锁记录，正文及其他锁逐字保留；成功获取新修订后再编辑。不能把解锁与改正文合并以绕过保护。整块锁定/只读块仍拒绝该操作。
- 素材和正文先写入新文件，落盘后一次替换 `session.json` 发布，旧文件保留。已测试 Windows 文件被占用时发布失败保留旧清单，释放后同操作可恢复；没有用断电破坏真机来验证任意硬件断电情形。
- 保留 `continuationGroup`、每块锁和素材入口；Windows仍使用 `session_edit` 提案，未迁移 Mac `session_rewrite` 提案或 Swift UI。两端提案文件不能互换。
- 原图标记继续用 `[[mathnotes:source-image]]`，由程序绑定处理后整图；代码、数学公式和引用示例中不激活标记。未使用付费模型测试。

## 测试与产物

实际命令：workspace 单元测试、`npm run build:headless-network`、`npm run build:windows`、`node test_tool/windows_mac_sync_smoke.mjs`，以及最终的 `npm run package:windows:portable` 和便携 EXE smoke。

单独运行各 workspace：Windows 89文件/612项、Core 42文件/274项、PWA 21文件/83项、Shared 6文件/27项、Sync Contract 3文件/18项通过。Windows 使用单 worker/forks，其余使用单 worker/threads。跨 workspace 聚合执行曾遇到 Windows IPC/原生进程退出，未计作通过；独立重跑均退出0。

实际 Electron 综合回归通过；同步证据：`output/playwright/windows-mac-sync/result.json`、`windows-draft-conflict.png`、`windows-continuous-formula-table.png`。测试仅操作独立合成笔记库和应用状态目录。最终ZIP解压后便携EXE启动和完整同步smoke通过，详见[构建验证记录](BUILD_VALIDATION.md)。

## 兼容验证与限制

真实 Mac 跨机兼容性尚待验证：复制含图/PDF笔记、离线编辑后恢复、丢失响应后复用原 operationId、处理409/423并保留本地草稿。客户端应在成功响应后更新副本基线。Windows 不会主动读取 Mac 的本地磁盘。

远程 Notebook/Session 新建、重命名、移动和删除尚未实现。当前 push 仅修改已有 Session，客户端不能依赖隐式目录创建。真实 Mac/Safari联调及厂商手机后台策略不能由本地自动测试代替。
