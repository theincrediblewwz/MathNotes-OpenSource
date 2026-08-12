import AppKit
import SwiftUI

struct ProviderSettingsView: View {
    @ObservedObject var supervisor: SidecarSupervisor
    @ObservedObject var editingState: AppEditingState
    @StateObject private var lanAddressMonitor = CompanionLanAddressMonitor()

    @State private var notesRootURL = DirectoryBookmarkStore.resolvedURL(for: .notesRoot)
    @State private var exportURL = DirectoryBookmarkStore.resolvedURL(for: .defaultExport)
    @State private var workspaceMessage: String?
    @State private var isSavingWorkspace = false

    @State private var appearanceMode = AppAppearanceMode.load()
    @State private var sourceFont = MacTypographyPreferences.sourcePreset()
    @State private var sourceFontSize = MacTypographyPreferences.sourceSize()
    @State private var previewFont = MacTypographyPreferences.previewPreset()
    @State private var previewFontSize = MacTypographyPreferences.previewSize()
    @State private var assistantFont = MacTypographyPreferences.assistantPreset()
    @State private var assistantFontSize = MacTypographyPreferences.assistantSize()
    @State private var materialOpacity = MacMaterialPreferences.opacity()
    @State private var materialBlur = MacMaterialPreferences.blur()

    @State private var preset: ProviderPreset = .mimo
    @State private var model = ProviderPreset.mimo.defaultModel
    @State private var endpoint = ProviderPreset.mimo.defaultEndpoint
    @State private var apiKey = ""
    @State private var hasSavedKey = false
    @State private var providerMessage: String?
    @State private var isWorking = false
    @State private var isTestingProvider = false
    @State private var assistantPreset: ProviderPreset = .mimo
    @State private var assistantModel = ProviderPreset.mimo.defaultModel
    @State private var assistantEndpoint = ProviderPreset.mimo.defaultEndpoint
    @State private var assistantAPIKey = ""
    @State private var assistantHasSavedKey = false
    @State private var assistantProviderMessage: String?
    @State private var isAssistantWorking = false
    @State private var isTestingAssistantProvider = false
    @State private var providerTestPurpose: ProviderPurpose?
    @State private var promptConfig: MacPromptTemplateConfig?
    @State private var selectedPromptId = ""
    @State private var guidanceMessage: String?
    @State private var isSavingGuidance = false
    @State private var notationConfig: MacNotationProfileConfig?
    @State private var selectedNotationProfileId = ""
    @State private var selectedNotationRuleId = ""
    @State private var notationPreviewQuery = ""
    @State private var notationPreview: MacNotationPromptPreview?

    @State private var companionOrigin = ""
    @State private var companionToken = ""
    @State private var hasSavedCompanionToken = false
    @State private var companionMessage: String?
    @State private var isCheckingCompanion = false
    @State private var revealsHostToken = false
    @State private var hostCopyMessage: String?
    @State private var newHostToken = ""
    @State private var hostTokenConfirmation = ""
    @State private var isUpdatingHostToken = false
    @State private var isRefreshingPairingChallenge = false

    var body: some View {
        TabView {
            generalSettings
                .tabItem { Label("通用", systemImage: "folder") }
            readingSettings
                .tabItem { Label("编辑与阅读", systemImage: "textformat") }
            companionSettings
                .tabItem { Label("设备连接", systemImage: "network") }
            providerSettings
                .tabItem { Label("AI 服务", systemImage: "sparkles") }
            aiGuidanceSettings
                .tabItem { Label("AI 规则", systemImage: "text.badge.checkmark") }
            diagnostics
                .tabItem { Label("诊断", systemImage: "stethoscope") }
        }
        .padding(20)
        .frame(minWidth: 720, minHeight: 600)
        .task {
            await loadProvider()
            await loadAiGuidance()
            await loadCompanionConnection()
        }
        .task(id: supervisor.companionHost?.port) {
            await ensureCompanionPairingChallenge()
        }
        .confirmationDialog(
            "测试 AI 服务连通性？",
            isPresented: Binding(
                get: { providerTestPurpose != nil },
                set: { if !$0 { providerTestPurpose = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("发送一次最小测试请求") {
                guard let purpose = providerTestPurpose else { return }
                providerTestPurpose = nil
                Task { await testProvider(purpose) }
            }
            Button("取消", role: .cancel) { providerTestPurpose = nil }
        } message: {
            Text("将使用已保存的配置向 Provider 发送一次最小请求，可能产生少量计费。MathNotes 不会在后台自动测试。")
        }
    }

    private var generalSettings: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.section) {
                settingsHeading("通用", detail: "选择笔记正本与导出时默认打开的位置。")

                GroupBox("文件位置") {
                    VStack(spacing: MathNotesTheme.Spacing.standard) {
                        directoryRow(
                            title: "笔记所在位置",
                            detail: notesRootURL?.path ?? "使用 MathNotes 默认目录",
                            choose: { chooseDirectory(title: "选择笔记所在位置") { notesRootURL = $0 } },
                            reset: { notesRootURL = nil }
                        )
                        Divider()
                        directoryRow(
                            title: "默认导出位置",
                            detail: exportURL?.path ?? "每次导出时再选择",
                            choose: { chooseDirectory(title: "选择默认导出位置") { exportURL = $0 } },
                            reset: { exportURL = nil }
                        )
                    }
                    .padding(8)
                }

                if editingState.hasUnsavedSourceDrafts {
                    Label("当前有未保存的源码修改，保存前不能切换笔记目录。", systemImage: "exclamationmark.triangle")
                        .font(.callout)
                        .foregroundStyle(MathNotesTheme.warning)
                }

                settingsFooter(message: workspaceMessage, isWorking: isSavingWorkspace) {
                    Task { await saveWorkspaceSettings() }
                }
            }
            .padding(MathNotesTheme.Spacing.standard)
        }
    }

