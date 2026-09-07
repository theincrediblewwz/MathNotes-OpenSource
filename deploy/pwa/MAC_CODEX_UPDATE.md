# Mac Codex 接手：MathNotes PWA {{PWA_VERSION}}

这是手机网页的独立更新包，不包含 Mac 主程序或 Core 服务。请先完成当前 Mac 本体工作，再在你自己的开发分支整合。不要 checkout/reset 旧分支覆盖当前 Mac 修改，也不要直接覆盖整个仓库。

## 版本与内容

- PWA 版本：`{{PWA_VERSION}}`，以 `apps/pwa/package.json` 为准。
- 源码提交：`{{SOURCE_COMMIT}}`；PWA Git tree：`{{PWA_TREE}}`。
- 补丁基线：`{{BASE_COMMIT}}`，只涉及 `apps/pwa/`。
- `MathNotesPWA/`：已经构建的静态文件，无 Node 依赖安装要求。
- `source/apps/pwa/`：该版本完整的 PWA 源码快照（包含测试）。
- `patches/pwa-update.patch`：从上述基线到本次源码的 PWA 增量补丁。
- `reference/package.json` 和 `reference/package-lock.json`：该构建来源的完整仓库依赖记录，只作比对，不应直接覆盖你目前 Mac 仓库的根文件。
- `artifact-manifest.json` / `SHA256SUMS`：逐文件字节数、SHA-256、源码来源和构建版本。
- `verify-pwa-update.mjs`：只读核验脚本，不修改 App 或运行环境。

此版设置页直接显示 PWA package.json 的真实版本；用随包清单同时核对源码提交。保留自由裁剪、边缘留白、笔/箭头、套索、透视及整张成品照片放大。新增已上传队列的成品预览、定位到笔记中的实际照片/转写位置、阅读目录及轻点正文收起/恢复底栏；遮盖放进画笔菜单，新遮盖为不透明白色矩形，旧黑色涂抹仍可读取。

图片能力的范围：本包显示并放大宿主已经提供的标准 Markdown 图片。AI 自动插入新的 `source-image` 标记属于宿主 Core 识别服务／Android 独立识别的改动；本包不包含 Core，单独更换 PWA 不会更新 Mac 的识别服务。若 Mac 也要该自动识别行为，需要另外审阅和合并相应 Core 改动，保留你正在修复的 Core 代码。

## 宿主兼容要求

新队列定位还需要宿主支持按目标查询的 `GET /api/v1/uploads/status?uploadId=...&notebookId=...&sessionId=...`。回执应返回真实 `notebookId/sessionId/sha256/mimeType/originalName/assetPath/imageBlockId/transcriptBlockId/recognitionStatus`；状态必须读取当前识别任务，不能只返回首次上传时缓存的状态。查询不应初始化识别 Provider。未支持这些字段的旧 Mac 宿主仍可使用完整本地成品预览，但可能无法取回已清理的素材或准确跳转，界面会说明无法确认位置。

正文块应保留 `data-block-id` 并提供 `id="mathnotes-block-<blockId>"`。每块内同一实际图片的第一次出现提供 `id="mathnotes-block-<blockId>-asset-<assetId>"`，图片保留 `data-companion-asset-id`。`assetId` 沿用素材路径 SHA-256 的前 24 位；不能给隐藏素材块或放大副本伪造一个可见位置。按已有配对权限读取 `/api/v1/companion/asset` 并核对 SHA 后才可作为完整上传成品。

对应参考实现位于上述源码提交的 `packages/core-server/src/api/networkApiContracts.ts`、`networkApiServer.ts`、`session/companionReadService.ts`、`session/sessionPhotoIngestAdapter.ts`，并有相邻单元测试。它们不在本 PWA ZIP 内；请 Mac Codex 在自己当前 Core 修改上核对并移植这些增量，不覆盖整个 Core 目录。独立 PWA 公开分支不会改动当前 Mac 分支或公开仓库 main。

阅读 iframe 现在使用最小脚本桥。必须保留 `sandbox="allow-scripts"` 且不增加 `allow-same-origin`，CSP 仅允许本包固定桥脚本的 hash；父页校验当前 iframe 的 source、opaque origin、每份文档随机 channel 和消息类型。桥只处理准备完成、定位及底栏切换，不能接收任意脚本、URL 或网络请求。

## 先核验，再接入源码

