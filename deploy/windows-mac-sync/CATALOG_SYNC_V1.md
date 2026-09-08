# Windows 目录同步 v1

0.3.4「Mac 目录同步测试版」在已有正文、素材同步之上，增加远程新建笔记本/笔记、改名、移入废纸篓和恢复。设置中的构建编号及 ZIP 文件名用于区分旧包。此页是公开接口和操作验收说明。

## 接口

两条新增接口沿用受信主机凭据和 `workspace.sync` 权限，普通手机配对凭据不可调用。Windows 启动时先恢复操作记录，再开始监听。未装配目录服务的宿主不声明能力，并返回 503 `workspace_catalog_unavailable`。

| 方法 | 路径 | 结果 |
| --- | --- | --- |
| GET | `/api/v3/workspace/identity` | 原有字段之外声明 `capabilities` 中的 `catalog-operations-v1` |
| GET | `/api/v3/workspace/catalog-state` | `{version:1,notebooks:[CatalogTargetState],trash:[ReceiptWithRevision]}` |
| POST | `/api/v3/workspace/catalog-operation` | `{version:1,operationId,target:CatalogTargetState,deletionId?}`；JSON 上限 32 MiB |

请求共有字段：`operationId`（小写 UUID）、`action`、`notebookId`、可选 `sessionId`、`baseRevision`。省略 `sessionId` 表示操作整个笔记本。

| action | 附加字段与前提 |
| --- | --- |
| `create_notebook` | `title`、`baseRevision:null`，目标不得存在 |
| `create_session` | `sessionId`、完整 `snapshot`、`baseRevision:null`，父笔记本必须存在；素材通过原有 asset 接口以相同 operationId 预先暂存 |
| `rename` | `title`、当前对象的完整 `baseRevision` |
| `trash` | 当前对象的完整 `baseRevision`；响应含 `deletionId` |
| `restore` | `deletionId`、废纸篓对象的当前 `baseRevision`；原位置被占用时返回 409 |

`CatalogTargetState` 包括对象 ID、title、metadata、revision；笔记附完整 snapshot，笔记本附每个子笔记的 sessionId/title/revision。笔记本修订包含自身元数据及全部子笔记修订，因此任一子笔记改变后，旧基线不能删除整个笔记本。客户端使用服务端返回的完整修订值，不使用标题或日期代替。

成功请求的完整原始响应持久保存；丢失响应或进程重启后，原 operationId 与原请求可重试并取得首次结果。已成功删除后又恢复时，重试旧删除不会再次删除。相同 ID 改请求返回 409 `operation_reused`。客户端须保留原始请求，随后重新读取 catalog-state 获取当前状态，不能把历史重试响应当作当前目录。

废纸篓位于笔记库 `.mathnotes-trash/<deletionId>/`，包括 `receipt.json` 和完整 `payload`；恢复不覆盖同名对象。持久操作记录按笔记库根目录隔离，切换库不会复用另一库的记录。目录操作与 Windows 保存、AI/OCR 结果、素材、旁注、PDF 上传和导出共用写入屏障。AI 网络请求期间不占用全库屏障；返回时若笔记已删除，结果不会重新创建旧目录。

## 逐项验收

请先用测试笔记。自动化使用受控 HTTP 客户端和真实 Windows Electron，不代替真实 Mac 跨机验收。

| 编号 | 操作 | 应看到的结果 |
| --- | --- | --- |
| C01 | Mac 新建空笔记本、新建含图笔记，再分别改名 | Windows 目录及时出现并更新中文标题 |
| C02 | 记录笔记本修订，修改其任一子笔记，再用旧修订删除笔记本 | 409，整本保留 |
| C03 | 删除笔记或整个笔记本，再恢复 | 正文、素材、锁及原 ID 保留；目标冲突时拒绝覆盖 |
| C04 | 删除成功后恢复，再重试原删除请求；重启后重试原请求 | 返回原始结果，不重复删除；修改同 ID 请求返回 409 |
| C05 | Windows 留未保存草稿，Mac 删除当前笔记，再在 Windows 保存 | 明确提示已移入废纸篓，草稿保留，不能保存复活；可复制草稿 |
| C06 | 恢复 C05 的笔记 | 本地草稿仍在，不自动覆盖主机；重新载入需要确认 |
| C07 | 删除默认笔记和最后打开的笔记，完全退出并重开 Windows | 不自动重建旧 ID；空笔记库可正常打开并新建 |
| C08 | 同步中文、空格、括号、`#`、`%`、字面 `%23` 文件名的图片 | 正文实际显示正确图片，预览/Companion/分享素材字节一致 |
| C09 | 删除时有 AI/PDF/照片处理或导出正在进行 | 已排队写入完成后才移动，晚到操作拒绝写入旧位置，不阻碍恢复 |
| C10 | 使用普通手机凭据调用两个目录接口 | 无权调用，不获得全库管理能力 |

Markdown 图片路径按段编码：例如原文件 `assets/photo#50%.png` 使用 `../assets/photo%2350%25.png`。先分离未编码的查询/片段，再解码一次；原有路径穿越、链接、Windows ADS/设备名限制保留。

既有六条 v3 正文/素材接口、固定块和固定选区保护、未保存草稿冲突以及公式/表格连续渲染继续保留。另修复识别/助手轮询的旧“运行中”状态覆盖已完成结果的问题。

## 范围与限制

这一版交付 Windows 便携程序及共享 Core 源码，沿用 Android/PWA 0.3.4；没有重新发布 Mac 安装包。Mac 的离线副本、待上传操作与冲突界面由 Mac 客户端负责。目录协议本版有上述五种动作，尚不提供远程跨笔记本移动或永久清空废纸篓。

真实 Mac 与 Windows 跨机连接、断网重连及用户实际笔记库仍待复测。测试覆盖注入发布故障、占用文件、重启重试，不声称验证了任意硬件断电。

构建验证命令：workspace 单元测试、`npm run build:headless-network`、`npm run build:windows`、`node test_tool/electron_app_smoke.mjs`、`node test_tool/windows_mac_sync_smoke.mjs`、`node test_tool/windows_catalog_sync_smoke.mjs`。最终便携 EXE 再运行两项同步 smoke 和 `windows_portable_smoke.mjs`。发行页列出最终验证结果和校验和。
