# Security Policy

## 当前支持范围

MathNotes 处于公开 alpha。请使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告入口；不要在公开 Issue 中粘贴 API key、配对 token、私人照片、签名材料或未脱敏日志。

## 报告内容

请提供版本号、操作系统、复现步骤、预期与实际结果。截图和日志应先删除密钥、token、私人素材、用户名及绝对路径。

## 发布前关卡

公开二进制 Release 前仍必须完成：

- 执行秘密扫描、依赖审计和 SBOM 生成；
- Android 使用维护者自有 release key；Windows/macOS 若无平台签名则必须显著警告用户；
- 验证配对 token 轮换、接收服务认证和备份排除秘密的行为。

源码开放门禁与二进制发布门禁分开。未签名不会阻止源码公开，但不得把未签名包描述为无警告的正式安装包。
