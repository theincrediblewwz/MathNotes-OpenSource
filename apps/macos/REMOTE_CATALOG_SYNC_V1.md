# 远程目录同步 v1：服务端合同与客户端待办

2026-09-08。这是对现有 v3 Session 内容同步的附加接口。服务端、Core 副本持久目录队列、Mac sidecar 与原生创建/管理/冲突入口已实现，原生 HTTP 链路已验证；本机隔离界面验收已完成；Windows PR #39 已接入。真实 Mac ↔ Windows 跨机验收延期，当前不作为已验收功能宣传。

## 接入方式

`WorkspaceCatalogSyncService(rootDir, stateDir, sessionWrites)` 的 stateDir 必须与 WorkspaceSyncService 相同，以复用素材上传暂存区。sessionWrites 必须覆盖该库所有正文、AI、识别和目录写入；不新建互不相干的队列。

将实例传入 `NetworkApiServerOptions.workspaceCatalog`。NetworkApiServer 启动前先恢复有提交证据的目录操作，然后才接受请求。Mac sidecar 与 headless 主机已接入。Windows 接入时继续复用新版 BlockStore.getWriteCoordinator，并确保 runWorkspace 真正协调整个根目录的写入；目前本 Mac 任务没有修改 Windows 应用源码。

仅现有 trusted-host 可调用，沿用 `workspace.sync` capability。旧身份/目录/正文接口保持兼容。GET identity 额外返回 `capabilities: ["catalog-operations-v1"]`；未安装目录服务时该能力不出现，目录接口返回 503 `workspace_catalog_unavailable`。

## 请求与结果

GET `/api/v3/workspace/catalog-state` 返回：

```ts
type CatalogTarget = { notebookId: string; sessionId?: string };
type CatalogTargetState = CatalogTarget & {
  revision: string;
  title: string;
  metadata: Record<string, unknown>;
  snapshot?: ReplicaSnapshot; // Session 对象使用现有完整快照
  sessions?: { sessionId: string; title: string; revision: string }[];
};
type CatalogState = {
  version: 1;
  notebooks: CatalogTargetState[];
  trash: (CatalogTarget & {
    id: string; title: string; deletedAt: string; revision: string;
  })[];
};
```

Notebook 的 revision 是 SHA-256(JSON.stringify([metadata, sessions.map(s => [s.sessionId,s.revision])]))；sessions 按 ID 排序。它包括每个 Session 的完整快照版本，因此删除 Notebook 也能发现其中新添或被修改的 Session。Session 使用现有 replicaRevision。客户端只需原样保存并送回这些版本，不自行根据时间戳推断版本。

POST `/api/v3/workspace/catalog-operation`，JSON 上限 32 MiB：

```ts
type CatalogOperation = CatalogTarget & {
  operationId: string; // UUID，同一请求重试原样复用
  action: "create_notebook" | "create_session" | "rename" | "trash" | "restore";
  baseRevision: string | null;
  title?: string;
  snapshot?: ReplicaSnapshot;
  deletionId?: string;
};
type CatalogOperationResult = {
  version: 1;
  operationId: string;
  target: CatalogTargetState;
  deletionId?: string;
};
```

| action | 所需信息 | 前置检查 |
| --- | --- | --- |
| create_notebook | notebookId、title、baseRevision:null | 目标 ID 不存在 |
| create_session | notebookId、sessionId、完整 snapshot、baseRevision:null | Notebook 存在，Session ID 不存在；素材先使用同一 operationId 上传暂存 |
| rename | 目标 ID、title、baseRevision | 当前目标版本匹配，保留 ID 和正文/锁 |
| trash | 目标 ID、baseRevision | 当前目标完整版本匹配；移动整个目录，不永久删除 |
| restore | 原目标 ID、deletionId、废纸篓中的 baseRevision | 待恢复内容版本匹配，原路径空闲，父目录存在 |

trash 返回的 target 是删除前状态，deletionId 等于该操作 UUID。restore 返回恢复后的版本；元数据中的更新时间/操作账本可能变化，不应假设恢复后 revision 与删除前相同。

## 重试、并发与恢复

- 请求先持久化，再提交目录操作，最后持久化结果。相同 operationId 与相同请求返回第一次操作的结果快照；相同 ID 换请求返回 409 `operation_reused`。
- 重试结果是该操作提交时的结果，可能不是主机此刻的最新版本。客户端处理结果后应继续常规拉取与版本比较，不能把较早的结果当作强制覆盖授权。
- 所有版本检查和目录提交在共享全库写入屏障内完成。过期返回 409 `revision_conflict`；创建撞名为 `workspace_conflict`，恢复撞名为 `restore_conflict`。
- 新建目录在笔记盘内暂存，准备完整后同卷 rename 发布。Session 素材 hash/字节数和生成快照再次校验，不能发布缺素材的半份笔记。
- 目录移动到 `.mathnotes-trash/<operationId>/payload`，与现有本机废纸篓兼容。提交尚未完成的恢复凭据暂不显示；主机重启会识别已完成的移动并补齐记录。
- metadata 中的 remoteCatalogOperations 是提交证据，普通内容 push 保留主机的这份账本，不接受客户端删除或替换它。全局结果保存在主机 stateDir/catalog-operations。
- 代码验证了目录/文件路径以及符号链接边界。错误不回传主机绝对路径或凭据。
- 操作成功发布现有目录事件；Session 操作还发布相应正文变化/删除事件。

