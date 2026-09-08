import Foundation

struct SidecarReadyMessage: Codable, Equatable, Sendable {
    let type: String
    let apiVersion: Int
    let instanceId: String
    let host: String
    let port: Int
    let companionHost: SidecarCompanionHost?

    init(
        type: String,
        apiVersion: Int,
        instanceId: String,
        host: String,
        port: Int,
        companionHost: SidecarCompanionHost? = nil
    ) {
        self.type = type
        self.apiVersion = apiVersion
        self.instanceId = instanceId
        self.host = host
        self.port = port
        self.companionHost = companionHost
    }

    var endpoint: URL? {
        URL(string: "http://\(host):\(port)")
    }

    func validate() throws {
        guard type == "mathnotes.ready" else { throw SidecarProtocolError.invalidMessageType }
        guard apiVersion == 1 else { throw SidecarProtocolError.unsupportedAPIVersion(apiVersion) }
        guard host == "127.0.0.1", (1...65_535).contains(port), endpoint != nil else {
            throw SidecarProtocolError.nonLoopbackEndpoint
        }
        guard !instanceId.isEmpty else { throw SidecarProtocolError.missingInstanceId }
        if let companionHost {
            guard companionHost.host == "0.0.0.0",
                  (1...65_535).contains(companionHost.port),
                  let endpoint = companionHost.endpoint,
                  endpoint.scheme == "http",
                  endpoint.host == "127.0.0.1",
                  endpoint.port == companionHost.port,
                  endpoint.path.isEmpty || endpoint.path == "/" else {
                throw SidecarProtocolError.invalidCompanionHost
            }
        }
    }
}

struct SidecarCompanionHost: Codable, Equatable, Sendable {
    let host: String
    let port: Int
    let url: String

    var endpoint: URL? { URL(string: url) }
}

struct CompanionPairingChallenge: Decodable, Equatable, Sendable {
    let challengeId: String
    let userCode: String
    let expiresAt: String
    let remainingAttempts: Int

    var pairingLink: String {
        var components = URLComponents()
        components.scheme = "mathnotes"
        components.host = "pair"
        components.queryItems = [
            URLQueryItem(name: "challenge", value: challengeId),
            URLQueryItem(name: "code", value: userCode),
            URLQueryItem(name: "expires", value: expiresAt)
        ]
        return components.string ?? userCode
    }
}

enum SidecarProtocolError: LocalizedError, Equatable {
    case invalidMessageType
    case unsupportedAPIVersion(Int)
    case nonLoopbackEndpoint
    case missingInstanceId
    case invalidCompanionHost
    case invalidReadyJSON
    case healthRejected(Int)
    case catalogRejected(Int)
    case sessionRejected(Int)
    case saveRejected(Int, String, String?)
    case organizeRejected(Int, String)
    case imageImportRejected(Int, String)
    case imageEditRejected(Int, String)
    case pdfImportRejected(Int, String)
    case pdfRecognitionRejected(Int, String)
    case recognitionRejected(Int, String)
    case assistantRejected(Int, String)
    case selectionEditRejected(Int, String)
    case exportRejected(Int, String)
    case providerRejected(Int, String, ProviderPurpose)
    case assetRejected(Int)
    case unhealthyResponse

