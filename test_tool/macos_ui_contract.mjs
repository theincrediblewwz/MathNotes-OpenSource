#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const content = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/ContentView.swift"), "utf8");
const theme = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/MathNotesTheme.swift"), "utf8");
const app = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/MathNotesMacApp.swift"), "utf8");
const appearance = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/AppAppearanceMode.swift"), "utf8");
const macPreferences = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/MacUserPreferences.swift"), "utf8");
const runtimeDiagnostics = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/MacRuntimeDiagnostics.swift"),
  "utf8"
);
const reader = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/ReadonlySessionView.swift"), "utf8");
const assistantWindow = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/SessionAssistantWindow.swift"),
  "utf8"
);
const selectionEditor = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/SelectionAwareTextEditor.swift"),
  "utf8"
);
const localShellClient = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/LocalShellClient.swift"),
  "utf8"
);
const providerSettings = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/ProviderSettingsView.swift"), "utf8");
const providerPreferences = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/ProviderPreferences.swift"), "utf8");
const aiGuidanceModels = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/AiGuidanceModels.swift"), "utf8");
const keychain = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/KeychainCredentialStore.swift"), "utf8");
const companionConnection = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/CompanionConnection.swift"),
  "utf8"
);
const companionReader = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/CompanionReaderStore.swift"),
  "utf8"
);
const companionSession = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/CompanionSessionView.swift"),
  "utf8"
);
const supervisor = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/SidecarSupervisor.swift"), "utf8");
const companionHostAutomation = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/CompanionHostAutomation.swift"),
  "utf8"
);
const companionLanPairing = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/CompanionLanPairing.swift"),
  "utf8"
);
const markdownDrop = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/MarkdownDropSession.swift"),
  "utf8"
);
const nativeContract = await readFile(path.join(root, "test_tool/macos_native_contract.mjs"), "utf8");
const contractTests = await readFile(path.join(root, "apps/macos/ContractTests/main.swift"), "utf8");
const contentStrings = [...content.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((match) => match[1]);
const unsafeRawRecognitionEvent = contractTests
  .split(/\r?\n/)
  .some((line) => /Data\(#".*"delta":"#+/.test(line));
const sourceWorkspaceSection = reader.slice(
  reader.indexOf("private final class SessionSourceWorkspace"),
  reader.indexOf("private struct SessionSourcePane")
);
const sourceBlockSection = reader.slice(
  reader.indexOf("private struct SessionSourceBlockView"),
  reader.indexOf("private struct SessionTransferTarget")
);
const activityHistorySection = reader.slice(
  reader.indexOf("private func compactRecognitionHistoryRow"),
  reader.indexOf("private func load(showLoading")
);

const checks = [
  [content.includes("NavigationSplitView"), "native split-view shell is required"],
  [content.includes('.frame(minWidth: 180)') && content.includes('"workspace-toolbar-title"'), "toolbar title capsule must preserve generous text clearance"],
  [content.includes("hasUnsavedSourceDrafts") && content.includes("放弃并切换"), "session navigation must guard unsaved inline source drafts"],
  [content.includes(".dropDestination(for: URL.self)") && markdownDrop.includes('ext == "md" || ext == "markdown"'), "macOS workspace must accept native md and markdown drops"],
  [markdownDrop.includes("startAccessingSecurityScopedResource") && markdownDrop.includes("maximumBytes = 2 * 1024 * 1024"), "Markdown drops must use security scope and the bounded local write limit"],
  [content.includes("temporaryMarkdownDocuments") && content.includes("MarkdownArchiveSheet") && markdownDrop.includes("尚未归入任何 Notebook"), "unassigned Markdown must stay in an explicit temporary Session until archival"],
  [localShellClient.includes('path: "local/v1/session/markdown"') && localShellClient.includes('path: "local/v1/markdown/preview"'), "macOS Markdown import and temporary preview must use trusted Core routes"],
  [content.includes(".searchable("), "catalog search is required"],
  [content.includes(".accessibilityLabel("), "explicit accessibility labels are required"],
  [content.includes("MathNotesTheme.canvas") && content.includes("MathNotesTheme.sidebar"), "semantic page colors are required"],
  [!content.includes("Color(red:"), "brand RGB values must stay in MathNotesTheme"],
  [!contentStrings.some((value) => /(Node|Sidecar|LocalShell)/.test(value)), "developer runtime terms must not appear in visible strings"],
  [theme.includes(".darkAqua") && theme.includes("dynamicColor"), "theme must provide dynamic light/dark colors"],
  [theme.includes("static let panel: CGFloat = 8"), "panel radius must remain restrained"],
  [theme.includes("#available(macOS 26.0, *)") && theme.includes("glassEffect"), "Liquid Glass must be availability-gated"],
  [theme.includes("accessibilityReduceTransparency") && theme.includes(".regularMaterial"), "control surfaces must honor reduced transparency and old-system fallback"],
  [app.includes(".windowToolbarStyle(.unified"), "unified native toolbar is required"],
  [app.includes(".keyboardShortcut(\"r\""), "refresh keyboard shortcut is required"],
  [app.includes(".preferredColorScheme(appearanceMode.preferredColorScheme)"), "saved appearance must control the native scene"],
  [app.includes("@StateObject private var supervisor = SidecarSupervisor()") &&
    !content.includes(".onDisappear { supervisor.stop() }"),
    "closing the main window must not stop the app-lifetime Companion host"],
  [app.includes("applicationWillTerminate") && app.includes("MacRuntimeDiagnostics.beginLaunch()") &&
    runtimeDiagnostics.includes("previousExitWasClean") &&
    runtimeDiagnostics.includes("recordSessionOpen") &&
    runtimeDiagnostics.includes("lastSessionHash") &&
    runtimeDiagnostics.includes("lastSessionFailureKind") &&
    runtimeDiagnostics.includes("SHA256.hash"),
    "macOS must persist clean-exit, redacted session-stage, failure, and performance diagnostics"],
  [app.includes("Settings {") && content.includes("@Environment(\\.openSettings)"), "settings must use the native macOS Settings scene"],
  [appearance.includes("case system") && appearance.includes("case light") && appearance.includes("case dark"), "system, light, and dark appearance modes are required"],
  [reader.includes("LazyVStack"), "session blocks must use lazy vertical loading"],
  [reader.includes("WKWebView") && reader.includes("PDFView"), "controlled Markdown and native PDF viewers are required"],
  [reader.includes("SessionMarkdownWebView") && reader.includes("isHorizontalGesture"), "Markdown must preserve horizontal overflow while forwarding vertical reading"],
  [!reader.includes(".scrollView"), "macOS WKWebView must not use the iOS-only scrollView API"],
  [reader.includes("FocusablePDFView") && reader.includes("isInternalScrollEnabled"), "PDF scrolling must require explicit focus"],
  [reader.includes("event.keyCode == 53") && reader.includes("PDF 浏览中 · Esc 退出"), "PDF focus must expose an Escape exit contract"],
  [reader.includes("accessibilityReduceMotion") && reader.includes("reduceMotion ? nil"), "focus animations must honor reduced motion"],
  [(reader.match(/\.mathNotesControlSurface\(/g) ?? []).length === 2, "glass surfaces must stay limited to compact controls and transient PDF status"],
  [reader.includes("HSplitView") && reader.includes("geometry.size.width < 760"), "workbench must use a native split view with a bounded compact fallback"],
  [reader.includes("Picker(\"工作区\"") && reader.includes("case source") && reader.includes("case preview"), "compact workbench must expose source and preview modes"],
  [reader.includes("SessionSourceWorkspace") && reader.includes("drafts: [String: String]"), "source drafts must survive pane layout changes outside row lifetime"],
  [reader.includes("if self.revision != revision") &&
    reader.includes("let preserveDraft = isDirty(blockID: block.id)") &&
    reader.includes("store(payload, resetDraft: !preserveDraft)"),
    "revision refresh must keep the last complete projection mounted while preserving only real drafts"],
  [reader.includes("else if manifest.editable, !markdown.blockLocked") && reader.includes("SelectionAwareTextEditor("), "every unlocked editable Markdown block must behave like a normal inline editor"],
  [reader.includes("ScrollViewReader") && reader.includes(".id(block.id)") &&
    !reader.includes("proxy.scrollTo(blockID, anchor: .center)"),
    "source and preview panes must keep stable identities without selection-driven scroll jumps"],
  [reader.includes("StableSessionMarkdownWebView") &&
    reader.includes('controller.add(context.coordinator, name: "blockActivated")') &&
    reader.includes("activeBlockID.wrappedValue = blockID"),
    "the continuous preview must activate the matching source block through one stable bridge"],
  [reader.includes("private var preloadIdentity") && reader.includes("await workspace.load(") &&
    reader.includes("blocks.map(\\.previewIdentity)"),
    "continuous preview blocks must preload by stable block revision without per-row WebView churn"],
  [reader.includes("SessionSourceBlockView") && reader.includes("SelectionAwareTextEditor("), "native inline Markdown block editor is required"],
  [selectionEditor.includes("NSTextViewDelegate") && selectionEditor.includes("textViewDidChangeSelection") &&
    reader.includes("selectedExcerptBlockID"), "native source selection must reach the learning assistant"],
  [selectionEditor.includes("func textDidBeginEditing") &&
    selectionEditor.includes("func textDidChange") &&
    (selectionEditor.match(/onActivate\(\)/g) ?? []).length >= 3,
    "focus, selection, and typing must activate the edited source block"],
  [!selectionEditor.includes("NSScrollView") &&
    selectionEditor.includes("@Binding var contentHeight") &&
    selectionEditor.includes("usedRect(for: textContainer)") &&
    reader.includes("estimatedEditorHeight(") &&
    reader.includes("height: max("),
    "source blocks must grow to their full measured text height without an inner vertical scroller"],
  [sourceWorkspaceSection.includes("@Published private(set) var selectedExcerpt") &&
    sourceWorkspaceSection.includes("func setSelection("),
    "source selection state and mutation must belong to the durable source workspace"],
  [sourceBlockSection.includes("private var selectionBinding") &&
    sourceBlockSection.includes("selectedText: selectionBinding"),
    "selection binding must belong to the editable source block view"],
  [reader.includes("baseRevision") && reader.includes("saveMarkdownBlock"), "controlled save must carry the base revision"],
  [reader.includes(".fileImporter(") && reader.includes("importSessionImage"), "native image import must use the system picker and controlled API"],
  [reader.includes("allowedContentTypes: [.pdf]") && reader.includes("importSessionPdf"), "native PDF import must use the system picker and controlled API"],
  [reader.includes("isImportingImage") && reader.includes("ProgressView"), "image import must expose bounded progress feedback"],
  [reader.includes("RecognitionTaskSheet") && reader.includes("startRecognition"), "image blocks must expose the native recognition task sheet"],
  [reader.includes("afterSequence") && reader.includes("pollGeneration"), "recognition events must resume from a monotonic sequence"],
  [reader.includes("cancelRecognition") && reader.includes("retryRecognition"), "recognition tasks must expose cancel and retry"],
  [reader.includes("monitorRecognitionActivity") &&
    reader.includes('accessibilityIdentifier("session-recognition-activity")') &&
    reader.includes("setRecognitionDraft(") &&
    reader.includes("await load(showLoading: false)"),
    "PWA-created recognition work must appear, stream into preview, and refresh without a manual reload"],
  [localShellClient.includes("func recognitionTasks(") &&
    localShellClient.includes("func recognitionTaskSnapshot(") &&
    supervisor.includes("func recognitionTasks(") &&
    supervisor.includes("func recognitionTaskSnapshot("),
    "the native shell must discover recognition tasks and long-poll activity created by another client"],
  [reader.includes("companionUploadActivityCard") &&
    reader.includes('ProgressView(value: progress)') &&
    reader.includes('accessibilityIdentifier("session-companion-upload-activity")') &&
    localShellClient.includes("local/v1/session/companion-activity") &&
    supervisor.includes("func companionUploadActivity("),
    "PWA uploads must expose real byte progress in the native session workspace"],
  [reader.includes('"重新识别这个块"') && reader.includes("rerunRecognition") &&
    localShellClient.includes("local/v1/session/recognition/rerun"),
    "transcription blocks must expose safe per-block re-recognition"],
  [reader.includes("SessionAssistantPanel") && reader.includes("本轮实际喂给 AI") &&
    reader.includes("第 42 块是什么"), "the native learning assistant must expose exact context and numbered-block semantics"],
  [reader.includes('"明确加入笔记正文"') && reader.includes("promoteSessionAssistant") &&
    reader.includes("deleteSessionAssistant"), "assistant remarks must stay independent until explicit promotion"],
  [localShellClient.includes("local/v1/session/assistant/preview") &&
    localShellClient.includes("local/v1/session/assistant/promote") &&
    localShellClient.includes("local/v1/session/assistant/start") &&
    localShellClient.includes("local/v1/session/assistant/events") &&
    localShellClient.includes("local/v1/session/assistant/cancel") &&
    reader.includes("liveAssistantDraft += appended"),
    "the native assistant must use the trusted loopback API contract"],
  [reader.includes('"session-block-organize-bar"') && reader.includes('"取消全选"') &&
    reader.includes('"复制到"') && reader.includes('"移动到"'),
    "session source workspace must expose multi-select reorder, copy, and move controls"],
  [reader.includes("if isSelectionMode {") &&
    reader.includes('Label("多选内容段", systemImage: "checklist")') &&
    reader.includes('Button("退出多选")'),
    "block selection controls must stay hidden until the title context menu enters selection mode"],
  [localShellClient.includes("ReorderSessionBlocksResponse") &&
    reader.includes("let reordered = try await supervisor.reorderSessionBlocks") &&
    reader.includes("applyManifest(reordered)"),
    "one reorder mutation must return and immediately apply the resulting manifest"],
  [reader.includes("SessionContinuousPreview") &&
    reader.includes("liveRenders") &&
    reader.includes("previewMarkdown") &&
    reader.includes("Keep the last valid live projection mounted") &&
    reader.includes("workspace.drafts[blockID]"),
    "dirty and recognition drafts must drive the shared renderer without falling back to stale placeholder HTML"],
  [reader.includes("window.MathNotes.updateBlocks") &&
    reader.includes("firstVisibleAnchor") &&
    reader.includes("restoreAnchor(anchor)") &&
    reader.includes("node.dataset.version !== block.version"),
    "one preview scroll surface must patch stable block identities while preserving the visible anchor"],
  [reader.includes("WorkbenchDisplayMode") &&
    reader.includes('"进入阅读模式"') &&
    reader.includes('"显示源码"'),
    "wide macOS workspaces must expose a reversible preview-only reading mode"],
  [reader.includes("private func previewActionCluster") &&
    reader.includes('accessibilityIdentifier("session-preview-floating-actions")') &&
    reader.includes(".background(.ultraThinMaterial, in: Capsule())") &&
    reader.includes('Label("导出 Markdown"') &&
    reader.includes('Label("导入图片"') &&
    reader.includes('Label("导入 PDF"'),
    "preview actions must use a compact floating cluster with complete labels inside its overflow menu"],
  [app.includes('Window("学习助手", id: "session-assistant")') &&
    assistantWindow.includes("SessionAssistantPanel(") &&
    reader.includes(".dropDestination(for: String.self)") &&
    reader.includes('.accessibilityLabel("关闭学习助手")') &&
    !reader.includes("AssistantResizableFrame") &&
    !reader.includes("isPresentingAssistant"),
    "the learning assistant must use an independent native window so the note remains interactive"],
  [reader.includes("private var blockHeaderContextMenu") &&
    reader.match(/\.contextMenu\s*\{\s*blockHeaderContextMenu\s*\}/g)?.length === 1 &&
    reader.includes("Button(action: activateHeader)") &&
    reader.includes('Label("重新识别这个块", systemImage: "arrow.clockwise")'),
    "the block title surface must own one stable context menu with re-recognition"],
  [reader.includes('return NSApp.isActive ? .seconds(8) : .seconds(30)') &&
    reader.includes('return .milliseconds(120)') &&
    reader.includes('var appendedDraft = ""') &&
    reader.includes('Task.sleep(for: NSApp.isActive ? .seconds(8) : .seconds(30))') &&
    reader.includes("if companionUploadActivity != upload") &&
    reader.includes("if recentRecognitionTasks != recentTasks") &&
    reader.includes("await load()") &&
    !reader.includes('.task(id: "recognition-activity:'),
    "initial manifest loading must finish before active/foreground-idle/background-idle polling and unchanged state must not be reassigned"],
  [reader.includes('displayOrdinal: index + 1') &&
    reader.includes('Text(String(format: "%04d", displayOrdinal))') &&
    reader.includes('let index = readableBlocks.firstIndex'),
    "visible source and assistant block ordinals must ignore hidden assets and deleted stable identities"],
  [reader.includes('private static var katexStylesheet: String') &&
    reader.includes('String(contentsOf: url, encoding: .utf8)') &&
    reader.includes('<style id="mathnotes-katex-styles">') &&
    reader.includes('\\(katexStylesheet)') &&
    reader.includes('.katex > .katex-html { display: none !important; }') &&
    reader.includes('.katex > .katex-mathml { display: inline !important;') &&
    reader.includes('Bundle.module.url(') &&
    !reader.includes('<link rel="stylesheet" href="katex.min.css">'),
    "macOS continuous reading must inline bundled KaTeX styles and retain a non-overlapping MathML fallback"],
  [reader.includes('TextField("输入问题", text: $question, axis: .vertical)') &&
    reader.includes('question = ""') && reader.includes('assistantRequestTask?.cancel()'),
    "assistant composer must preserve its first line, clear on send, and expose cancellation"],
  [reader.includes('manifest.blocks.filter { $0.renderInNote && $0.type == "markdown" }') &&
    reader.includes("SessionAssetPreviewSheet"),
    "source and continuous reading panes must project Markdown only while related assets stay available from the Markdown title"],
  [reader.includes("StableSessionMarkdownWebView") &&
    reader.includes("view.loadHTMLString(Self.shellDocument") &&
    reader.includes("if desiredBlocks != appliedBlocks") &&
    !reader.slice(
      reader.indexOf("func updateNSView(_ view: WKWebView, context: Context)"),
      reader.indexOf("static func dismantleNSView", reader.indexOf("func updateNSView(_ view: WKWebView, context: Context)"))
    ).includes("loadHTMLString"),
    "the main Markdown preview must load one shell and patch changed blocks without reload-on-selection"],
  [!reader.includes('Text("Markdown 源码")') &&
    !reader.includes('Text("\\(blocks.count) 个内容段 · 只编辑当前块")'),
    "source metadata must stay hidden until multi-select is active"],
  [reader.includes('accessibilityIdentifier("session-activity-toggle")') &&
    reader.includes('accessibilityIdentifier("session-activity-panel")'),
    "receive and recognition activity must expand from one bottom-right activity control"],
  [activityHistorySection.includes(".frame(maxWidth: .infinity)") &&
    !activityHistorySection.includes(".background(.ultraThinMaterial"),
    "activity history rows must stay visually flat inside the single outer rounded popover"],
  [reader.includes("workspace.hasDirtyDrafts") &&
    reader.includes("请先保存或还原源码草稿，再整理内容段"),
    "block organization must be guarded while source drafts are dirty"],
  [reader.includes('Label("删除这个块", systemImage: "trash")') &&
    reader.includes("deleteSessionBlocks(") &&
    reader.includes("onManifestChanged(updated)") &&
    reader.includes('.alert("删除这个内容段？"') &&
    !reader.includes("剩余编号立即按当前顺序重新排列") &&
    localShellClient.includes("local/v1/session/blocks/delete"),
    "block deletion must use a stable user-facing alert and immediately apply the returned authoritative manifest"],
  [reader.includes('"首字 \\(formatDuration(firstOutputMs))"') &&
    reader.includes('"总耗时 \\(formatDuration(providerMs))"'),
    "recognition UI must expose measured first-output and provider duration"],
  [reader.includes("createSessionExport") && reader.includes("downloadSessionExport"), "session export must be generated and downloaded through the shared sidecar"],
  [reader.includes("NSSavePanel") && reader.includes("options: .atomic"), "native export must use the system save panel and atomic destination write"],
  [reader.includes("baseRevision: manifest.revision"), "native export must bind the visible session revision"],
  [!content.includes('Label("刷新目录", systemImage: "arrow.clockwise")') &&
    app.includes('.keyboardShortcut("r"'),
    "automatic synchronization must replace the permanent refresh toolbar while keeping a recovery shortcut"],
  [reader.includes('Button("关闭") { dismiss() }') && !reader.includes('Button("完成") { dismiss() }'),
    "assistant and task panels must use close semantics instead of completion semantics"],
  [reader.includes("interactiveDismissDisabled"), "unsaved editor drafts must resist accidental dismissal"],
  [!reader.includes("DIRECT MARKDOWN"), "developer block labels must not appear in the reader"]
  ,[app.includes("ProviderSettingsView") && content.includes("openSettings()") && content.includes("gearshape"), "native settings must be reachable from the toolbar"]
  ,[providerSettings.includes("Picker(\"界面外观\"") &&
    providerSettings.includes(".onChange(of: appearanceMode)") &&
    providerSettings.includes("saveReadingPreferences()") &&
    !providerSettings.includes("readingMessage"),
    "appearance, typography, opacity, and blur must persist immediately without a reading-settings save footer"]
  ,[providerSettings.includes('LabeledContent("材料透明度")') &&
    providerSettings.includes('LabeledContent("背景模糊度")') &&
    providerSettings.includes("MacMaterialPreferences.save"),
    "appearance settings must expose saved material opacity and blur controls"]
  ,[reader.includes(".frame(width: 30, height: 30)") &&
    reader.includes(".frame(width: 44, height: 44)") &&
    reader.includes("MathNotesMaterialBackground(shape: Circle())"),
    "floating controls must keep a compact visual surface inside a full 44 point hit target"]
  ,[providerSettings.includes("TabView") && providerSettings.includes("Label(\"通用\"") && providerSettings.includes("Label(\"诊断\""), "settings must separate general, reading, provider, and diagnostic categories"]
  ,[providerSettings.includes("NSOpenPanel") && providerSettings.includes("applyNotesRoot") && providerSettings.includes("hasUnsavedSourceDrafts"), "notes root changes must use the system picker and unsaved-edit guard"]
  ,[macPreferences.includes("bookmarkData") && macPreferences.includes("withSecurityScope") && macPreferences.includes("DirectoryPreferenceSnapshot"), "directory preferences must use restorable security-scoped bookmarks"]
  ,[reader.includes("MacPreferenceKeys.sourceFont") && reader.includes("styledPreviewHTML"), "saved typography must reach both source and preview panes"]
  ,[content.includes("guard case .loaded = activeCatalogState else { return }") &&
    content.includes("if let selectedSession, !ids.contains(selectedSession.id)"),
    "temporary catalog loading or failure must not clear the currently open Session"]
  ,[providerSettings.includes("SecureField") && !providerSettings.includes("TextField(\"API 密钥"), "provider API key must use a secure field"]
  ,[keychain.includes("kSecClassGenericPassword") && keychain.includes("SecItemCopyMatching") && keychain.includes("SecItemUpdate"), "provider API key must use the system keychain"]
  ,[supervisor.includes("Task.detached") && supervisor.includes("restoreProviderConfiguration"), "blocking keychain access and startup restore must stay off the main thread"]
  ,[providerPreferences.includes("UserDefaults") && !providerPreferences.includes("apiKey"), "UserDefaults may persist only non-secret provider settings"]
  ,[content.includes("新建 Notebook") && content.includes("新建 Session") && content.includes("creationSheet"), "workspace creation must be available from the native toolbar"]
  ,[providerSettings.includes("Label(\"设备连接\"") && providerSettings.includes("SecureField") && providerSettings.includes("检查连接"), "macOS settings must expose a secure Companion connection workflow"]
  ,[providerSettings.includes("GroupBox(\"本机作为主机\")") && providerSettings.includes("设备连接服务运行中"), "macOS settings must expose its own Companion host status"]
  ,[providerSettings.includes("GroupBox(\"连接其他 MathNotes 主机\")"), "macOS settings must keep remote-host client configuration separate"]
  ,[providerSettings.includes("title: \"局域网地址\"") && providerSettings.includes("一次性配对码") && providerSettings.includes("复制配对链接"), "the local host must expose the exact LAN address and one-time pairing credential that phone users enter"]
  ,[supervisor.includes("CompanionHostAddressPreferences.save(origin)") && companionConnection.includes("mathnotes.companion.host-address.v1") && companionConnection.includes("localOnlyAddress"), "the automatically discovered phone-reachable origin must be validated and persisted separately from loopback"]
  ,[providerSettings.includes("companionHostToken") && providerSettings.includes("String(repeating: \"•\"") && providerSettings.includes("复制令牌"), "the host pairing token must be primary, masked, and copyable"]
  ,[providerSettings.includes("第一次连接手机（3 步）") && providerSettings.includes("iPhone / PWA：") && providerSettings.includes("Android App："), "Mac host settings must teach first-time phone connection in place"]
  ,[providerSettings.includes("iPhone / PWA · 同一 Wi-Fi 或手机热点") && providerSettings.includes("PWA / 手填连接令牌") && providerSettings.includes("局域网地址已可直接打开 PWA"), "Mac host settings must expose the proven LAN PWA route and its masked token"]
  ,[providerSettings.includes("Android App · 扫码连接") && providerSettings.includes("一次性配对码") && providerSettings.includes("Android 局域网配对二维码"), "Mac host settings must keep Android QR as the primary short-lived route"]
  ,[providerSettings.includes("iPhone / PWA · Tailscale HTTPS（高级/远程）") && providerSettings.includes("Tailscale HTTPS 地址") && providerSettings.includes("手机也需进入同一 tailnet"), "Mac host settings must explain the optional remote HTTPS route without configuring it"]
  ,[providerSettings.includes("DisclosureGroup(\"更换长期配对令牌\")") && providerSettings.includes("PWA / 手填连接令牌"), "the long-lived host token must be visible only on demand while token rotation remains collapsed"]
  ,[companionLanPairing.includes("NWPathMonitor") && companionLanPairing.includes("getifaddrs") && companionLanPairing.includes("isRFC1918"), "LAN address discovery must be read-only, path-aware, and limited to RFC1918 addresses"]
  ,[companionLanPairing.includes("CIQRCodeGenerator") && companionLanPairing.includes('URLQueryItem(name: "v", value: "2")') && !companionLanPairing.includes('URLQueryItem(name: "token"'), "LAN QR must use the Android v2 one-time challenge without the legacy token"]
  ,[nativeContract.includes('"CompanionLanPairing.swift"'), "the Apple native contract must compile the LAN pairing helpers"]
  ,[!providerSettings.includes("title: \"本机地址\"") && !providerSettings.includes("旧版长期令牌"), "the host UI must not present internal or legacy-labelled values as phone inputs"]
  ,[providerSettings.includes("不会开启 Mac 互联网共享") && providerSettings.includes("不会启用 Funnel") && providerSettings.includes("若 macOS 询问是否允许传入连接"), "host guidance must state the exact local-network and manual-firewall boundary"]
  ,[companionHostAutomation.includes('arguments: ["serve", "status", "--json"]') && companionHostAutomation.includes('arguments: ["serve", "--bg", Self.expectedProxy]'), "Mac startup must inspect Serve first and only create the expected missing mapping"]
  ,[companionHostAutomation.includes("case .conflict") && companionHostAutomation.includes("throw CompanionHostAutomationError.serveConflict"), "existing conflicting Serve or Funnel configuration must stop automatic mutation"]
  ,[companionHostAutomation.includes("/opt/homebrew/bin/tailscale") && companionHostAutomation.includes("/Applications/Tailscale.app/Contents/MacOS/Tailscale"), "automatic setup must locate both CLI and packaged Mac Tailscale installations"]
  ,[companionHostAutomation.includes('environment["TAILSCALE_BE_CLI"] = "1"'), "packaged macOS Tailscale must be forced into documented CLI mode"]
  ,[supervisor.includes("self.reconcileCompanionServe()") && supervisor.includes("@Published private(set) var companionPublicOrigin"), "sidecar readiness must automatically reconcile and publish the stable Tailscale origin"]
  ,[providerSettings.includes('SecureField("新配对令牌"') && providerSettings.includes('SecureField("再次输入新令牌"') && providerSettings.includes("updateCompanionHostToken"), "custom host tokens must require masked double entry and a controlled restart"]
  ,[companionHostAutomation.includes("minimumLength = 16") && companionHostAutomation.includes("maximumLength = 128") && companionHostAutomation.includes("^[A-Za-z0-9._~-]+$"), "custom host tokens must keep the shared safe-token contract"]
  ,[supervisor.includes("@Published private(set) var companionHost") && supervisor.includes("ready.companionHost") && supervisor.includes("createCompanionPairingChallenge"), "sidecar readiness and the trusted local shell must drive local host pairing UI state"]
  ,[companionConnection.includes("/api/v1/pairing/verify") && companionConnection.includes("URLSession.shared.data"), "Companion connection checks must use the private network API"]
  ,[companionConnection.includes("UserDefaults") && !companionConnection.includes("let token:"), "Companion preferences must not persist a plaintext token"]
  ,[keychain.includes("init(service: String =") && providerSettings.includes("CompanionConnectionCredential.service"), "Companion tokens must use a dedicated Keychain service"]
  ,[providerSettings.includes("tokenRequiredForNewAddress"), "changing Companion origins must require a fresh token"]
  ,[content.includes("WorkspaceSourceMode") && content.includes("笔记来源") && content.includes("CompanionSessionView"), "macOS must expose explicit local and Companion reader sources"]
  ,[content.includes("sourceMode != .local") && content.includes("远程笔记在当前版本中保持只读"), "Companion mode must keep workspace creation disabled"]
  ,[companionConnection.includes("/api/v2/companion/session/manifest") && companionConnection.includes("/api/v2/companion/session/document") && companionConnection.includes("/api/v1/companion/asset"), "Companion reader must use the versioned manifest, document, and asset routes"]
  ,[companionReader.includes("KeychainCredentialStore(service: CompanionConnectionCredential.service)") && !companionReader.includes("UserDefaults.standard.string"), "remote reads must reuse the dedicated Keychain token"]
  ,[companionReader.includes("documentLengthMismatch") && companionReader.includes("manifest.revision"), "remote document reads must verify revision and UTF-8 byte lengths"]
  ,[companionReader.includes("mathnotes-companion-asset://") && companionReader.includes("base64EncodedString"), "remote HTML must replace controlled asset references without granting arbitrary network access"]
  ,[companionSession.includes("allowsContentJavaScript = false") && companionSession.includes("websiteDataStore = .nonPersistent()"), "remote reading web views must disable scripts and persistent web storage"]
  ,[companionSession.includes("正在读取远程笔记") && companionSession.includes("正文已就绪 · 素材同步中"), "remote reading must expose body-first progress"]
  ,[reader.includes("MarkdownConflictResolutionSheet") && reader.includes("比较冲突版本"), "durable conflicts must expose a native comparison sheet"]
  ,[reader.includes("保留当前") && reader.includes("采用来稿") && reader.includes("保存合并"), "conflict resolution must require an explicit user choice"]
  ,[reader.includes("fetchMarkdownConflict") && reader.includes("resolveMarkdownConflict"), "the native shell must use shared Core conflict APIs"]
  ,[contractTests.includes("JSONSerialization.data(withJSONObject: eventPayload)"), "recognition event fixtures must use structured JSON serialization"]
  ,[providerPreferences.includes("ProviderPurpose") && providerPreferences.includes("assistant.settings.v1") && !providerPreferences.includes("let apiKey"), "recognition and dialogue provider preferences must stay independent and secret-free"]
  ,[supervisor.includes("assistantProviderStatus") && supervisor.includes("restoreProviderConfiguration(.assistant") && supervisor.includes("keychainAccount"), "Mac assistant calls must restore an independent keychain-backed dialogue provider"]
  ,[providerSettings.includes('GroupBox("学习助手对话")') && providerSettings.includes("恢复继承识别模型") && providerSettings.includes("保存对话模型"), "Mac settings must expose an independent dialogue model with recognition fallback"]
  ,[providerPreferences.includes('case deepSeek = "deepseek"') && providerPreferences.includes("options(for purpose:") && providerPreferences.includes("supportsRecognition"), "Mac provider presets must include DeepSeek for dialogue without advertising it for recognition"]
  ,[providerSettings.includes('GroupBox("识别提示词模板")') && providerSettings.includes('GroupBox("领域记号基准")') && providerSettings.includes("只有已批准规则会进入识别上下文"), "Mac settings must expose prompt templates and approved notation rules"]
  ,[aiGuidanceModels.includes("MacPromptTemplateConfig") && aiGuidanceModels.includes("MacNotationProfileConfig") && localShellClient.includes("local/v1/ai/notation-preview") && supervisor.includes("saveNotationProfiles"), "Mac AI guidance must use the trusted Core contract rather than local-only decorative state"]
  ,[macPreferences.includes("assistantFontSize") && providerSettings.includes('Text("AI 回答")') && reader.includes("styledAssistantHTML"), "Mac settings must apply answer font and size to stored and live assistant output"]
  ,[app.includes('Window("学习助手", id: "session-assistant")') && app.includes(".windowResizability(.contentMinSize)") && app.includes(".windowStyle(.hiddenTitleBar)"), "Mac assistant must use an independent resizable window with one MathNotes title layer"]
  ,[assistantWindow.includes("AssistantWindowChromeConfigurator") && assistantWindow.includes(".fullSizeContentView") && assistantWindow.includes("titlebarSeparatorStyle = .none") && assistantWindow.includes(".ignoresSafeArea(.container, edges: .top)") && assistantWindow.includes("performDrag(with: event)") && reader.includes("AssistantWindowDragSurface"), "Mac assistant custom header must fill and move the independent window without a duplicate native title strip or replacing native edge resizing"]
  ,[reader.includes("activitySequence") &&
    reader.includes("waitMilliseconds: shouldLongPoll ? 20_000 : 0") &&
    localShellClient.includes('URLQueryItem(name: "afterActivitySequence"') &&
    localShellClient.includes('URLQueryItem(name: "waitMs"') &&
    supervisor.includes("recognitionTaskSnapshot"),
    "Mac idle recognition monitoring must use a loopback long poll instead of an eight-second blind interval"]
  ,[assistantWindow.includes("SessionAssistantWindowCoordinator") && assistantWindow.includes("minWidth: 420") && !reader.includes("AssistantResizableFrame") && !reader.includes("isPresentingAssistant"), "Mac assistant must stay independent from the main view overlay and custom resize handles"]
  ,[(providerSettings.match(/Button\("测试连通"\)/g) ?? []).length === 2 && providerSettings.includes("可能产生少量计费") && providerSettings.includes("不会在后台自动测试"), "Mac provider cards must expose explicit one-request connectivity tests with billing disclosure"]
  ,[providerSettings.includes("supervisor.providerRestorationError") && providerSettings.includes("supervisor.assistantProviderRestorationError"), "Mac provider cards must distinguish saved restoration failures from unconfigured state"]
  ,[reader.includes("recognitionActivityDetail(task)") && reader.includes("task.error?.trimmingCharacters") && reader.includes(".lineLimit(2)"), "Mac recognition activity must show a concise terminal failure reason"]
  ,[!unsafeRawRecognitionEvent, "Markdown headings must not terminate single-hash Swift raw JSON fixtures"]
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`MACOS_UI_CONTRACT_FAIL ${failure}\n`);
  process.exit(1);
}
console.log(`MACOS_UI_CONTRACT_OK checks=${checks.length}`);
