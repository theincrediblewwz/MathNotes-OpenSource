# MathNotes PWA 只读伴侣

这个目录是 MathNotes Core 的同源静态前端，不是可双击打开的独立网页。

## 部署

1. 将 `site` 目录完整复制到运行 MathNotes Headless Network Node 的电脑。
2. 在 headless v2 配置中把 `pwaStaticRootDir` 指向 `site` 的绝对路径。
3. 先在本机 loopback 验证，再按部署文档由用户配置 Tailscale Serve HTTPS。
4. 在 iPhone 或 iPad 的 Safari 中打开该 HTTPS 地址，完成配对后可添加到主屏幕。

PWA 与 Core API 必须保持同源。不要把静态目录放到另一个 Web 服务器，也不要公开暴露 Core 端口。

## 当前能力

- 浏览 Notebook / Session 目录。
- 读取 Core 生成的数学 Markdown、公式和图片。
- 正文优先同步，图片最多并发下载 3 个。
- IndexedDB 离线缓存，断网后可重开最近笔记。
- 通过认证 SSE 接收目录与 Session 更新，并在页面恢复时主动对账。

当前版本只读，不包含拍照、上传、编辑、PDF 阅读或 Provider 配置。

## 安全边界

- 配对凭据只进入 IndexedDB，不进入 URL、localStorage、Cache Storage 或 Service Worker。
- Service Worker 只缓存应用壳，不缓存 `/api/`、正文响应、素材响应或 SSE。
- 笔记 HTML 在无脚本、无同源权限的 iframe 沙箱中显示。
- `artifact-manifest.json` 列出交付文件的大小和 SHA-256，可用于搬运后核验。
