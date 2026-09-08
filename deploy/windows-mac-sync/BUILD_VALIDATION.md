# Windows Mac 同步测试版构建验证

- 构建源码：`6aa87aeb8beb54d004091628a9d693e1eef6c720`，构建时工作树干净。后续文档与测试提交不改程序。
- Windows 设置：`0.3.4 · Mac 同步测试版 · 6aa87aeb8beb`。
- ZIP：`MathNotes-Windows-x64-0.3.4-mac-sync-6aa87aeb8beb.zip`。
- SHA-256：`a6e03a324133645b4a830611962b5fdaaa28a1b2cebd1af7ed3dd908c183e99b`。
- 独立测试发行：`windows-mac-sync-20260908`。应用构建来源和校验和适用于上述 Windows ZIP。

| 验证 | 结果 |
| --- | --- |
| Windows 单元 | 89文件、612项通过 |
| Core 单元 | 42文件、274项通过，含真实HTTP权限/超限/重启幂等和Windows占用文件恢复 |
| PWA / Shared / Sync Contract | 83 / 27 / 18项通过 |
| Windows / PWA 编译 | 通过；保留Vite大chunk提示，未修改警告阈值 |
| 原生综合回归 | 编辑、AI提案/锁、图片/PDF、导出、关闭保护及连接重启通过；模型使用受控替身，不含付费调用 |
| 新增同步原生回归 | 无草稿刷新、有草稿拒绝旧保存、查看主机版本、取消/确认重载、连续公式/表格、6块身份、导出、幂等重试和423锁拒绝通过 |
| 便携ZIP | 实际解压，再从解压后的MathNotes.exe执行启动及完整同步回归，通过 |
| 成品完整界面回归 | 给独立合成库测试进程显式设置MATHNOTES_ALLOW_MOCK_PROVIDER=1，直接运行解压后的EXE验证完整界面；正式启动不启用该测试开关 |
| 设置版本 | 自动核对构建编号6aa87aeb8beb并保存截图，通过 |
| 窄窗口分隔线 | 1024×720下拖宽和拖窄，禁止触发块标题的原生dragstart，通过 |
| 公开源码门禁 | 依赖清单生成后检查READY；源码导出另作秘钥/私有路径扫描 |

Windows单元以一个fork worker运行，其他workspace以一个thread worker运行。此前聚合执行的IPC/原生进程异常未计作通过，各独立命令最终退出0。云端验证还暴露并修正了大Buffer比较性能、后台测试夹具基线、虚拟列表计数，以及窄窗口下分隔线与块标题争夺原生拖拽的真实问题。保留原断言和必需检查；GitHub还会执行正常Windows、Android和dependency-review检查。

便携包含许可证、依赖清单及构建清单。Windows包未提供代码签名。请完整解压目录再运行EXE，并先用测试笔记联调。

尚未宣称完成：真实Mac跨机、Safari/手机厂商策略验收；远程Notebook/Session新建、改名、移动和废纸篓协议；Mac客户端outbox/UI适配。范围和逐项操作见[接口与验收说明](WINDOWS_MAC_SYNC_RESULT.md)。
