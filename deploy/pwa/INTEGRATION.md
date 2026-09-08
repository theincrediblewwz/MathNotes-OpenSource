# MathNotes PWA {{PWA_VERSION}} 集成说明

本更新包包含 PWA 静态文件和源码，不包含 macOS 原生应用或 Core 服务。适用于 MathNotes 宿主开发者和自行部署用户。

## 版本与内容

- PWA 版本：`{{PWA_VERSION}}`。
- 源码提交：`{{SOURCE_COMMIT}}`；PWA Git tree：`{{PWA_TREE}}`。
- 补丁基线：`{{BASE_COMMIT}}`；补丁仅涉及 `apps/pwa/`。
- `MathNotesPWA/`：预构建静态文件。
- `source/apps/pwa/`：完整 PWA 源码快照和测试。
- `patches/pwa-update.patch`：相对于基线的增量补丁。
- `reference/`：构建来源的依赖声明与锁定记录，供合并时比对。
- `artifact-manifest.json`、`SHA256SUMS`：来源、文件大小和 SHA-256。
- `verify-pwa-update.mjs`、`public_material_policy.mjs`：只读包内容核验脚本。

## 验证与源码集成

1. 核对 ZIP 的 `.sha256` 后解压到独立目录，执行 `node verify-pwa-update.mjs`，应输出 `PWA_UPDATE_VERIFIED`。
2. 在完整 MathNotes 仓库中确认工作区状态。先运行 `git apply --check /解压目录/patches/pwa-update.patch`，成功后再运行 `git apply /解压目录/patches/pwa-update.patch`。
3. 基线不匹配时，将 `source/apps/pwa/` 与当前源码比较并逐项合并，审阅新增、修改和删除项。根依赖记录只作参考，应按工作区现有依赖合并。
4. 运行 `npm run test --workspace @mathnotes/pwa` 和 `npm run build:pwa`。PWA 使用完整仓库的 npm 工作区与测试依赖。

预构建静态文件以随包 SHA 清单为准。不同 Node/npm/操作系统重新构建可能产生不同 hash；重建后应记录来源并重新验证功能。

## 宿主兼容要求

已上传队列定位需要宿主支持 `GET /api/v1/uploads/status?uploadId=...&notebookId=...&sessionId=...`，返回真实的 `notebookId/sessionId/sha256/mimeType/originalName/assetPath/imageBlockId/transcriptBlockId/recognitionStatus`。状态应读取当前识别任务；查询不应初始化识别 Provider。旧宿主缺少这些字段时，可能无法取回已清理的素材或准确定位。

正文块保留 `data-block-id` 和 `id="mathnotes-block-<blockId>"`。每块内同一图片第一次出现使用 `id="mathnotes-block-<blockId>-asset-<assetId>"`，并保留 `data-companion-asset-id`；`assetId` 为素材路径 SHA-256 的前 24 位。隐藏块和放大副本不能替代正文中的可见位置。素材按已有配对权限通过 `/api/v1/companion/asset` 读取并核对 SHA。

相应宿主实现位于完整仓库的 `packages/core-server/src/api/networkApiContracts.ts`、`networkApiServer.ts`、`session/companionReadService.ts` 和 `session/sessionPhotoIngestAdapter.ts`，并有相邻测试。仅替换 PWA 不会升级这些服务，也不会增加 Core 的 AI 原图标记能力。

阅读 iframe 使用 `sandbox="allow-scripts"`，不授予 `allow-same-origin`。CSP 仅允许固定桥脚本的 hash；父页验证 iframe source、opaque origin、随机 channel 和消息类型。桥仅处理准备完成、定位和底栏切换。

## macOS 打包与静态部署

`npm run package:macos:native` 会先构建 PWA，再复制 `apps/pwa/dist` 到 `MathNotes.app/Contents/Resources/MathNotesPWA`。应先整合源码后打包；直接替换已签名应用中的静态文件会使签名失效，并在下次构建时被源码覆盖。

开发时可通过进程环境变量 `MATHNOTES_PWA_STATIC_ROOT_DIR` 指向解压后的 `MathNotesPWA` 绝对路径。生产部署方式及 HTTPS 要求见 `DEPLOYMENT.md`。

## 功能验证

- 页面显示正确版本，浏览器重新加载后使用新静态文件。
- 中文笔记本名称、数学内容和标准 Markdown 图片显示正确；图片支持放大。
- 裁剪四角与实际上传边界一致；画笔中的白色矩形遮盖在旋转、透视后仍与上传成品一致。
- 已上传素材可预览；识别完成后跳到真实图片或转写位置；目标不存在时显示明确提示。
- 左上角目录按钮弹出可内部滚动的圆角气泡，选中标题后跳转并关闭；轻点正文可显隐底栏。

上述功能应先用测试笔记验证。单独更新 PWA 不等于修复宿主启动问题，也不代表已完成所有浏览器与手机型号的兼容验证。
