# MathNotes PWA 手机伴侣

这个目录是 MathNotes Core 的同源静态前端，不是可双击打开的独立网页。

## 部署

1. 将 `site` 目录完整复制到运行 MathNotes Headless Network Node 的电脑。
2. 在 headless v2 配置中把 `pwaStaticRootDir` 指向 `site` 的绝对路径。
3. 先在本机 loopback 验证，再按部署文档由用户配置 Tailscale Serve HTTPS。
4. 在 iPhone 或 iPad 的 Safari 中打开该 HTTPS 地址，完成配对后可添加到主屏幕。

默认由 Core 同源提供静态文件和 API。跨地址连接只使用现有的已配对 Companion 接口与允许的来源配置；本说明不要求修改代理、DNS、防火墙或主机网络服务。

## 当前能力

- 浏览 Notebook / Session 目录。
- 读取 Core 生成的数学 Markdown、公式和图片。
- 正文优先同步，图片最多并发下载 3 个。
- IndexedDB 离线缓存，断网后可重开最近笔记。
- 通过认证 SSE 接收目录与 Session 更新，并在页面恢复时主动对账。

- 使用手机提供的相机入口拍摄，或从相册选择图片；相机具体功能由手机和浏览器决定。
- 连续采集、拍后编辑、上传队列、进度与重试；也可向支持该能力的电脑导入 PDF。
- 拍后编辑支持旋转、自由矩形裁剪、套索、透视、画笔、箭头和马赛克；马赛克区域在上传前合成为不透明纯黑。
- 正文阅读仍遵守电脑主机的权限和锁定规则；本包不会直接修改电脑笔记，也不包含 Mac 主程序、Core 服务或模型凭据。

## 独立 PWA 更新包

`test_tool/package_pwa_update.mjs` 生成单独的 PWA 更新 ZIP，包含可直接集成的 `MathNotesPWA/` 静态目录、仅 `apps/pwa` 的源码快照与补丁、依赖锁定参考、逐文件 SHA-256 清单以及公开集成说明。

Mac 原生打包程序每次会先构建 `apps/pwa`，再复制到 `.app/Contents/Resources/MathNotesPWA`。应先在 目标开发分支整合源码，再执行原有打包流程；只替换已生成 `.app` 内的静态文件会在下次构建时被旧源码覆盖，也会使原有签名失效。详见随包的 `INTEGRATION.md`。

本包只负责显示／放大宿主已提供的标准 Markdown 图片，不包含自动生成 `source-image` 标记的 Core 识别服务改动。更新 PWA 不等同于更新 Mac 识别服务；需要该能力时另行合并宿主对应改动。

## 安全边界

- 配对凭据只进入 IndexedDB，不进入 URL、localStorage、Cache Storage 或 Service Worker。
- Service Worker 只缓存应用壳，不缓存 `/api/`、正文响应、素材响应或 SSE。
- 笔记 HTML 在无脚本、无同源权限的 iframe 沙箱中显示。
- `artifact-manifest.json` 列出交付文件的大小和 SHA-256，可用于搬运后核验。