    var errorDescription: String? {
        return switch self {
        case .invalidMessageType: "Sidecar 返回了未知的启动消息。"
        case let .unsupportedAPIVersion(version): "Sidecar API 版本不兼容：\(version)。"
        case .nonLoopbackEndpoint: "Sidecar 只能通过本机回环地址连接。"
        case .missingInstanceId: "Sidecar 缺少实例标识。"
        case .invalidCompanionHost: "本机设备连接服务返回了无效地址。"
        case .invalidReadyJSON: "本机连接服务未能正确启动，请重试。"
        case let .healthRejected(status): "Sidecar 健康检查失败（HTTP \(status)）。"
        case let .catalogRejected(status): "读取笔记目录失败（HTTP \(status)）。"
        case let .sessionRejected(status): "读取 Session 正文失败（HTTP \(status)）。"
        case let .saveRejected(status, code, conflictId):
            switch code {
            case "revision_conflict": conflictId == nil
                ? "这段内容已在别处发生变化。草稿仍保留在编辑器中。"
                : "这段内容已在别处发生变化。草稿已安全保存为冲突副本。"
            case "block_locked": "这段内容已被锁定，不能直接保存。"
            case "invalid_selection": "选区边界无效，请重新选择要固定的文字。"
            case "selection_stale": "选中的文字已经发生变化，请重新选择。"
            case "protected_selection": "这段文字已经属于固定内容，不能重复固定。"
            case "protected_span_missing": "当前选区不在可解除的固定内容中，请重新选择。"
            case "protected_span_changed": "固定内容与安全记录不一致，Core 已拒绝更改。"
            case "invalid_protected_span": "固定内容的安全记录无效，Core 已拒绝更改。"
            default: "保存失败（HTTP \(status)，\(code)）。草稿仍保留在编辑器中。"
            }
        case let .organizeRejected(status, code):
            switch code {
            case "same_session": "请选择另一个 Session。"
            case "block_not_found": "有内容段已发生变化，请刷新后重新选择。"
            case "block_locked": "所选内容段中有已固定的块，不能移动或重排。"
            case "revision_conflict": "笔记已经发生变化，请刷新后再重试。"
            case "undo_not_found": "这次删除已经无法撤销。"
            case "undo_conflict": "删除后笔记又发生了变化，无法安全恢复原位置。"
            case "session_not_found": "目标 Session 已不存在，请刷新目录后重试。"
            case "source_cleanup_pending": "内容已复制到目标，但源 Session 尚未清理完成。"
            default: "整理内容段失败（HTTP \(status)，\(code)）。"
            }
        case let .imageImportRejected(status, code):
            switch code {
            case "revision_conflict": "Session 已在别处变化，请重新载入后再导入图片。"
            case "image_too_large", "request_body_too_large": "图片超过 25 MiB，请压缩后再试。"
            case "unsupported_image": "请选择 PNG、JPEG 或 WebP 图片。"
            default: "导入图片失败（HTTP \(status)，\(code)）。"
            }
        case let .imageEditRejected(status, code):
            switch code {
            case "revision_conflict": "笔记在图片编辑期间发生了变化；原图和笔记都没有被改动，请重新打开后再试。"
            case "image_too_large", "request_body_too_large": "原图或编辑后的图片超过 25 MiB，请缩小图片后再试。"
            case "unsupported_image": "请选择 PNG、JPEG 或 WebP 图片。"
            case "invalid_image_edit", "invalid_image_edit_metadata", "invalid_image_edit_multipart":
                "这次图片编辑数据无效，笔记没有被改动。"
            case "asset_conflict": "图片素材与已有文件冲突，Core 已停止写入。"
            default: "保存编辑后的图片失败（HTTP \(status)，\(code)）。"
            }
        case let .pdfImportRejected(status, code):
            switch code {
            case "revision_conflict": "Session 已在别处变化，请重新载入后再导入 PDF。"
            case "pdf_too_large", "request_body_too_large": "PDF 超过 100 MiB，请压缩或拆分后再试。"
            case "unsupported_pdf": "请选择有效的 PDF 文件。"
            default: "导入 PDF 失败（HTTP \(status)，\(code)）。"
            }
        case let .pdfRecognitionRejected(status, code):
            switch code {
            case "revision_conflict": "笔记已发生变化，请重新打开 PDF 后再识别。"
            case "provider_unavailable": "尚未配置识别服务；PDF 和笔记没有被修改。"
            case "page_out_of_range", "invalid_pdf_batch", "invalid_pdf_recognition_body": "页码范围无效，请重新选择。"
            case "unsupported_image": "PDF 页面没有成功转换为识别图片，请重试。"
            case "image_too_large", "request_body_too_large": "其中一页过大，无法送入识别。"
            case "batch_not_found": "没有找到这组 PDF 识别任务。"
            case "batch_not_running": "这组 PDF 识别当前没有运行。"
            case "batch_not_resumable": "这组 PDF 识别已经结束，不能继续。"
            default: "PDF 识别没有完成（HTTP \(status)，\(code)）。"
            }
        case let .recognitionRejected(status, code):
            switch code {
            case "provider_unavailable": "当前 Mac 尚未配置识别服务。图片和笔记没有被修改。"
            case "recognition_in_progress": "这张图片已经有识别任务在运行。"
            case "block_locked": "这段内容已固定，请先解除固定再重新识别。"
            case "task_not_found": "没有找到这段识别草稿对应的原始图片任务。"
            case "task_not_retryable": "当前任务不需要重试。"
            case "task_not_cancellable": "当前任务已经结束，无法中断。"
            default: "识别任务失败（HTTP \(status)，\(code)）。"
            }
        case let .assistantRejected(status, code):
            switch code {
            case "assistant_unavailable": "当前 Mac 尚未配置 AI 服务。笔记没有被修改。"
            case "selection_required": "请先在左侧源码区选中一段文字。"
            case "block_not_found": "当前内容段已发生变化，请刷新后重试。"
            case "remark_not_found": "这条学习批注已不存在，请刷新后重试。"
            default: "AI 对话请求失败（HTTP \(status)，\(code)）。"
            }
        case let .selectionEditRejected(status, code):
            switch code {
            case "revision_conflict", "selection_stale": "内容在候选生成后发生了变化；当前笔记未改，候选仍保留。"
            case "block_locked": "这个内容段已固定，AI 不能修改。"
            case "protected_selection": "选区与固定内容重叠，Core 已拒绝修改。"
            case "assistant_unavailable": "当前 Mac 尚未配置 AI 服务；笔记没有被修改。"
            case "proposal_not_pending": "这个修改候选已经应用或取消，不能重复使用。"
            default: "AI 选区修改失败（HTTP \(status)，\(code)）。"
            }
        case let .exportRejected(status, code):
            switch code {
            case "revision_conflict": "Session 已在别处变化，请刷新后再导出。"
            case "export_not_found": "导出文件尚未生成，请重新导出。"
            default: "导出失败（HTTP \(status)，\(code)）。"
            }
        case let .providerRejected(status, code, purpose):
            providerErrorDescription(status: status, code: code, purpose: purpose)
        case let .assetRejected(status): "读取笔记素材失败（HTTP \(status)）。"
        case .unhealthyResponse: "Sidecar 尚未准备好。"
        }
    }
}