## 客户端已实现与待办

1. **Core 已实现**：按主机保存 `catalog-outbox/<UUID>.json`，先写操作意图，再执行可恢复的本地变更；重启补齐中断的本地操作。错误标题/不存在父目录等输入在写意图前拒绝。
2. **Core 已实现**：保存实际采用的目录基线。先同步操作前尚未上传的正文修改，再发送依赖它的重命名/删除；已移入本地废纸篓的素材从持久 hash 缓存上传。未下载成功或有正文冲突的较新版本不自动成为删除基线。
3. **Core 已实现**：创建使用稳定 ID，新建 Session 的初始快照与后续离线编辑分开记录，较早创建结果不覆盖后来的本地编辑。离线创建、改名、删除、恢复可按顺序重放。
4. **Core 已实现**：普通拉取跳过有待处理操作的整个 Notebook；操作前后都检查写入屏障内的待办，避免 HTTP 读取期间新增删除意图后仍重装目录。独立拉取也保留空 Notebook 并更新干净副本中的主机名称。
5. **已接入**：目录冲突停止该 Notebook 后续操作，其他 Notebook 可继续同步。Mac 同步页列出冲突、操作前正文和当时主机目标名称；选择“备份本地并采用主机版本”后，先将整个本地 Notebook、该 Notebook 的废纸篓内容和同步记录保存到 `.mathnotes-replica-backups/<操作 UUID>`，再取消其全部待办并重新拉取主机。已在主机提交的动作不撤回；恢复记录可从 Finder 打开。目录移动和处理意图支持进程重启恢复，相同解决请求重试不处理后来新下载的笔记。
6. **已接入并完成本机隔离界面验收**：macosSidecar 的副本 createNotebook/createSession/manageWorkspace 使用 outbox；本机库保留原回调。Mac 远程浏览器按 capability 显示创建/右键/废纸篓入口，创建使用当前 workspaceSupervisor；同步状态加入目录待办。原生 Swift → 本地 HTTP → 两个隔离 Core 的创建后编辑、改名、删除恢复、冲突备份及主机版本拉取链路已通过。

目录队列状态是附加字段：`catalogManagementAvailable` 表示主机支持目录协议，`catalogOperations` 列出操作 ID、动作、Notebook/Session ID、标题、pending/conflict 状态与错误码。旧主机仍可使用原有内容同步，创建目录返回 `host_catalog_upgrade_required`。

本地 `GET /local/v1/replica/conflicts` 附加 `catalogConflicts`；`POST /local/v1/replica/resolve` 支持 `{catalogOperationId,choice:"remote"}`，返回 `{notebookId,backupRelativePath}`。只使用既有本地管理权限；凭据不写入解决记录。备份包含 `recovery.json`、可选的 `notebook/`、`trash/` 与 `sync-state/`，不会永久删除笔记。当前没有强制覆盖主机目录的解决选项，用户可采用主机版本后重新执行需要的目录动作。

另修复正文重试边界：旧 push 的幂等结果可能是主机随后修改过的当前快照。副本先比较正文、块顺序、锁与素材等语义内容，仅忽略服务端时间戳、Markdown 存储路径和操作账本；内容不同则保留冲突，不能用这个结果把后续本地草稿静默迁移到较新的主机基线上。

## 已有证据

`workspaceCatalogSyncService.test.ts` 覆盖空 Notebook、含照片的 Session 创建、持久重试、操作 ID 复用拒绝、Notebook 子项变化后的过期删除拒绝、固定块随目录删除/恢复、恢复撞名保留两份、提交后日志恢复、恢复移动中断、全库屏障、路径/符号链接拒绝及 HTTP 认证。其余 Core 回归与 sidecar 启动验证记录在实施计划中。

`replicaCatalogSync.test.ts` 的 9 项回归覆盖空目录与主机改名、离线创建后继续编辑、连续创建/改名/删除/恢复、删除前正文与照片上传、过期删除保留两端、丢回复重启重试、本地移动后意图恢复、非法输入及旧主机兼容、未展示的主机改名不能授权删除。`macosSidecar.test.ts` 另用两个独立 sidecar 实测本地 HTTP 创建/管理 → 持久队列 → 主机目录接口的完整调用链。UI 验收不以这组 HTTP 测试代替。
