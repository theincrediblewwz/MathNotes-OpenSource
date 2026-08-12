# Contributing

项目采用 `GPL-3.0-only`，欢迎 Issue 与 Pull Request。提交代码即表示你有权贡献这些内容，并同意贡献按本项目许可证发布。

1. 先阅读 `README.md`，理解本地优先、block model、忠实转写与锁定保护边界。
2. 重大方案先调研官方文档与成熟实现，再明确范围、风险和验收。
3. 使用独立分支，避免夹带无关改动。
4. block model、忠实转写、锁定保护和 Android/Windows 职责边界不得擅自改变。
5. 新功能和 bug 修复必须有自动化证据；真实 Provider 调用必须由用户明确批准。
6. 提交前运行与改动范围相匹配的单元测试、构建和 smoke；发布相关改动还要运行发布门。

```powershell
npm run test:unit
npm run build:windows
npm run test:electron-smoke
npm run test:ci-config
npm run test:release-readiness
npm run test:public-source-gate
```

不要提交 `.env`、API key、配对 token、私人笔记、用户照片、签名文件或本地运行目录。