struct RuntimeProviderStatus: Codable, Equatable, Sendable {
    let version: Int
    let configured: Bool
    let providerId: String?
    let label: String?
    let model: String?
    let endpoint: String?
    let purpose: String?
    let inherited: Bool?

    static let unconfigured = RuntimeProviderStatus(
        version: 1, configured: false, providerId: nil, label: nil, model: nil, endpoint: nil,
        purpose: nil, inherited: nil
    )
}

private func providerErrorDescription(status: Int, code: String, purpose: ProviderPurpose) -> String {
    let subject = purpose == .recognition ? "识别服务" : "对话模型"
    return switch code {
    case "unsupported_provider": "当前\(subject)尚不受 Mac 版支持。"
    case "invalid_provider_model": "请填写\(subject)的模型名称。"
    case "invalid_provider_endpoint": "\(subject)的请求地址必须是安全的 HTTPS 地址。"
    case "invalid_provider_api_key": "请填写\(subject)的有效 API 密钥。"
    case "provider_settings_unavailable": "核心服务暂未提供\(subject)配置。"
    case "provider_unavailable": "当前 Mac 尚未配置\(subject)。"
    default: "保存\(subject)失败（HTTP \(status)），请稍后重试。"
    }
}

struct ProviderConnectionTestResult: Decodable, Equatable, Sendable {
    let version: Int
    let purpose: String?
    let ok: Bool
    let category: ProviderConnectionTestCategory?
    let message: String
}

enum ProviderConnectionTestCategory: String, Decodable, Equatable, Sendable {
    case authentication
    case endpointModel = "endpoint_model"
    case rateLimit = "rate_limit"
    case timeout
    case providerResponse = "provider_response"

    var localizedDescription: String {
        switch self {
        case .authentication: "Provider 拒绝了请求：认证失败，请检查 API 密钥。"
        case .endpointModel: "Provider 无法处理请求：请检查请求地址或模型名称。"
        case .rateLimit: "Provider 请求频率受限，请稍后重试。"
        case .timeout: "连接 Provider 超时，请稍后重试。"
        case .providerResponse: "Provider 返回异常响应，请检查服务状态。"
        }
    }
}

enum SidecarState: Equatable {
    case idle
    case starting
    case ready(instanceId: String, endpoint: String)
    case stopping
    case failed(String)
}

extension SidecarProtocolError {
    var isSelectionEditLockConflict: Bool {
        guard case let .selectionEditRejected(status, code) = self else { return false }
        return status == 423 || [
            "block_locked",
            "protected_selection",
            "protected_span_changed",
            "protected_span_missing"
        ].contains(code)
    }
}

