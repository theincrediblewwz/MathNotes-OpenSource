# Windows 后续：带资源分享包导入

Mac 0.3.6 已支持导入 Windows 导出的分享目录，也可导出 ZIP；解压格式仍是根目录 `<sessionId>.md` 和 `assets/...`。资源 URL 使用已有 `encodeMarkdownAssetPath`，不要再次解码文件名。分享包只迁移合并正文及资源，不迁移锁定、块 ID、AI 历史或凭据。

Windows 当前 `src/core/exporter.ts` 调用的共享导出器可以继续沿用。后续在 Windows Codex 中完成：

1. 拉取包含 Mac 0.3.6 的 main，保留 Windows 正在开发的工作；不修改 Mac 或 Android 界面。
2. 在 Windows 文件选择/拖入入口添加分享目录、ZIP、Markdown + assets 导入。复用 `packages/core-server/src/session/sessionSharePackageService.ts` 的 `importPackage`，传入本地 root 和已有同一份 `SessionWriteCoordinator`，不要另外实例化写入屏障。
3. 通过可信 IPC 接收系统选择的路径，在主进程校验。目标 Notebook 可选；导入创建新 Session，不覆盖已有笔记。未保存草稿要保留。
4. 导入完成刷新目录并单击可打开，验证 Markdown 公式和图片实际渲染。错误展示清晰，不留下半份 Session。
5. 用 Windows 原生构建验证 Mac ZIP、Windows 自己导出的目录、带中文/空格/#/%/括号的资源、重复导入、缺图、损坏 ZIP。Core 已有往返与路径安全测试，但不能代替 Windows GUI 验收。

如果 Windows 也需要“一键 ZIP 导出”，可复用 `exportZip`；现有目录分享导出仍保留。只在 Windows 本机编译和实际验证通过后更新双端互通的验收结论。
