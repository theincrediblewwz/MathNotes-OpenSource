# Third-party notices

MathNotes 自有源码按 `GPL-3.0-only` 发布。npm、Gradle、Swift Package Manager 与 Electron 打包引入的第三方组件仍分别受其原许可证约束；依赖的精确版本由 `package-lock.json`、Gradle version catalog/lock inputs 与 Swift package metadata 决定。

发布维护者必须在候选提交上运行：

```powershell
npm ci
npm run release:metadata
```

该命令生成 Windows/npm 与 Android CycloneDX SBOM。SBOM 是每个发布候选的构建产物，不替代第三方组件自己的 LICENSE/NOTICE 文件。

已知关键组件包括 React、Vite、Electron、KaTeX、CodeMirror、PDF.js、Room、WorkManager、CameraX、OkHttp 与 Cloudflare Workers runtime。打包脚本不得删除随依赖分发且法律要求保留的许可文件。

`test_tool/corpus` 中可选的 PyMuPDF 研究 spike 使用 AGPL/commercial 双许可。PyMuPDF、其虚拟环境和研究 corpus 不属于 MathNotes 产品运行时，也不得进入公开应用二进制或源码快照中的第三方捆绑包。