struct SessionCatalogItem: Codable, Equatable, Hashable, Identifiable, Sendable {
    let notebookId: String
    let sessionId: String
    let title: String
    let status: String
    let createdAt: String
    let updatedAt: String

    var id: String { "\(notebookId)/\(sessionId)" }
}

struct NotebookCatalogItem: Codable, Equatable, Hashable, Identifiable, Sendable {
    let notebookId: String
    let title: String
    let sessionCount: Int
    let createdAt: String
    let updatedAt: String
    let sessions: [SessionCatalogItem]

    var id: String { notebookId }
}

struct NotesCatalog: Codable, Equatable, Sendable {
    let notebooks: [NotebookCatalogItem]
}

struct CreatedNotebook: Codable, Equatable, Sendable {
    let notebookId: String
    let title: String
    let sessionCount: Int
    let createdAt: String
    let updatedAt: String
}

struct CreateNotebookResponse: Codable, Equatable, Sendable {
    let version: Int
    let notebook: CreatedNotebook
}

struct CreateSessionResponse: Codable, Equatable, Sendable {
    let version: Int
    let session: SessionCatalogItem
}

struct SessionBlockManifest: Codable, Equatable, Hashable, Identifiable, Sendable {
    var continuationGroup: String? = nil
    let id: String
    let order: Int
    let type: String
    let source: String
    let status: String
    let sourceName: String
    let assetPath: String?
    let sourceAssetPaths: [String]?
    let pageCount: Int?
    let sourcePageNumber: Int?
    let sourcePageImagePath: String?
    let renderInNote: Bool
    let editable: Bool
    let updatedAt: String
}

struct ReadonlySessionManifest: Codable, Equatable, Sendable {
    let version: Int
    let notebookId: String
    let sessionId: String
    let title: String
    let status: String
    let updatedAt: String
    let revision: String
    let blocks: [SessionBlockManifest]
}

struct ReadonlySessionBlock: Codable, Equatable, Sendable {
    let version: Int
    let notebookId: String
    let sessionId: String
    let block: SessionBlockManifest
    let content: ReadonlySessionBlockContent
}

enum ReadonlySessionBlockContent: Codable, Equatable, Sendable {
    case markdown(MarkdownBlockContent)
    case image(assetPath: String, mimeType: String)
    case pdf(assetPath: String, mimeType: String)

    private enum CodingKeys: String, CodingKey {
        case kind, html, markdown, baseRevision, blockLocked, protectedSpanCount, assetPath, mimeType
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "markdown": self = .markdown(MarkdownBlockContent(
            html: try container.decode(String.self, forKey: .html),
            markdown: try container.decode(String.self, forKey: .markdown),
            baseRevision: try container.decode(String.self, forKey: .baseRevision),
            blockLocked: try container.decode(Bool.self, forKey: .blockLocked),
            protectedSpanCount: try container.decode(Int.self, forKey: .protectedSpanCount)
        ))
        case "image": self = .image(
            assetPath: try container.decode(String.self, forKey: .assetPath),
            mimeType: try container.decode(String.self, forKey: .mimeType)
        )
        case "pdf": self = .pdf(
            assetPath: try container.decode(String.self, forKey: .assetPath),
            mimeType: try container.decode(String.self, forKey: .mimeType)
        )
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Unknown block content kind")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .markdown(markdown):
            try container.encode("markdown", forKey: .kind)
            try container.encode(markdown.html, forKey: .html)
            try container.encode(markdown.markdown, forKey: .markdown)
            try container.encode(markdown.baseRevision, forKey: .baseRevision)
            try container.encode(markdown.blockLocked, forKey: .blockLocked)
            try container.encode(markdown.protectedSpanCount, forKey: .protectedSpanCount)
        case let .image(assetPath, mimeType):
            try container.encode("image", forKey: .kind)
            try container.encode(assetPath, forKey: .assetPath)
            try container.encode(mimeType, forKey: .mimeType)
        case let .pdf(assetPath, mimeType):
            try container.encode("pdf", forKey: .kind)
            try container.encode(assetPath, forKey: .assetPath)
            try container.encode(mimeType, forKey: .mimeType)
        }
    }
}

struct MarkdownBlockContent: Codable, Equatable, Sendable {
    let html: String
    let markdown: String
    let baseRevision: String
    let blockLocked: Bool
    let protectedSpanCount: Int
}

