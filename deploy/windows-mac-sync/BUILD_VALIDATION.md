# Windows Mac 同步测试版构建验证

- 构建源码：`de9036c082f216e3b5452bd2a2db0812c1155542`，构建时工作树干净。后续文档提交不改程序。
- Windows 设置：`0.3.4 · Mac 同步测试版 · de9036c082f2`。
- ZIP：`MathNotes-Windows-x64-0.3.4-mac-sync-de9036c082f2.zip`。
- SHA-256：`15c132b853143c2d2ff8930004e0203c4e09ee2fd4f407184429b3e23449abd4`。
- 独立测试发行：`windows-mac-sync-20260908`。此前正式 Latest `v0.3.4` 的9个附件及原标签保持不变。

| 验证 | 结果 |
| --- | --- |
| Windows 单元 | 89文件、612项通过 |
| Core 单元 | 42文件、274项通过，含真实HTTP权限/超限/重启幂等和Windows占用文件恢复 |
| PWA / Shared / Sync Contract | 83 / 27 / 18项通过 |
| Windows / PWA 编译 | 通过；保留Vite大chunk提示，未修改警告阈值 |
| 原生综合回归 | 编辑、AI提案/锁、图片/PDF、导出、关闭保护及连接重启通过；模型使用受控替身，不含付费调用 |
| 新增同步原生回归 | 无草稿刷新、有草稿拒绝旧保存、查看主机版本、取消/确认重载、连续公式/表格、6块身份、导出、幂等重试和423锁拒绝通过 |
| 便携ZIP | 实际解压，再从解压后的MathNotes.exe执行启动及完整同步回归，通过 |
| 设置版本 | 自动核对构建编号de9036c082f2并保存截图，通过 |
| 公开源码门禁 | 依赖清单生成后检查READY；源码导出另作秘钥/私有路径扫描 |

Windows单元以一个fork worker运行，其他workspace以一个thread worker运行。此前聚合执行的IPC/原生进程异常未计作通过，各独立命令最终退出0。GitHub还会执行正常Windows、Android和dependency-review必需检查。

便携包含许可证、依赖清单及构建清单。Windows包未提供代码签名。请完整解压目录再运行EXE，并先用测试笔记联调。

尚未宣称完成：真实Mac跨机、Safari/手机厂商策略验收；远程Notebook/Session新建、改名、移动和废纸篓协议；Mac客户端outbox/UI适配。范围和逐项操作见[结果与接手说明](WINDOWS_MAC_SYNC_RESULT.md)。