1. 用 GitHub 附件提供的 ZIP `.sha256` 校验压缩包，再解压到单独目录。不要解压覆盖当前仓库。
2. 在解压后的目录执行 `node verify-pwa-update.mjs`，应输出 `PWA_UPDATE_VERIFIED`。该命令同时验证清单列出的全部文件和不应多出的文件。
3. 在 Mac 项目根运行 `git status --short`，确认当前分支和未提交改动。保留你的 Mac 修复；如 `apps/pwa` 有本机改动，需要逐项合并。
4. 对增量补丁先运行 `git apply --check /解压目录/patches/pwa-update.patch`。成功后再运行 `git apply /解压目录/patches/pwa-update.patch`。这两步都在 Mac 项目根执行。
5. 如果补丁基线不匹配，不要强行应用。将 `source/apps/pwa` 与当前 `apps/pwa` 比较，只合并该目录的改动，新增文件也要加入；参考清单识别删除项，不删除当前 Mac 自己新增的文件。
6. 在项目根检查 `git diff -- apps/pwa`，确认没有触碰 `apps/macos`。本版 PWA 没有新增 npm 依赖；声明与锁定记录见 `reference/`。沿用 Mac 仓库现有安装流程；如 npm 报工作区元数据与 lock 不一致，先检查版本差异，再用 `npm install --package-lock-only --ignore-scripts --workspace @mathnotes/pwa` 更新元数据并审阅差异。
7. 运行 `npm run test --workspace @mathnotes/pwa` 和 `npm run build:pwa`。PWA 不是独立的裸源码工程：它沿用完整 MathNotes 仓库的工作区和现有测试依赖，不需要复制 Windows、Android 或 Mac 新源码。

## 集成到 Mac App

当前 `test_tool/package_macos_native.mjs` 会运行 `npm run build:pwa`，随后把 `apps/pwa/dist` 完整复制到 `MathNotes.app/Contents/Resources/MathNotesPWA`。确认新 PWA 源码已进入你的分支，再执行项目已有的 `npm run package:macos:native`；这会按 Mac 现有流程构建并签名，不需要修改 Mac 源码。

如果 Mac 本体还在调试，但只想检查本包的静态页面，可让当前开发进程的 `MATHNOTES_PWA_STATIC_ROOT_DIR` 指向解压后的 `MathNotesPWA` 绝对路径。SidecarConfiguration 已支持此覆盖；只在开发启动参数中设置，不修改主机代理、DNS、防火墙或网络服务。

备用的手工替换方案只能在新构建的 App 副本中执行：将整个 `MathNotesPWA` 目录替换到 `Contents/Resources/MathNotesPWA`，随后通过该副本原有的签名/打包流程重签并验证。不要修改用户当前安装的 App、不要只覆盖某一个 JS 文件，也不要把手工替换当作长期源码集成。

## Mac 上的最终验收

- App 本体与本机连接服务正常启动，原来的 Mac 连接错误没有被本包宣称修复。
- 从 Mac Companion 地址打开手机网页，确认新静态文件生效；若浏览器仍显示旧版本，先重新加载，再检查 Service Worker 更新和当前服务的静态根目录，不清空笔记/配对数据。
- 阅读 Notebook 中文标题和数学内容；拍照或相册导入后拖动四角，最终上传内容和绿色框一致。
- 打开画笔菜单的白色矩形遮盖，确认提交前已合成不透明白色；撤销、旋转和透视后遮盖仍在预期位置，旧黑色素材仍正确显示。
- 点开已上传队列素材，核对完整成品；已确认识别完成时跳到笔记中实际图片处。对已删除目标、错误 SHA、错误 Session，必须明确提示，不能假装跳到了顶部。
- 点击左上角小目录按钮，弹出可内部滚动的圆角气泡；展开不挤动正文，选中标题后跳转并关闭。轻点正文隐藏/恢复底栏；滚动、选字、图片、目录操作不应误触底栏。
- 先用合成测试图片/测试笔记验证；不要用生产笔记或真实模型调用替代自动化检查。
- 源码重建的 hash 可能受 Node/npm/操作系统差异影响。以本包的 SHA 清单核验预构建目录；重建版本应记录自己的构建版本并执行功能验收，不能直接声称逐字节相同。

公开仓库为 `theincrediblewwz/MathNotes-OpenSource`。历史 Mac 接手分支是 `codex/macos-local-debug-handoff-20260907`；该分支可能已有你的后续修改。本 PWA 包通过独立分支/附件交付，不要求你回到历史提交。