struct SaveMarkdownBlockResponse: Codable, Equatable, Sendable {
    let version: Int
    let saved: Bool
    let block: ReadonlySessionBlock
}

struct SelectionEditTextRange: Codable, Equatable, Sendable {
    let from: Int
    let to: Int
    let selectedText: String
}

struct SelectionEditProposal: Codable, Equatable, Identifiable, Sendable {
    let version: Int
    let id: String
    let notebookId: String
    let sessionId: String
    let blockId: String
    let baseRevision: String
    let selection: SelectionEditTextRange
    let instruction: String
    let replacementMarkdown: String
    let providerName: String
    let status: String
    let createdAt: String
    let updatedAt: String
    let appliedAt: String?
}

struct ApplySelectionEditResponse: Codable, Equatable, Sendable {
    let version: Int
    let applied: Bool
    let proposal: SelectionEditProposal
    let result: SaveMarkdownBlockResponse
}

struct SessionMarkdownConflictSummary: Codable, Equatable, Identifiable, Sendable {
    let version: Int
    let id: String
    let blockId: String
    let baseRevision: String
    let currentRevision: String
    let incomingWriterId: String
    let reason: String
    let status: String
    let createdAt: String
    let resolvedAt: String?
}

struct SessionMarkdownConflict: Codable, Equatable, Identifiable, Sendable {
    let version: Int
    let id: String
    let blockId: String
    let baseRevision: String
    let currentRevision: String
    let incomingWriterId: String
    let reason: String
    let status: String
    let createdAt: String
    let resolvedAt: String?
    let currentMarkdown: String
    let incomingMarkdown: String
}

struct ResolveMarkdownConflictResponse: Codable, Equatable, Sendable {
    let version: Int
    let resolved: Bool
    let conflict: SessionMarkdownConflictSummary
    let block: ReadonlySessionBlock
}

struct ImportSessionImageResponse: Codable, Equatable, Sendable {
    let version: Int
    let imported: Bool
    let blockId: String
    let manifest: ReadonlySessionManifest
}

struct SetMarkdownBlockLockResponse: Codable, Equatable, Sendable {
    let version: Int
    let locked: Bool
    let block: ReadonlySessionBlock
}

struct SetMarkdownBlockLockRequest: Codable, Equatable, Sendable {
    let locked: Bool
}

struct ImportSessionEditedImageResponse: Codable, Equatable, Sendable {
    let version: Int
    let imported: Bool
    let edited: Bool
    let blockId: String
    let sourceAssetPath: String
    let assetPath: String
    let metadataPath: String
    let sourceSha256: String
    let outputSha256: String
    let manifest: ReadonlySessionManifest
}

struct UpdateMarkdownProtectedSpanRequest: Codable, Equatable, Sendable {
    let baseRevision: String
    let from: Int
    let to: Int
    let selectedText: String
}

struct UpdateMarkdownProtectedSpanResponse: Codable, Equatable, Sendable {
    let version: Int
    let protected: Bool
    let spanId: String
    let block: ReadonlySessionBlock
}

struct TransferSessionBlocksResponse: Codable, Equatable, Sendable {
    let version: Int
    let mode: String
    let copiedBlockIds: [String]
    let sourceCleanupPending: Bool
}

struct ReorderSessionBlocksResponse: Codable, Equatable, Sendable {
    let version: Int
    let reordered: Bool
    let manifest: ReadonlySessionManifest
}

struct DeleteSessionBlocksResponse: Codable, Equatable, Sendable {
    let version: Int
    let deleted: Bool
    let manifest: ReadonlySessionManifest
    let undo: SessionBlocksUndoReceipt
}

struct SessionBlocksUndoReceipt: Codable, Equatable, Sendable, Identifiable {
    let version: Int
    let deletionId: String
    let deletedBlockIds: [String]
    let deletedAt: String

    var id: String { deletionId }
}

struct RestoreSessionBlocksResponse: Codable, Equatable, Sendable {
    let version: Int
    let restored: Bool
    let manifest: ReadonlySessionManifest
}

struct MarkdownPreviewResponse: Codable, Equatable, Sendable {
    let version: Int
    let html: String
}

struct ImportSessionPdfResponse: Codable, Equatable, Sendable {
    let version: Int
    let imported: Bool
    let blockId: String
    let assetPath: String
    let pageCount: Int
    let manifest: ReadonlySessionManifest
}

