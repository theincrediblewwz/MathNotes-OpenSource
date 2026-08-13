# Third-party notices

MathNotes 自有源码按 `GPL-3.0-only` 发布。npm、Gradle、Swift Package Manager 与 Electron 打包引入的第三方组件仍分别受其原许可证约束；依赖的精确版本由 `package-lock.json`、Gradle version catalog/lock inputs 与 Swift package metadata 决定。

发布维护者必须在候选提交上运行：

```powershell
npm ci
npm run release:metadata
```

该命令生成 Windows/npm 与 Android CycloneDX SBOM。SBOM 是每个发布候选的构建产物，不替代第三方组件自己的 LICENSE/NOTICE 文件。

已知关键组件包括 React、Vite、Electron、KaTeX、CodeMirror、PDF.js、Room、WorkManager、CameraX、OkHttp 与 Cloudflare Workers runtime。打包脚本不得删除随依赖分发且法律要求保留的许可文件。

## CodeMirror 6

MathNotes 的 Windows Markdown 编辑区使用 [CodeMirror 6](https://github.com/codemirror) 及其 `codemirror`、`@codemirror/view`、`@codemirror/state`、`@codemirror/lang-markdown` 等模块。精确版本以当前 `package-lock.json` 和发布 SBOM 为准。这些 CodeMirror 模块依据 MIT License 分发；以下版权与许可声明随 MathNotes 源码和二进制发行包一同保留。

```text
MIT License

Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

`test_tool/corpus` 中可选的 PyMuPDF 研究 spike 使用 AGPL/commercial 双许可。PyMuPDF、其虚拟环境和研究 corpus 不属于 MathNotes 产品运行时，也不得进入公开应用二进制或源码快照中的第三方捆绑包。
