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

此版设置页直接显示 PWA package.json 的真实版本；用随包清单同时核对源码提交。本次有自由裁剪、边缘留白、笔/箭头、套索、透视、上传前纯黑遮盖，以及点击整张照片放大/关闭等更新。

图片能力的范围：本包显示并放大宿主已经提供的标准 Markdown 图片。AI 自动插入新的 `source-image` 标记属于宿主 Core 识别服务／Android 独立识别的改动；本包不包含 Core，单独更换 PWA 不会更新 Mac 的识别服务。若 Mac 也要该自动识别行为，需要另外审阅和合并相应 Core 改动，保留你正在修复的 Core 代码。

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
- 在照片文字上使用马赛克，确认提交前已合成纯黑；撤销、旋转和透视后遮盖仍在预期位置。
- 先用合成测试图片/测试笔记验证；不要用生产笔记或真实模型调用替代自动化检查。
- 源码重建的 hash 可能受 Node/npm/操作系统差异影响。以本包的 SHA 清单核验预构建目录；重建版本应记录自己的构建版本并执行功能验收，不能直接声称逐字节相同。

公开仓库为 `theincrediblewwz/MathNotes-OpenSource`。历史 Mac 接手分支是 `codex/macos-local-debug-handoff-20260907`；该分支可能已有你的后续修改。本 PWA 包通过独立分支/附件交付，不要求你回到历史提交。