struct StagedPdfRecognitionPage: Codable, Equatable, Sendable {
    let version: Int
    let pageNumber: Int
    let assetPath: String
    let byteLength: Int
    let sha256: String
}

struct PdfRecognitionBatch: Codable, Equatable, Identifiable, Sendable {
    let version: Int
    let batchId: String
    let notebookId: String
    let sessionId: String
    let pdfBlockId: String
    let pageCount: Int
    let selectedPages: [Int]
    let taskIds: [String]
    let status: String
    let concurrency: Int
    let running: Int
    let pending: Int
    let succeeded: Int
    let failed: Int
    let cancelled: Int
    let createdAt: String
    let updatedAt: String

    var id: String { batchId }
    var isActive: Bool { status == "running" || status == "pausing" }
    var canPause: Bool { status == "running" }
    var canResume: Bool { status == "paused" && pending > 0 }
    var canCancel: Bool { isActive || canResume }
    var completedPages: Int { succeeded + failed + cancelled }
}

struct SessionMarkdownExport: Codable, Equatable, Sendable {
    let version: Int
    let exported: Bool
    let fileName: String
    let relativeExportPath: String
    let exportedBlocks: Int
    let byteLength: Int
    let sha256: String
}

struct SessionRecognitionTask: Codable, Equatable, Identifiable, Sendable {
    let version: Int
    let id: String
    let notebookId: String
    let sessionId: String
    let imageBlockId: String
    let transcriptBlockId: String
    let status: String
    let attempts: Int
    let providerName: String?
    let error: String?
    let failureKind: String?
    let batchId: String?
    let pageNumber: Int?
    let pageCount: Int?
    let batchConcurrency: Int?
    let warnings: [String]?
    let timing: SessionRecognitionTiming?
    let createdAt: String
    let updatedAt: String

    var isTerminal: Bool { ["succeeded", "failed", "cancelled"].contains(status) }
    var canCancel: Bool { status == "pending" || status == "running" }
    var canRetry: Bool { status == "failed" || status == "cancelled" }
}

struct SessionRecognitionTiming: Codable, Equatable, Sendable {
    let acceptedAt: String
    let providerStartedAt: String?
    let firstOutputAt: String?
    let completedAt: String?
    let firstOutputMs: Int?
    let providerMs: Int?
    let totalMs: Int?
}

struct SessionRecognitionEvent: Codable, Equatable, Identifiable, Sendable {
    let version: Int
    let sequence: Int
    let taskId: String
    let type: String
    let message: String
    let delta: String?
    let task: SessionRecognitionTask

    var id: Int { sequence }
}

struct SessionRecognitionTaskResponse: Codable, Equatable, Sendable {
    let version: Int
    let task: SessionRecognitionTask
}

struct SessionRecognitionTasksResponse: Codable, Equatable, Sendable {
    let version: Int
    let tasks: [SessionRecognitionTask]
    let activitySequence: Int?
}

struct SessionAssistantTask: Codable, Equatable, Identifiable, Sendable {
    let version: Int
    let id: String
    let notebookId: String
    let sessionId: String
    let status: String
    let attempts: Int
    let mode: String
    let providerName: String?
    let error: String?
    let failureKind: String?
    let timing: SessionRecognitionTiming?
    let createdAt: String
    let updatedAt: String

    var isTerminal: Bool { ["succeeded", "failed", "cancelled"].contains(status) }
    var canCancel: Bool { status == "pending" || status == "running" }
}

struct SessionAssistantTaskEvent: Codable, Equatable, Identifiable, Sendable {
    let version: Int
    let sequence: Int
    let taskId: String
    let type: String
    let message: String
    let delta: String?
    let task: SessionAssistantTask

    var id: Int { sequence }
}

struct SessionAssistantTaskResponse: Codable, Equatable, Sendable {
    let version: Int
    let task: SessionAssistantTask
}

struct SessionAssistantEventsResponse: Codable, Equatable, Sendable {
    let version: Int
    let events: [SessionAssistantTaskEvent]
}

struct SessionCompanionUploadActivity: Codable, Equatable, Sendable {
    let version: Int
    let notebookId: String
    let sessionId: String
    let captureId: String?
    let fileName: String?
    let receivedBytes: Int
    let totalBytes: Int?
    let status: String
    let updatedAt: String