    private var readingSettings: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.section) {
                settingsHeading("编辑与阅读", detail: "调整会立即应用到正在阅读的窗口。")

                GroupBox("界面外观") {
                    VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
                        Picker("界面外观", selection: $appearanceMode) {
                            ForEach(AppAppearanceMode.allCases) { option in
                                Text(option.label).tag(option)
                            }
                        }
                        .pickerStyle(.segmented)

                        Divider()

                        LabeledContent("材料透明度") {
                            HStack {
                                Slider(value: $materialOpacity, in: 0.45...1)
                                    .frame(width: 220)
                                Text("\(Int(materialOpacity * 100))%")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                                    .frame(width: 40, alignment: .trailing)
                            }
                        }

                        LabeledContent("背景模糊度") {
                            HStack {
                                Slider(value: $materialBlur, in: 0...1)
                                    .frame(width: 220)
                                Text("\(Int(materialBlur * 100))%")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                                    .frame(width: 40, alignment: .trailing)
                            }
                        }

                        Text("透明度只影响工具栏、浮动按钮和弹出面板；笔记正文保持实色，避免降低可读性。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(8)
                }

                GroupBox("字体与字号") {
                    VStack(spacing: MathNotesTheme.Spacing.standard) {
                        fontRow(
                            title: "源码",
                            sourceSelection: $sourceFont,
                            size: $sourceFontSize,
                            preview: sourceFont.font(size: sourceFontSize)
                        )
                        Divider()
                        previewFontRow
                        Divider()
                        assistantFontRow
                    }
                    .padding(8)
                }
            }
            .padding(MathNotesTheme.Spacing.standard)
        }
        .onChange(of: appearanceMode) { _, value in value.save() }
        .onChange(of: sourceFont) { _, _ in saveReadingPreferences() }
        .onChange(of: sourceFontSize) { _, _ in saveReadingPreferences() }
        .onChange(of: previewFont) { _, _ in saveReadingPreferences() }
        .onChange(of: previewFontSize) { _, _ in saveReadingPreferences() }
        .onChange(of: assistantFont) { _, _ in saveReadingPreferences() }
        .onChange(of: assistantFontSize) { _, _ in saveReadingPreferences() }
        .onChange(of: materialOpacity) { _, _ in saveReadingPreferences() }
        .onChange(of: materialBlur) { _, _ in saveReadingPreferences() }
    }

    private var providerSettings: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.section) {
                settingsHeading("AI 服务", detail: "识别和对话可使用不同模型；密钥只保存在系统钥匙串中。")

                GroupBox("数学图片识别") {
                    VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
                        Form {
                            Picker("服务", selection: $preset) {
                                ForEach(ProviderPreset.options(for: .recognition)) { option in Text(option.label).tag(option) }
                            }
                            .onChange(of: preset) { _, value in
                                model = value.defaultModel
                                endpoint = value.defaultEndpoint
                                apiKey = ""
                                Task { hasSavedKey = await supervisor.hasSavedProviderKey(value) }
                            }
                            TextField("模型", text: $model)
                            if preset.exposesEndpoint {
                                TextField("请求地址", text: $endpoint)
                                    .textContentType(.URL)
                            } else {
                                LabeledContent("请求地址", value: "使用内置官方地址")
                                    .foregroundStyle(.secondary)
                            }
                            HStack {
                                SecureField(hasSavedKey ? "已保存；留空则继续使用" : "API 密钥", text: $apiKey)
                                Button("测试连通") { providerTestPurpose = .recognition }
                                    .disabled(isWorking || isTestingProvider || !supervisor.providerStatus.configured)
                                    .help(supervisor.providerStatus.configured ? "发送一次最小测试请求" : "请先保存识别服务")
                            }
                        }
                        .formStyle(.grouped)

                        HStack(spacing: MathNotesTheme.Spacing.standard) {
                            providerStatusLabel
                            Spacer()
                            Button("清除配置", role: .destructive) { Task { await clearProvider() } }
                                .disabled(isWorking || !supervisor.providerStatus.configured)
                            Button("保存识别服务") { Task { await saveProvider() } }
                                .buttonStyle(.borderedProminent)
                                .disabled(isWorking || model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                          endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                    .padding(8)
                }

                GroupBox("学习助手对话") {
                    VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
                        Text("未单独保存时自动继承识别模型；保存后只影响学习助手。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Form {
                            Picker("服务", selection: $assistantPreset) {
                                ForEach(ProviderPreset.options(for: .assistant)) { option in Text(option.label).tag(option) }
                            }
                            .onChange(of: assistantPreset) { _, value in
                                assistantModel = value.defaultModel
                                assistantEndpoint = value.defaultEndpoint
                                assistantAPIKey = ""
                                Task { assistantHasSavedKey = await supervisor.hasSavedProviderKey(value, purpose: .assistant) }
                            }
                            TextField("模型", text: $assistantModel)
                            if assistantPreset.exposesEndpoint {
                                TextField("请求地址", text: $assistantEndpoint).textContentType(.URL)
                            } else {
                                LabeledContent("请求地址", value: "使用内置官方地址")
                                    .foregroundStyle(.secondary)
                            }
                            HStack {
                                SecureField(assistantHasSavedKey ? "已保存；留空则继续使用" : "API 密钥", text: $assistantAPIKey)
                                Button("测试连通") { providerTestPurpose = .assistant }
                                    .disabled(isAssistantWorking || isTestingAssistantProvider || !supervisor.assistantProviderStatus.configured)
                                    .help(supervisor.assistantProviderStatus.configured ? "发送一次最小测试请求" : "请先保存对话模型")
                            }
                        }
                        .formStyle(.grouped)
                        HStack(spacing: MathNotesTheme.Spacing.standard) {
                            assistantProviderStatusLabel
                            Spacer()
                            Button("恢复继承识别模型", role: .destructive) { Task { await clearAssistantProvider() } }
                                .disabled(isAssistantWorking || supervisor.assistantProviderStatus.inherited == true)
                            Button("保存对话模型") { Task { await saveAssistantProvider() } }
                                .buttonStyle(.borderedProminent)
                                .disabled(isAssistantWorking || assistantModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                          assistantEndpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                    .padding(8)
                }
            }
            .padding(MathNotesTheme.Spacing.standard)
        }
    }

    private var companionSettings: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.section) {
                settingsHeading(
                    "设备连接",
                    detail: "这台 Mac 可以作为笔记主机，也可以连接另一台 MathNotes 主机。"
                )

                GroupBox("本机作为主机") {
                    VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
                        HStack {
                            Label(
                                supervisor.companionHost == nil ? "正在准备设备连接" : "设备连接服务运行中",
                                systemImage: supervisor.companionHost == nil ? "clock" : "checkmark.circle.fill"
                            )
                            .foregroundStyle(supervisor.companionHost == nil ? .secondary : MathNotesTheme.accent)
                            Spacer()
                            if supervisor.companionHost == nil { ProgressView().controlSize(.small) }
                        }

                        companionServeStatus

                        DisclosureGroup("第一次连接手机（3 步）") {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("iPhone / PWA：让手机与 Mac 连接同一 Wi-Fi 或 iPhone 热点，用 Safari 打开下方局域网地址，再输入长期配对令牌。需要远程或 HTTPS 时，可改用已有的 Tailscale 地址。")
                                Text("Android App：连接同一 Wi-Fi、手机热点或同一 Tailscale 网络，优先扫描下方二维码；二维码十分钟有效，成功一次后立即失效。")
                                Text("连接成功后，可在手机主界面选择 Notebook / Session。MathNotes 不会替你修改热点、Tailscale、Serve 或防火墙。")
                            }
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .padding(.top, 8)
                        }

                        if let companionHost = supervisor.companionHost {
                            Divider()
                            VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
                                Label("iPhone / PWA · 同一 Wi-Fi 或手机热点", systemImage: "wifi")
                                    .font(.headline)

                                if let address = lanAddressMonitor.recommended {
                                    let origin = address.origin(port: companionHost.port)
                                    hostValueRow(
                                        title: "局域网地址",
                                        value: origin,
                                        copyValue: origin,
                                        copyLabel: "复制地址"
                                    ) {
                                        Button("重新检测") { lanAddressMonitor.refresh() }
                                    }

                                    Text("手机与 Mac 在同一网络时，用 Safari 打开这个地址。页面打开后输入下方长期配对令牌；成功一次后手机会保存自己的设备凭据。")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)

                                    if let challenge = supervisor.companionPairingChallenge {
                                        let payload = pairingPayload(challenge, port: companionHost.port)
                                        Divider()
                                        Label("Android App · 扫码连接", systemImage: "qrcode.viewfinder")
                                            .font(.headline)
                                        HStack(alignment: .top, spacing: MathNotesTheme.Spacing.section) {
                                            if let qrCode = CompanionPairingQRCode.image(payload: payload) {
                                                Image(nsImage: qrCode)
                                                    .interpolation(.none)
                                                    .resizable()
                                                    .frame(width: 152, height: 152)
                                                    .accessibilityLabel("Android 局域网配对二维码")
                                            }
                                            VStack(alignment: .leading, spacing: 8) {
                                                Text("一次性配对码")
                                                    .font(.caption)
                                                    .foregroundStyle(.secondary)
                                                Text(challenge.userCode)
                                                    .font(.system(.title, design: .monospaced, weight: .semibold))
                                                    .textSelection(.enabled)
                                                Text("10 分钟内有效，成功连接一次后立即失效。")
                                                    .font(.caption)
                                                    .foregroundStyle(.secondary)
                                                HStack {
                                                    Button("复制配对链接") {
                                                        NSPasteboard.general.clearContents()
                                                        NSPasteboard.general.setString(payload, forType: .string)
                                                        hostCopyMessage = "局域网配对链接已复制"
                                                    }
                                                    Button("刷新配对码") {
                                                        Task { await ensureCompanionPairingChallenge(force: true) }
                                                    }
                                                    .disabled(isRefreshingPairingChallenge)
                                                }
                                            }
                                        }
                                    } else {
                                        HStack {
                                            if isRefreshingPairingChallenge { ProgressView().controlSize(.small) }
                                            Button("生成一次性配对码") {
                                                Task { await ensureCompanionPairingChallenge(force: true) }
                                            }
                                            .disabled(isRefreshingPairingChallenge)
                                        }
                                    }

                                    Text("Android 可直接扫描二维码；也可手填局域网地址与长期配对令牌。手机和 Mac 可使用同一 Wi-Fi、iPhone 热点或同一 Tailscale 网络，不需要开启 Mac 互联网共享。")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                } else {
                                    Label("尚未发现可用的私有局域网地址。请先让 Mac 加入手机热点或可信 Wi-Fi。", systemImage: "exclamationmark.triangle")
                                        .font(.callout)
                                        .foregroundStyle(MathNotesTheme.warning)
                                    Button("重新检测地址") { lanAddressMonitor.refresh() }
                                }
                            }
                        }

                        Divider()
                        Text("iPhone / PWA · Tailscale HTTPS（高级/远程）")
                            .font(.headline)
                        if let origin = supervisor.companionPublicOrigin {
                            hostValueRow(
                                title: "Tailscale HTTPS 地址",
                                value: origin,
                                copyValue: origin,
                                copyLabel: "复制地址"
                            )
                        }
                        Text("仅在你已经配置 Tailscale 时使用：手机也需进入同一 tailnet，再用 Safari 打开该 HTTPS 地址并输入长期配对令牌。局域网地址已可直接打开 PWA；HTTPS 仍用于更完整的安全上下文与远程连接。")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        if let token = supervisor.companionHostToken {
                            hostValueRow(
                                title: "PWA / 手填连接令牌",
                                value: revealsHostToken ? token : String(repeating: "•", count: 20),
                                copyValue: token,
                                copyLabel: "复制令牌"
                            ) {
                                Button(revealsHostToken ? "隐藏" : "显示") {
                                    revealsHostToken.toggle()
                                }
                            }
                            Text("PWA 首次连接和 Android 手填连接使用此令牌；二维码不会包含它。请勿把令牌发给不受信任的人。")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        DisclosureGroup("更换长期配对令牌") {
                            VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
                                SecureField("新配对令牌", text: $newHostToken)
                                SecureField("再次输入新令牌", text: $hostTokenConfirmation)
                                Text("使用 16–128 位字母、数字或 . _ ~ -；保存后旧的 PWA 和手填连接需要重新输入。")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                HStack {
                                    Button("生成强令牌") {
                                        let generated = CompanionHostTokenPolicy.generate()
                                        newHostToken = generated
                                        hostTokenConfirmation = generated
                                        hostCopyMessage = "已生成强令牌；保存后可在上方显示或复制"
                                    }
                                    Spacer()
                                    if isUpdatingHostToken { ProgressView().controlSize(.small) }
                                    Button("保存新令牌") {
                                        Task { await updateCompanionHostToken() }
                                    }
                                    .disabled(
                                        isUpdatingHostToken ||
                                        newHostToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                        hostTokenConfirmation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    )
                                }
                            }
                            .padding(.top, 8)
                        }

                        if let hostCopyMessage {
                            Text(hostCopyMessage)
                                .font(.caption)
                                .foregroundStyle(MathNotesTheme.accent)
                        }
                        Text("MathNotes 不会开启 Mac 互联网共享，也不会启用 Funnel 或修改 Windows 网络。若 macOS 询问是否允许传入连接，请由你人工决定。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(8)
                }

                GroupBox("连接其他 MathNotes 主机") {
                    VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
                        Form {
                            TextField(
                                "电脑地址",
                                text: $companionOrigin,
                                prompt: Text("https://电脑名.tailnet.ts.net 或 192.168.1.8:1051")
                            )
                            .textContentType(.URL)
                            SecureField(
                                hasSavedCompanionToken ? "已保存；留空则继续使用" : "配对令牌",
                                text: $companionToken
                            )
                        }
                        .formStyle(.grouped)

                        Text("令牌只保存在系统钥匙串中；诊断与日志只显示连接状态。")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        HStack(spacing: MathNotesTheme.Spacing.standard) {
                            if isCheckingCompanion {
                                ProgressView().controlSize(.small)
                            } else if let companionMessage {
                                Text(companionMessage)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            } else if hasSavedCompanionToken && !companionOrigin.isEmpty {
                                Label("已保存连接", systemImage: "checkmark.circle")
                                    .font(.callout)
                                    .foregroundStyle(MathNotesTheme.accent)
                            } else {
                                Text("尚未配置").font(.callout).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("清除连接", role: .destructive) {
                                Task { await clearCompanionConnection() }
                            }
                            .disabled(isCheckingCompanion || (!hasSavedCompanionToken && companionOrigin.isEmpty))
                            Button("检查连接") {
                                Task { await checkCompanionConnection() }
                            }
                            .disabled(isCheckingCompanion || companionOrigin.trimmingCharacters(
                                in: .whitespacesAndNewlines
                            ).isEmpty)
                            Button("保存连接") {
                                Task { await saveCompanionConnection() }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(isCheckingCompanion || companionOrigin.trimmingCharacters(
                                in: .whitespacesAndNewlines
                            ).isEmpty)
                        }
                    }
                    .padding(8)
                }

                Label(
                    "本机笔记以这台 Mac 的 Core 为正本；连接其他主机时使用独立凭据，两种角色互不覆盖。",
                    systemImage: "info.circle"
                )
                .font(.callout)
                .foregroundStyle(.secondary)
            }
            .padding(MathNotesTheme.Spacing.standard)
        }
    }

    private var diagnostics: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.section) {
                settingsHeading("诊断", detail: "这里只显示安全状态，不展示密钥、令牌或内部命令。")

                GroupBox("运行状态") {
                    VStack(spacing: 0) {
                        diagnosticRow("笔记核心", value: sidecarStatus)
                        Divider()
                        diagnosticRow("笔记目录", value: catalogStatus)
                        Divider()
                        diagnosticRow("识别服务", value: supervisor.providerStatus.configured
                                      ? (supervisor.providerStatus.label ?? "已配置") : "未配置")
                        Divider()
                        diagnosticRow(
                            "本机设备连接",
                            value: supervisor.companionHost == nil ? "未启动" : "运行正常"
                        )
                        Divider()
                        diagnosticRow(
                            "连接其他主机",
                            value: hasSavedCompanionToken && !companionOrigin.isEmpty ? "已配置" : "未配置"
                        )
                        Divider()
                        diagnosticRow("上次退出", value: MacRuntimeDiagnostics.previousExitSummary())
                        Divider()
                        diagnosticRow(
                            "异常或强制退出累计",
                            value: "\(MacRuntimeDiagnostics.interruptedRunCount()) 次"
                        )
                        Divider()
                        diagnosticRow("最近打开正文", value: MacRuntimeDiagnostics.lastSessionOpenSummary())
                        Divider()
                        diagnosticRow("最近正文阶段", value: MacRuntimeDiagnostics.lastSessionStageSummary())
                        Divider()
                        diagnosticRow("最近失败类型", value: MacRuntimeDiagnostics.lastSessionFailureSummary())
                    }
                    .padding(8)
                }

                HStack {
                    Button("重新读取笔记目录") { supervisor.reloadCatalog() }
                        .disabled(!isCoreReady)
                    Spacer()
                    if case .failed = supervisor.state {
                        Button("重新连接核心") { supervisor.retry() }
                            .buttonStyle(.borderedProminent)
                    }
                }
            }
            .padding(MathNotesTheme.Spacing.standard)
        }
    }

    private func settingsHeading(_ title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.title2.weight(.semibold))
            Text(detail).font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func directoryRow(
        title: String,
        detail: String,
        choose: @escaping () -> Void,
        reset: @escaping () -> Void
    ) -> some View {
        HStack(spacing: MathNotesTheme.Spacing.standard) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body.weight(.medium))
                Text(detail)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
            Spacer(minLength: MathNotesTheme.Spacing.standard)
            Button("恢复默认", action: reset)
            Button("选择…", action: choose)
        }
    }

    private func fontRow(
        title: String,
        sourceSelection: Binding<MacSourceFontPreset>,
        size: Binding<Double>,
        preview: Font
    ) -> some View {
        HStack(spacing: MathNotesTheme.Spacing.standard) {
            Text(title).frame(width: 70, alignment: .leading)
            Picker("字体", selection: sourceSelection) {
                ForEach(MacSourceFontPreset.allCases) { option in Text(option.label).tag(option) }
            }
            .labelsHidden()
            .frame(width: 160)
            Stepper(value: size, in: 10...24, step: 1) {
                Text("\(Int(size.wrappedValue)) pt").monospacedDigit().frame(width: 48)
            }
            Text("Aa 数学 Markdown $T_n$")
                .font(preview)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var previewFontRow: some View {
        HStack(spacing: MathNotesTheme.Spacing.standard) {
            Text("预览").frame(width: 70, alignment: .leading)
            Picker("字体", selection: $previewFont) {
                ForEach(MacPreviewFontPreset.allCases) { option in Text(option.label).tag(option) }
            }
            .labelsHidden()
            .frame(width: 160)
            Stepper(value: $previewFontSize, in: 12...28, step: 1) {
                Text("\(Int(previewFontSize)) pt").monospacedDigit().frame(width: 48)
            }
            Text("Aa 数学笔记与公式预览")
                .font(previewFont.font(size: previewFontSize))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var assistantFontRow: some View {
        HStack(spacing: MathNotesTheme.Spacing.standard) {
            Text("AI 回答").frame(width: 70, alignment: .leading)
            Picker("字体", selection: $assistantFont) {
                ForEach(MacPreviewFontPreset.allCases) { option in Text(option.label).tag(option) }
            }
            .labelsHidden()
            .frame(width: 160)
            Stepper(value: $assistantFontSize, in: 12...28, step: 1) {
                Text("\(Int(assistantFontSize)) pt").monospacedDigit().frame(width: 48)
            }
            Text("AI 回答与数学说明")
                .font(assistantFont.font(size: assistantFontSize))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var aiGuidanceSettings: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.section) {
                settingsHeading(
                    "AI 规则",
                    detail: "提示词与领域记号由 Mac Core 保存；只有已批准规则会进入识别上下文，图片证据始终优先。"
                )

                GroupBox("识别提示词模板") {
                    HStack(alignment: .top, spacing: MathNotesTheme.Spacing.standard) {
                        VStack(alignment: .leading, spacing: 6) {
                            if let config = promptConfig {
                                ForEach(config.templates) { template in
                                    Button {
                                        selectedPromptId = template.id
                                    } label: {
                                        HStack {
                                            Image(systemName: config.activeTemplateId == template.id ? "checkmark.circle.fill" : "circle")
                                            Text(template.name).lineLimit(1)
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .buttonStyle(.plain)
                                    .padding(6)
                                    .background(selectedPromptId == template.id ? MathNotesTheme.accent.opacity(0.12) : .clear)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                            }
                            Button("新建用户模板", systemImage: "plus") { addPromptTemplate() }
                        }
                        .frame(width: 190, alignment: .topLeading)

                        Divider()
                        promptTemplateEditor
                    }
                    .padding(8)
                }

                GroupBox("领域记号基准") {
                    VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
                        Text("候选规则需明确改为“已批准”才参与识别；同一记号出现互相冲突的含义时，Core 会排除冲突并在预览中说明。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        HStack(alignment: .top, spacing: MathNotesTheme.Spacing.standard) {
                            notationProfileList
                            Divider()
                            notationProfileEditor
                        }
                        Divider()
                        VStack(alignment: .leading, spacing: 8) {
                            Text("选择与提示词预览").font(.headline)
                            HStack {
                                TextField("输入课程主题、相邻文字或要验证的记号", text: $notationPreviewQuery)
                                Button("生成预览") { Task { await previewNotationGuidance() } }
                                    .disabled(notationPreviewQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                            if let preview = notationPreview {
                                Text("已选规则会占用 \(preview.selection.characterCount) 字；预算省略 \(preview.selection.omittedByBudget) 条；冲突 \(preview.selection.conflicts.count) 组。")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                ScrollView {
                                    Text(preview.fullPrompt)
                                        .font(.system(.caption, design: .monospaced))
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .frame(minHeight: 100, maxHeight: 180)
                                .padding(8)
                                .background(.background.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
                            }
                        }
                    }
                    .padding(8)
                }

                HStack {
                    if isSavingGuidance { ProgressView().controlSize(.small) }
                    if let guidanceMessage { Text(guidanceMessage).font(.callout).foregroundStyle(.secondary) }
                    Spacer()
                    Button("保存 AI 规则") { Task { await saveAiGuidance() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(isSavingGuidance || promptConfig == nil || notationConfig == nil)
                }
            }
            .padding(MathNotesTheme.Spacing.standard)
        }
    }

    @ViewBuilder private var promptTemplateEditor: some View {
        if let index = promptConfig?.templates.firstIndex(where: { $0.id == selectedPromptId }),
           let config = promptConfig {
            let template = config.templates[index]
            VStack(alignment: .leading, spacing: 8) {
                TextField("模板名称", text: Binding(
                    get: { promptConfig?.templates[index].name ?? "" },
                    set: { promptConfig?.templates[index].name = $0 }
                ))
                .disabled(template.locked == true)
                TextEditor(text: Binding(
                    get: { promptConfig?.templates[index].content ?? "" },
                    set: { promptConfig?.templates[index].content = $0 }
                ))
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 190)
                .disabled(template.locked == true)
                HStack {
                    Button("设为识别模板") { promptConfig?.activeTemplateId = template.id }
                        .disabled(promptConfig?.activeTemplateId == template.id)
                    Spacer()
                    if template.locked != true {
                        Button("删除模板", role: .destructive) { deleteSelectedPromptTemplate() }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
        } else {
            ContentUnavailableView("选择一个提示词模板", systemImage: "text.badge.checkmark")
                .frame(maxWidth: .infinity, minHeight: 240)
        }
    }

    private var notationProfileList: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let profiles = notationConfig?.profiles {
                ForEach(profiles) { profile in
                    Button {
                        selectedNotationProfileId = profile.id
                        selectedNotationRuleId = profile.rules.first?.id ?? ""
                    } label: {
                        HStack {
                            Image(systemName: profile.enabled && profile.status == "active" ? "checkmark.circle.fill" : "circle")
                            Text(profile.name).lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .padding(6)
                    .background(selectedNotationProfileId == profile.id ? MathNotesTheme.accent.opacity(0.12) : .clear)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
            Button("新建领域", systemImage: "plus") { addNotationProfile() }
        }
        .frame(width: 170, alignment: .topLeading)
    }

    @ViewBuilder private var notationProfileEditor: some View {
        if let profileIndex = notationConfig?.profiles.firstIndex(where: { $0.id == selectedNotationProfileId }) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    TextField("领域名称", text: Binding(
                        get: { notationConfig?.profiles[profileIndex].name ?? "" },
                        set: { notationConfig?.profiles[profileIndex].name = $0 }
                    ))
                    Toggle("启用", isOn: Binding(
                        get: { notationConfig?.profiles[profileIndex].enabled ?? false },
                        set: { notationConfig?.profiles[profileIndex].enabled = $0 }
                    ))
                    Stepper("优先级 \(notationConfig?.profiles[profileIndex].priority ?? 0)", value: Binding(
                        get: { notationConfig?.profiles[profileIndex].priority ?? 0 },
                        set: { notationConfig?.profiles[profileIndex].priority = $0 }
                    ), in: -100...100)
                }
                TextField("说明", text: Binding(
                    get: { notationConfig?.profiles[profileIndex].description ?? "" },
                    set: { notationConfig?.profiles[profileIndex].description = $0 }
                ))
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(notationConfig?.profiles[profileIndex].rules ?? []) { rule in
                            Button(rule.pattern.isEmpty ? "未填写记号" : rule.pattern) { selectedNotationRuleId = rule.id }
                                .buttonStyle(.plain)
                                .padding(5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(selectedNotationRuleId == rule.id ? MathNotesTheme.accent.opacity(0.12) : .clear)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                        Button("添加规则", systemImage: "plus") { addNotationRule(profileIndex) }
                    }
                    .frame(width: 150, alignment: .topLeading)
                    notationRuleEditor(profileIndex)
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
        } else {
            ContentUnavailableView("创建或选择领域", systemImage: "character.book.closed")
                .frame(maxWidth: .infinity, minHeight: 220)
        }
    }

    @ViewBuilder private func notationRuleEditor(_ profileIndex: Int) -> some View {
        if let ruleIndex = notationConfig?.profiles[profileIndex].rules.firstIndex(where: { $0.id == selectedNotationRuleId }) {
            VStack(alignment: .leading, spacing: 7) {
                TextField("记号，例如 ξ*", text: Binding(
                    get: { notationConfig?.profiles[profileIndex].rules[ruleIndex].pattern ?? "" },
                    set: { notationConfig?.profiles[profileIndex].rules[ruleIndex].pattern = $0 }
                ))
                TextField("含义", text: Binding(
                    get: { notationConfig?.profiles[profileIndex].rules[ruleIndex].meaning ?? "" },
                    set: { notationConfig?.profiles[profileIndex].rules[ruleIndex].meaning = $0 }
                ))
                Picker("类型", selection: Binding(
                    get: { notationConfig?.profiles[profileIndex].rules[ruleIndex].kind ?? "symbol" },
                    set: { notationConfig?.profiles[profileIndex].rules[ruleIndex].kind = $0 }
                )) {
                    Text("符号").tag("symbol")
                    Text("约定").tag("convention")
                    Text("定义").tag("definition")
                    Text("图示标签").tag("diagram_label")
                }
                Picker("状态", selection: Binding(
                    get: { notationConfig?.profiles[profileIndex].rules[ruleIndex].status ?? "candidate" },
                    set: {
                        notationConfig?.profiles[profileIndex].rules[ruleIndex].status = $0
                        notationConfig?.profiles[profileIndex].rules[ruleIndex].approvedAt = $0 == "approved"
                            ? ISO8601DateFormatter().string(from: Date()) : nil
                    }
                )) {
                    Text("候选").tag("candidate")
                    Text("已批准").tag("approved")
                    Text("已拒绝").tag("rejected")
                    Text("已停用").tag("retired")
                }
                Text(notationConfig?.profiles[profileIndex].rules[ruleIndex].status == "approved"
                     ? "此规则会进入识别上下文。" : "此规则不会进入识别上下文。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("删除规则", role: .destructive) {
                    notationConfig?.profiles[profileIndex].rules.remove(at: ruleIndex)
                    selectedNotationRuleId = notationConfig?.profiles[profileIndex].rules.first?.id ?? ""
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
        } else {
            Text("选择或添加规则").foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 160)
        }
    }

    private func saveReadingPreferences() {
        MacTypographyPreferences.save(
            sourcePreset: sourceFont,
            sourceSize: sourceFontSize,
            previewPreset: previewFont,
            previewSize: previewFontSize
        )
        MacMaterialPreferences.save(
            opacity: materialOpacity,
            blur: materialBlur
        )
        MacTypographyPreferences.saveAssistant(preset: assistantFont, size: assistantFontSize)
    }

    private func settingsFooter(
        message: String?,
        isWorking: Bool,
        save: @escaping () -> Void
    ) -> some View {
        HStack {
            if isWorking {
                ProgressView().controlSize(.small)
            } else if let message {
                Text(message).font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            Button("保存设置", action: save)
                .buttonStyle(.borderedProminent)
                .disabled(isWorking)
        }
    }

    private func diagnosticRow(_ title: String, value: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value).foregroundStyle(.secondary).textSelection(.enabled)
        }
        .padding(.vertical, MathNotesTheme.Spacing.standard)
    }

    @ViewBuilder private var providerStatusLabel: some View {
        if isWorking || isTestingProvider {
            ProgressView().controlSize(.small)
        } else if let providerMessage {
            Text(providerMessage).font(.callout).foregroundStyle(.secondary)
        } else if supervisor.providerStatus.configured {
            Label("已配置 \(supervisor.providerStatus.label ?? "识别服务")", systemImage: "checkmark.circle.fill")
                .font(.callout).foregroundStyle(MathNotesTheme.accent)
        } else if let restorationError = supervisor.providerRestorationError {
            Label(restorationError.errorDescription, systemImage: "exclamationmark.triangle.fill")
                .font(.callout).foregroundStyle(MathNotesTheme.warning)
        } else {
            Text("尚未配置").font(.callout).foregroundStyle(.secondary)
        }
    }

    private var sidecarStatus: String {
        switch supervisor.state {
        case .idle: "未启动"
        case .starting: "正在启动"
        case .ready: "运行正常"
        case .stopping: "正在停止"
        case .failed: "连接失败"
        }
    }

    private var catalogStatus: String {
        switch supervisor.catalogState {
        case .idle: "尚未读取"
        case .loading: "正在读取"
        case let .loaded(notebooks):
            "\(notebooks.count) 个 Notebook · \(notebooks.reduce(0) { $0 + $1.sessions.count }) 个 Session"
        case .failed: "读取失败"
        }
    }

    private var isCoreReady: Bool {
        if case .ready = supervisor.state { return true }
        return false
    }

    private func chooseDirectory(title: String, apply: (URL) -> Void) {
        let panel = NSOpenPanel()
        panel.title = title
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url { apply(url) }
    }

    private func saveWorkspaceSettings() async {
        let currentNotesURL = DirectoryBookmarkStore.resolvedURL(for: .notesRoot)
        let notesChanged = currentNotesURL?.standardizedFileURL != notesRootURL?.standardizedFileURL
        if notesChanged, editingState.hasUnsavedSourceDrafts {
            workspaceMessage = "请先保存当前 Session 的源码修改，再切换笔记目录。"
            return
        }

        isSavingWorkspace = true
        workspaceMessage = nil
        let previousExport = DirectoryBookmarkStore.snapshot(.defaultExport)
        defer { isSavingWorkspace = false }
        do {
            if let exportURL { try DirectoryBookmarkStore.save(exportURL, for: .defaultExport) }
            else { DirectoryBookmarkStore.clear(.defaultExport) }
            if notesChanged { try await supervisor.applyNotesRoot(notesRootURL) }
            workspaceMessage = "文件位置已保存"
        } catch {
            DirectoryBookmarkStore.restore(previousExport, for: .defaultExport)
            notesRootURL = DirectoryBookmarkStore.resolvedURL(for: .notesRoot)
            exportURL = DirectoryBookmarkStore.resolvedURL(for: .defaultExport)
            workspaceMessage = error.localizedDescription
        }
    }

    private func loadProvider() async {
        if let record = ProviderPreferences.load() {
            preset = record.providerId
            model = record.model
            endpoint = record.endpoint
        }
        hasSavedKey = await supervisor.hasSavedProviderKey(preset)
        if let record = ProviderPreferences.load(.assistant) {
            assistantPreset = record.providerId
            assistantModel = record.model
            assistantEndpoint = record.endpoint
            assistantHasSavedKey = await supervisor.hasSavedProviderKey(record.providerId, purpose: .assistant)
        } else if let record = ProviderPreferences.load(.recognition) {
            assistantPreset = record.providerId
            assistantModel = record.model
            assistantEndpoint = record.endpoint
        }
    }

    private func saveProvider() async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await supervisor.configureProvider(
                preset: preset, model: model, endpoint: endpoint, newAPIKey: apiKey
            )
            apiKey = ""
            hasSavedKey = true
            providerMessage = "识别服务已保存"
        } catch {
            providerMessage = error.localizedDescription
        }
    }

    private func testProvider(_ purpose: ProviderPurpose) async {
        if purpose == .recognition {
            isTestingProvider = true
            providerMessage = nil
        } else {
            isTestingAssistantProvider = true
            assistantProviderMessage = nil
        }
        defer {
            if purpose == .recognition { isTestingProvider = false }
            else { isTestingAssistantProvider = false }
        }
        do {
            let result = try await supervisor.testProviderConnection(purpose: purpose)
            let message = result.ok ? "连通测试通过" : result.message
            if purpose == .recognition { providerMessage = message }
            else { assistantProviderMessage = message }
        } catch {
            if purpose == .recognition { providerMessage = error.localizedDescription }
            else { assistantProviderMessage = error.localizedDescription }
        }
    }

    private func clearProvider() async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await supervisor.clearProviderConfiguration()
            apiKey = ""
            hasSavedKey = false
            providerMessage = "配置已清除"
        } catch {
            providerMessage = error.localizedDescription
        }
    }

    private func saveAssistantProvider() async {
        isAssistantWorking = true
        defer { isAssistantWorking = false }
        do {
            try await supervisor.configureProvider(
                preset: assistantPreset,
                model: assistantModel,
                endpoint: assistantEndpoint,
                newAPIKey: assistantAPIKey,
                purpose: .assistant
            )
            assistantAPIKey = ""
            assistantHasSavedKey = true
            assistantProviderMessage = "对话模型已保存"
        } catch {
            assistantProviderMessage = error.localizedDescription
        }
    }

    private func clearAssistantProvider() async {
        isAssistantWorking = true
        defer { isAssistantWorking = false }
        do {
            try await supervisor.clearProviderConfiguration(.assistant)
            assistantAPIKey = ""
            assistantHasSavedKey = false
            assistantProviderMessage = "已恢复继承识别模型"
            if let record = ProviderPreferences.load(.recognition) {
                assistantPreset = record.providerId
                assistantModel = record.model
                assistantEndpoint = record.endpoint
            }
        } catch {
            assistantProviderMessage = error.localizedDescription
        }
    }

    private func loadAiGuidance() async {
        do {
            async let prompts = supervisor.loadPromptTemplates()
            async let notation = supervisor.loadNotationProfiles()
            promptConfig = try await prompts
            notationConfig = try await notation
            selectedPromptId = promptConfig?.activeTemplateId ?? promptConfig?.templates.first?.id ?? ""
            selectedNotationProfileId = notationConfig?.profiles.first?.id ?? ""
            selectedNotationRuleId = notationConfig?.profiles.first?.rules.first?.id ?? ""
            guidanceMessage = nil
        } catch {
            guidanceMessage = "AI 规则读取失败：\(error.localizedDescription)"
        }
    }

    private func saveAiGuidance() async {
        guard let promptConfig, let notationConfig else { return }
        isSavingGuidance = true
        defer { isSavingGuidance = false }
        do {
            self.promptConfig = try await supervisor.savePromptTemplates(promptConfig)
            self.notationConfig = try await supervisor.saveNotationProfiles(notationConfig)
            guidanceMessage = "提示词与领域记号已保存，后续识别立即使用。"
        } catch {
            guidanceMessage = "AI 规则保存失败：\(error.localizedDescription)"
        }
    }

    private func addPromptTemplate() {
        var template = MacPromptTemplate.userDraft()
        template.name = "用户模板 \((promptConfig?.templates.count ?? 0) + 1)"
        if promptConfig == nil {
            promptConfig = MacPromptTemplateConfig(activeTemplateId: template.id, templates: [template])
        } else {
            promptConfig?.templates.append(template)
        }
        selectedPromptId = template.id
    }

    private func deleteSelectedPromptTemplate() {
        guard let index = promptConfig?.templates.firstIndex(where: { $0.id == selectedPromptId }),
              promptConfig?.templates[index].locked != true else { return }
        promptConfig?.templates.remove(at: index)
        if promptConfig?.activeTemplateId == selectedPromptId {
            promptConfig?.activeTemplateId = promptConfig?.templates.first?.id ?? ""
        }
        selectedPromptId = promptConfig?.activeTemplateId ?? promptConfig?.templates.first?.id ?? ""
    }

    private func addNotationProfile() {
        var profile = MacNotationProfile.userDraft()
        profile.name = "新领域 \((notationConfig?.profiles.count ?? 0) + 1)"
        if notationConfig == nil {
            notationConfig = MacNotationProfileConfig(schemaVersion: "nh1-v1", revision: 1, profiles: [profile])
        } else {
            notationConfig?.profiles.append(profile)
        }
        selectedNotationProfileId = profile.id
        selectedNotationRuleId = ""
    }

    private func addNotationRule(_ profileIndex: Int) {
        let rule = MacNotationRule.userDraft()
        notationConfig?.profiles[profileIndex].rules.append(rule)
        selectedNotationRuleId = rule.id
    }

    private func previewNotationGuidance() async {
        do {
            notationPreview = try await supervisor.previewNotation(MacNotationPreviewRequest(
                query: notationPreviewQuery,
                profileIds: selectedNotationProfileId.isEmpty ? nil : [selectedNotationProfileId]
            ))
            guidanceMessage = nil
        } catch {
            guidanceMessage = "提示词预览失败：\(error.localizedDescription)"
        }
    }

    @ViewBuilder
    private func hostValueRow<Trailing: View>(
        title: String,
        value: String,
        copyValue: String,
        copyLabel: String,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(spacing: MathNotesTheme.Spacing.standard) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.caption).foregroundStyle(.secondary)
                Text(value).font(.system(.body, design: .monospaced)).textSelection(.enabled)
            }
            Spacer()
            trailing()
            Button(copyLabel) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(copyValue, forType: .string)
                hostCopyMessage = "\(title)已复制"
            }
        }
    }

    private func hostValueRow(
        title: String,
        value: String,
        copyValue: String,
        copyLabel: String
    ) -> some View {
        hostValueRow(
            title: title,
            value: value,
            copyValue: copyValue,
            copyLabel: copyLabel
        ) { EmptyView() }
    }

    @ViewBuilder
    private var companionServeStatus: some View {
        switch supervisor.tailscaleServeState {
        case .idle:
            Label("等待设备连接服务", systemImage: "clock")
                .foregroundStyle(.secondary)
        case .checking:
            HStack {
                ProgressView().controlSize(.small)
                Text("正在确认并自动配置 Mac 的 Tailscale HTTPS 地址")
                    .foregroundStyle(.secondary)
            }
        case let .ready(origin):
            Label("手机地址已就绪 · \(origin)", systemImage: "checkmark.shield")
                .foregroundStyle(MathNotesTheme.accent)
        case let .failed(message):
            Label(message, systemImage: "exclamationmark.triangle")
                .foregroundStyle(MathNotesTheme.warning)
        }
    }

    @ViewBuilder private var assistantProviderStatusLabel: some View {
        if isAssistantWorking || isTestingAssistantProvider {
            ProgressView().controlSize(.small)
        } else if let assistantProviderMessage {
            Text(assistantProviderMessage).font(.callout).foregroundStyle(.secondary)
        } else if supervisor.assistantProviderStatus.configured {
            Label(
                supervisor.assistantProviderStatus.inherited == true
                    ? "继承识别模型 \(supervisor.assistantProviderStatus.model ?? "")"
                    : "已配置 \(supervisor.assistantProviderStatus.model ?? "对话模型")",
                systemImage: "checkmark.circle.fill"
            )
            .font(.callout).foregroundStyle(MathNotesTheme.accent)
        } else if let restorationError = supervisor.assistantProviderRestorationError {
            Label(restorationError.errorDescription, systemImage: "exclamationmark.triangle.fill")
                .font(.callout).foregroundStyle(MathNotesTheme.warning)
        } else {
            Text("尚未配置").font(.callout).foregroundStyle(.secondary)
        }
    }

    private func pairingPayload(_ challenge: CompanionPairingChallenge, port: Int) -> String {
        guard let primary = lanAddressMonitor.recommended else { return challenge.pairingLink }
        return challenge.pairingLink(
            host: primary.address,
            port: port,
            alternateHosts: lanAddressMonitor.addresses.map(\.address)
        )
    }

    private func ensureCompanionPairingChallenge(force: Bool = false) async {
        guard supervisor.companionHost != nil else { return }
        if !force,
           let current = supervisor.companionPairingChallenge,
           let expiry = ISO8601DateFormatter().date(from: current.expiresAt),
           expiry.timeIntervalSinceNow > 30 {
            return
        }
        isRefreshingPairingChallenge = true
        defer { isRefreshingPairingChallenge = false }
        do {
            _ = try await supervisor.createCompanionPairingChallenge()
            hostCopyMessage = nil
        } catch {
            hostCopyMessage = error.localizedDescription
        }
    }

    private func updateCompanionHostToken() async {
        isUpdatingHostToken = true
        hostCopyMessage = nil
        defer { isUpdatingHostToken = false }
        do {
            try await supervisor.updateCompanionHostToken(
                newHostToken,
                confirmation: hostTokenConfirmation
            )
            newHostToken = ""
            hostTokenConfirmation = ""
            revealsHostToken = false
            hostCopyMessage = "新配对令牌已保存；PWA 下次会自动保留电脑地址，只需输入一次新令牌"
        } catch {
            hostCopyMessage = error.localizedDescription
        }
    }

    private func loadCompanionConnection() async {
        companionOrigin = CompanionConnectionPreferences.load()?.origin ?? ""
        let store = KeychainCredentialStore(service: CompanionConnectionCredential.service)
        hasSavedCompanionToken = await Task.detached {
            (try? store.read(account: CompanionConnectionCredential.account))?.isEmpty == false
        }.value
    }

    private func savedOrEnteredCompanionToken(for normalizedOrigin: String) async throws -> String {
        let entered = companionToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if !entered.isEmpty { return entered }
        guard CompanionConnectionPreferences.load()?.origin == normalizedOrigin else {
            throw CompanionConnectionError.tokenRequiredForNewAddress
        }
        let store = KeychainCredentialStore(service: CompanionConnectionCredential.service)
        guard let saved = try await Task.detached(operation: {
            try store.read(account: CompanionConnectionCredential.account)
        }).value, !saved.isEmpty else {
            throw CompanionConnectionError.missingToken
        }
        return saved
    }

    private func saveCompanionConnection() async {
        isCheckingCompanion = true
        companionMessage = nil
        defer { isCheckingCompanion = false }
        do {
            let client = CompanionConnectionClient()
            let normalizedOrigin = try client.normalizeOrigin(companionOrigin)
            let token = try await savedOrEnteredCompanionToken(for: normalizedOrigin)
            try CompanionConnectionPreferences.save(.init(origin: normalizedOrigin))
            if !companionToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let store = KeychainCredentialStore(service: CompanionConnectionCredential.service)
                try await Task.detached(operation: {
                    try store.write(token, account: CompanionConnectionCredential.account)
                }).value
            }
            companionOrigin = normalizedOrigin
            companionToken = ""
            hasSavedCompanionToken = true
            companionMessage = "设备连接已保存"
        } catch {
            companionMessage = error.localizedDescription
        }
    }

    private func checkCompanionConnection() async {
        isCheckingCompanion = true
        companionMessage = nil
        defer { isCheckingCompanion = false }
        do {
            let client = CompanionConnectionClient()
            let normalizedOrigin = try client.normalizeOrigin(companionOrigin)
            let token = try await savedOrEnteredCompanionToken(for: normalizedOrigin)
            let result = try await client.verify(origin: normalizedOrigin, token: token)
            companionMessage = "连接可用 · \(result.targetCount) 个 Session"
        } catch {
            companionMessage = error.localizedDescription
        }
    }

    private func clearCompanionConnection() async {
        isCheckingCompanion = true
        companionMessage = nil
        defer { isCheckingCompanion = false }
        do {
            let store = KeychainCredentialStore(service: CompanionConnectionCredential.service)
            try await Task.detached(operation: {
                try store.delete(account: CompanionConnectionCredential.account)
            }).value
            CompanionConnectionPreferences.clear()
            companionOrigin = ""
            companionToken = ""
            hasSavedCompanionToken = false
            companionMessage = "设备连接已清除"
        } catch {
            companionMessage = error.localizedDescription
        }
    }
}