    var progress: Double? {
        guard let totalBytes, totalBytes > 0 else { return nil }
        return min(1, max(0, Double(receivedBytes) / Double(totalBytes)))
    }
}

struct SessionCompanionUploadActivityResponse: Codable, Equatable, Sendable {
    let version: Int
    let activity: SessionCompanionUploadActivity?
}

struct SessionRecognitionEventsResponse: Codable, Equatable, Sendable {
    let version: Int
    let events: [SessionRecognitionEvent]
}

struct AssistantContextUsage: Codable, Equatable, Sendable {
    let version: Int
    let textCharacters: Int
    let maximumTextCharacters: Int
    let maximumImageCount: Int
    let sessionBlockCount: Int
    let sessionCharacterCount: Int
    let includedBlockIds: [String]
    let namedBlockOrdinals: [Int]
    let truncated: Bool
    let focusTruncated: Bool
}

struct SessionAssistantFocus: Codable, Equatable, Sendable {
    let kind: String
    let blockId: String?
    let label: String
    let excerpt: String?
}

struct NotesBackupResult: Codable, Equatable, Sendable {
    let backupDir: String
    let manifestPath: String
    let fileCount: Int
    let totalBytes: Int
}

struct SessionAssistantRelatedSource: Codable, Equatable, Identifiable, Sendable {
    let refId: String
    let notebookId: String
    let notebookTitle: String
    let sessionId: String
    let sessionTitle: String
    let blockId: String
    let locked: Bool

    var id: String { "\(refId):\(notebookId)/\(sessionId)/\(blockId)" }
}

struct SessionAssistantPreview: Codable, Equatable, Sendable {
    let version: Int
    let focus: SessionAssistantFocus
    let usage: AssistantContextUsage
    let imageCount: Int
    let sourceBlockIds: [String]
    let relatedSources: [SessionAssistantRelatedSource]?
}

struct SessionAssistantRemark: Codable, Equatable, Identifiable, Sendable {
    let version: Int
    let id: String
    let mode: String
    let focus: SessionAssistantFocus
    let question: String?
    let markdown: String
    let html: String
    let providerName: String
    let sourceBlockIds: [String]
    let relatedSources: [SessionAssistantRelatedSource]?
    let usage: AssistantContextUsage
    let imageCount: Int
    let createdAt: String
    let updatedAt: String
}

struct SessionAssistantRemarksResponse: Codable, Equatable, Sendable {
    let version: Int
    let remarks: [SessionAssistantRemark]
}

struct SessionAssistantRunResponse: Codable, Equatable, Sendable {
    let version: Int
    let remark: SessionAssistantRemark
}

struct SessionAssistantDeleteResponse: Codable, Equatable, Sendable {
    let version: Int
    let deleted: Bool
}

struct SessionAssistantPromoteResponse: Codable, Equatable, Sendable {
    let version: Int
    let promoted: Bool
    let blockId: String
}

enum CatalogState: Equatable {
    case idle
    case loading
    case loaded([NotebookCatalogItem])
    case failed(String)
}

enum CatalogSearch {
    static func filter(_ notebooks: [NotebookCatalogItem], query: String) -> [NotebookCatalogItem] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return notebooks }
        return notebooks.compactMap { notebook in
            if notebook.title.localizedStandardContains(needle) || notebook.notebookId.localizedStandardContains(needle) {
                return notebook
            }
            let sessions = notebook.sessions.filter {
                $0.title.localizedStandardContains(needle) || $0.sessionId.localizedStandardContains(needle)
            }
            guard !sessions.isEmpty else { return nil }
            return NotebookCatalogItem(
                notebookId: notebook.notebookId,
                title: notebook.title,
                sessionCount: sessions.count,
                createdAt: notebook.createdAt,
                updatedAt: notebook.updatedAt,
                sessions: sessions
            )
        }
    }
}

struct WorkspaceManageRequest: Encodable, Sendable {
    let action: String
    let notebookId: String
    let sessionId: String?
    var title: String? = nil
    var deletionId: String? = nil
}

struct WorkspaceTrashEntry: Decodable, Identifiable, Sendable {
    let id: String
    let notebookId: String
    let sessionId: String?
    let title: String
    let deletedAt: String
}
struct WorkspaceTrashResponse: Decodable { let entries: [WorkspaceTrashEntry] }

struct RemoteHostIdentity: Codable, Equatable, Sendable {
    let version: Int
    let hostId: String
    let name: String
}
struct ReplicaSessionStatus: Codable, Equatable, Identifiable, Sendable {
    let notebookId: String
    let sessionId: String
    let title: String
    let status: String
    let error: String?
    var id: String { "\(notebookId)/\(sessionId)" }
}
struct ReplicaSyncResult: Codable, Equatable, Sendable {
    let hostId: String
    let sessions: [ReplicaSessionStatus]
    var catalogOperations: [ReplicaCatalogStatus]? = nil
    var catalogManagementAvailable: Bool? = nil
    var pendingCount: Int { sessions.filter { $0.status == "pending" }.count + (catalogOperations ?? []).filter { $0.status == "pending" || $0.status == "prepared" }.count }
    var conflictCount: Int { sessions.filter { $0.status == "conflict" }.count + (catalogOperations ?? []).filter { $0.status == "conflict" }.count }
}
struct ReplicaCatalogStatus: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let action: String
    let status: String
    let error: String?
    let notebookId: String
    let sessionId: String?
    var actionLabel: String {
        switch action {
        case "create_notebook": "新建 Notebook"
        case "create_session": "新建 Session"
        case "rename": "重命名"
        case "trash": "移至废纸篓"
        case "restore": "恢复"
        default: "目录操作"
        }
    }
}
struct ReplicaCatalogConflict: Decodable, Identifiable {
    let id: String
    let notebookId: String
    let title: String
    let action: String
    let error: String?
    let notebookTitle: String
    let remoteTitle: String?
    let pendingCount: Int
    let localText: String
}
struct ReplicaCatalogResolveRequest: Encodable {
    let catalogOperationId: String
    let choice = "remote"
}
struct ReplicaCatalogResolutionResult: Decodable {
    let notebookId: String
    let backupRelativePath: String
}
struct ReplicaSyncRequest: Encodable {
    let origin: String
    let token: String
    let hostId: String
}
struct ReplicaResolveRequest: Encodable {
    let notebookId: String
    let sessionId: String
    let choice: String
}

struct ReplicaConflictSnapshot: Decodable {
    struct Session: Decodable {
        struct Block: Decodable { let id: String; let path: String }
        let title: String
        let blocks: [Block]
    }
    let session: Session
    let markdown: [String: String]
    var text: String { session.blocks.compactMap { markdown[$0.path] }.joined(separator: "\n\n") }
}
struct ReplicaConflictEntry: Decodable, Identifiable {
    struct Versions: Decodable { let remote: ReplicaConflictSnapshot; let local: ReplicaConflictSnapshot }
    let notebookId: String
    let sessionId: String
    let title: String
    let conflict: Versions
    var id: String { "\(notebookId)/\(sessionId)" }
}
struct ReplicaConflictResponse: Decodable {
    let conflicts: [ReplicaConflictEntry]
    let catalogConflicts: [ReplicaCatalogConflict]?
}

struct SplitLockedSelectionResponse: Codable, Sendable {
    let version: Int
    let lockedBlockId: String
    let blocks: [ReadonlySessionBlock]
}

struct SessionRewriteChange: Codable, Identifiable, Sendable {
    let blockId: String
    let title: String
    let beforeMarkdown: String
    let markdown: String
    let reason: String
    var id: String { blockId }
}
struct SessionRewriteSuggestion: Codable, Identifiable, Sendable {
    let blockId: String
    let title: String
    let reason: String
    var id: String { blockId }
}
struct SessionRewriteProposal: Codable, Identifiable, Sendable {
    let version: Int
    let id: String
    let notebookId: String
    let sessionId: String
    let blockId: String?
    let instruction: String
    let status: String
    let summary: String
    let changes: [SessionRewriteChange]
    let lockedSuggestions: [SessionRewriteSuggestion]
    let providerName: String
    let createdAt: String
    let updatedAt: String
}
struct SessionRewriteList: Codable, Sendable { let proposals: [SessionRewriteProposal] }
struct SessionRewriteRequest: Codable, Sendable {
    var instruction: String? = nil
    var blockId: String? = nil
    var proposalId: String? = nil
}

struct SharePackageImportRequest: Encodable {
    let packagePath: String
    let notebookId: String?
}
struct SharePackageImportResult: Decodable {
    let session: SessionCatalogItem
    let assetCount: Int
    let byteLength: Int
}
