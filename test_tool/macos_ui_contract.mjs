#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const content = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/ContentView.swift"), "utf8");
const notebookBrowser = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/MacNotebookBrowser.swift"),
  "utf8"
);
const recentReading = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/MacRecentReadingStore.swift"),
  "utf8"
);
const theme = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/MathNotesTheme.swift"), "utf8");
const app = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/MathNotesMacApp.swift"), "utf8");
const appearance = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/AppAppearanceMode.swift"), "utf8");
const macPreferences = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/MacUserPreferences.swift"), "utf8");
const runtimeDiagnostics = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/MacRuntimeDiagnostics.swift"),
  "utf8"
);
const reader = await readFile(path.join(root, "apps/macos/Sources/MathNotesMac/ReadonlySessionView.swift"), "utf8");
const imageEditor = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/MacImageAnnotationEditor.swift"),
  "utf8"
);
const imageEditingModels = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/MacImageEditingModels.swift"),
  "utf8"
);
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
const localShellServer = await readFile(
  path.join(root, "packages/core-server/src/api/localShellServer.ts"),
  "utf8"
);
const capabilityPolicy = await readFile(
  path.join(root, "packages/core-server/src/api/capabilityPolicy.ts"),
  "utf8"
);
const sessionEditService = await readFile(
  path.join(root, "packages/core-server/src/session/sessionEditService.ts"),
  "utf8"
);
const sessionBlockOrganizer = await readFile(
  path.join(root, "packages/core-server/src/session/sessionBlockOrganizeService.ts"),
  "utf8"
);
const sessionImageImporter = await readFile(
  path.join(root, "packages/core-server/src/session/sessionImageImportService.ts"),
  "utf8"
);
const pdfRecognitionBatch = await readFile(
  path.join(root, "packages/core-server/src/session/sessionPdfRecognitionBatchService.ts"),
  "utf8"
);
const macosSidecar = await readFile(
  path.join(root, "packages/core-server/src/sidecar/macosSidecar.ts"),
  "utf8"
);
const notesBackup = await readFile(
  path.join(root, "packages/core-server/src/backup/notesBackup.ts"),
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
const phoneConnection = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/PhoneConnectionSheet.swift"),
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
const selectionEditBlockSection = reader.slice(
  reader.indexOf("private var hasEditableSelection"),
  reader.indexOf("private struct MacSelectionEditDraft")
);
const selectionEditSheetSection = reader.slice(
  reader.indexOf("struct MacSelectionEditWorkspace"),
  reader.indexOf("private struct SessionTransferTarget")
);
const imageImportClientSection = localShellClient.slice(
  localShellClient.indexOf("func importSessionImage("),
  localShellClient.indexOf("func stagePdfRecognitionPage(")
);
const pdfImportClientSection = localShellClient.slice(
  localShellClient.indexOf("func importSessionPdf("),
  localShellClient.indexOf("func startRecognition(")
);
const sidecarProtocol = await readFile(
  path.join(root, "apps/macos/Sources/MathNotesMac/SidecarProtocol.swift"),
  "utf8"
);
const sidebarBodySection = content.slice(
  content.indexOf("NavigationSplitView"),
  content.indexOf("private var sidebarHeader")
);
const networkRouteSection = capabilityPolicy.slice(
  capabilityPolicy.indexOf("export const NETWORK_API_ROUTES"),
  capabilityPolicy.indexOf("export const LOCAL_SHELL_API_ROUTES")
);
const localRouteSection = capabilityPolicy.slice(
  capabilityPolicy.indexOf("export const LOCAL_SHELL_API_ROUTES"),
  capabilityPolicy.indexOf("const routeByRequest")
);
const supervisorStartSection = supervisor.slice(
  supervisor.indexOf("func start()"),
  supervisor.indexOf("func retry()")
);
const savedProviderMetadataSection = supervisor.slice(
  supervisor.indexOf("func hasSavedProviderConfiguration"),
  supervisor.indexOf("func configureProvider")
);

const checks = [
  [content.includes("NavigationSplitView"), "native split-view shell is required"],
  [content.includes('.frame(minWidth: 180)') && content.includes('"workspace-toolbar-title"'), "toolbar title capsule must preserve generous text clearance"],
  [content.includes("hasUnsavedSourceDrafts") && content.includes("放弃并切换"), "session navigation must guard unsaved inline source drafts"],
  [content.includes(".dropDestination(for: URL.self)") && markdownDrop.includes('ext == "md" || ext == "markdown"'), "macOS workspace must accept native md and markdown drops"],
  [markdownDrop.includes("startAccessingSecurityScopedResource") && markdownDrop.includes("maximumBytes = 2 * 1024 * 1024"), "Markdown drops must use security scope and the bounded local write limit"],
  [content.includes("temporaryMarkdownDocuments") && content.includes("MarkdownArchiveSheet") && markdownDrop.includes("尚未归入任何 Notebook"), "unassigned Markdown must stay in an explicit temporary Session until archival"],
  [localShellClient.includes('path: "local/v1/session/markdown"') && localShellClient.includes('path: "local/v1/markdown/preview"'), "macOS Markdown import and temporary preview must use trusted Core routes"],
  [notebookBrowser.includes('TextField("搜索 Notebook 或 Session"') &&
    notebookBrowser.includes("localizedCaseInsensitiveContains"),
    "the Notebook browser must search Notebook and Session titles"],
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
  [reader.includes(".fileImporter(") && reader.includes("importSessionEditedImage"), "native image import must use the system picker and controlled API"],
  [reader.includes("allowedContentTypes: [.pdf]") && reader.includes("importSessionPdf"), "native PDF import must use the system picker and controlled API"],
  [reader.includes("PdfImportOptionsSheet") &&
    reader.includes('case readOnly') && reader.includes('case recognizeSelected') && reader.includes('case recognizeAll') &&
    reader.includes('case currentSession') && reader.includes('case newSession') &&
    reader.includes('Text("2（推荐）").tag(2)') && reader.includes('Text("4").tag(4)'),
    "native PDF import must expose read-only, page-range, all-page, destination, and bounded-concurrency choices"],
  [reader.includes("renderPdfPagePNG") &&
    reader.includes("stagePdfRecognitionPage") && reader.includes("startPdfRecognitionBatch") &&
    localShellClient.includes('path: "local/v1/session/pdf-recognition/page"') &&
    localShellClient.includes('path: "local/v1/session/pdf-recognition/start"'),
    "selected PDF pages must be rendered locally, staged, and started through trusted Core routes"],
  [!imageImportClientSection.includes("pageCount") &&
    pdfImportClientSection.includes("pageCount: Int") &&
    pdfImportClientSection.includes('URLQueryItem(name: "pageCount", value: String(pageCount))') &&
    reader.includes("width: CGFloat(width)") && reader.includes("height: CGFloat(height)"),
    "PDFKit page count and bitmap dimensions must stay attached to PDF import rather than image import"],
  [reader.includes("pdfRecognitionBatchCard") &&
    reader.includes('controlPdfRecognition("pause"') &&
    reader.includes('controlPdfRecognition("resume"') &&
    reader.includes('controlPdfRecognition("cancel"'),
    "PDF recognition batches must expose progress plus pause, resume, and cancel controls"],
  [reader.includes("manifest.blocks.filter(\\.renderInNote)"),
    "the rendered note must include every visible block type, not Markdown alone"],
  [localRouteSection.includes('path: "/local/v1/session/pdf-recognition/page", capability: "local.workspace.manage"') &&
    localRouteSection.includes('path: "/local/v1/session/pdf-recognition/start", capability: "local.workspace.manage"') &&
    !networkRouteSection.includes("/session/pdf-recognition") &&
    pdfRecognitionBatch.includes("preparePdfBatch") && pdfRecognitionBatch.includes("currentConcurrency") &&
    pdfRecognitionBatch.includes("pauseRequested") && pdfRecognitionBatch.includes("cancelRequested"),
    "PDF batch recognition and its adaptive scheduler must remain on the trusted local host"],
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
  [reader.includes("SessionAssistantPanel") && reader.includes("SessionAssistantScope") &&
    reader.includes("第 42 块是什么") && !reader.includes('compactContextBudget\n            }'),
    "the native AI conversation must keep exact scope semantics without exposing context-budget internals"],
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
    reader.includes('Label("编辑并插入图片"') &&
    reader.includes('Label("导入 PDF"'),
    "preview actions must use a compact floating cluster with complete labels inside its overflow menu"],
  [reader.includes("MacImageAnnotationEditor(") &&
    reader.includes("prepareImageEdit") &&
    reader.includes("commitImageEdit") &&
    reader.includes("imageEditDraft") &&
    imageEditor.includes('accessibilityIdentifier("mac-image-annotation-editor")'),
    "Mac image import must open the native editor before committing a note block"],
  [["case perspective", "case crop", "case lasso", "case pen", "case arrow"].every((token) => imageEditor.includes(token)) &&
    imageEditor.includes('compactButton("左转"') &&
    imageEditor.includes('compactButton("右转"') &&
    imageEditor.includes('Label("应用当前操作"') &&
    imageEditor.includes('Text(isApplying ? "正在保存…" : "插入图片")'),
    "Mac image editor must expose Windows-equivalent perspective, crop, lasso, annotation, rotation, apply, and insert tools"],
  [imageEditor.includes('CIFilter(name: "CIPerspectiveCorrection")') &&
    imageEditor.includes("lassoCropped") &&
    imageEditor.includes("annotated(image") &&
    imageEditor.includes("CGImageDestinationCreateWithData") &&
    imageEditor.includes("CGImageDestinationFinalize"),
    "Mac image editor tools must render a real derived PNG rather than remain visual-only controls"],
  [localShellClient.includes('path: "local/v1/session/image/edit"') &&
    localShellClient.includes('contentType: "multipart/form-data; boundary=') &&
    supervisor.includes("func importSessionEditedImage(") &&
    macosSidecar.includes("importSessionEditedImage: (input) => sessionImageImporter.importEditedImage(input)"),
    "edited image source, output, and metadata must flow through one authenticated local sidecar commit"],
  [localRouteSection.includes('path: "/local/v1/session/image/edit", capability: "local.workspace.manage"') &&
    !networkRouteSection.includes("/session/image/edit") &&
    sessionImageImporter.includes("sourceAssetPath") &&
    sessionImageImporter.includes("metadataPath") &&
    sessionImageImporter.includes("assertValidImageTransformSidecar(sidecar)") &&
    sessionImageImporter.includes("baseRevision !== sessionManifestRevision(session)"),
    "edited image writes must remain local-only, revision-bound, original-preserving, and sidecar-audited"],
  [imageEditingModels.includes("MacImageEditMetadata") &&
    imageEditingModels.includes("contractOrder") &&
    contractTests.includes("image operations were not contract ordered") &&
    contractTests.includes("edited image multipart client contract"),
    "Mac transform metadata and multipart transport must remain covered by the native contract"],
  [app.includes('Window("与笔记对话", id: "session-assistant")') &&
    assistantWindow.includes("SessionAssistantPanel(") &&
    reader.includes(".dropDestination(for: String.self)") &&
    reader.includes('.accessibilityLabel("关闭与笔记对话")') &&
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
    reader.includes("onBlockDeleted(response)") &&
    reader.includes('.alert("删除这个内容段？"') &&
    reader.includes('accessibilityIdentifier("session-block-delete-undo")') &&
    reader.includes('.keyboardShortcut("z", modifiers: .command)') &&
    !reader.includes("剩余编号立即按当前顺序重新排列") &&
    localShellClient.includes("local/v1/session/blocks/delete"),
    "block deletion must use a stable confirmation, immediately apply the manifest, and expose visible native undo"],
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
  ,[app.includes("ProviderSettingsView") && content.includes("sidebarSettingsAction") &&
    content.includes('Label("设置", systemImage: "gearshape")'),
    "native settings must be directly reachable above recent reading in the sidebar"]
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
  ,[providerSettings.includes("TabView") && providerSettings.includes("Label(\"通用\"") &&
    providerSettings.includes("Label(\"编辑与阅读\"") &&
    !providerSettings.includes('.tabItem { Label("诊断"'),
    "ordinary settings must keep user categories while hiding developer diagnostics"]
  ,[providerSettings.includes("NSOpenPanel") && providerSettings.includes("applyNotesRoot") && providerSettings.includes("hasUnsavedSourceDrafts"), "notes root changes must use the system picker and unsaved-edit guard"]
  ,[macPreferences.includes("bookmarkData") && macPreferences.includes("withSecurityScope") && macPreferences.includes("DirectoryPreferenceSnapshot"), "directory preferences must use restorable security-scoped bookmarks"]
  ,[reader.includes("MacPreferenceKeys.sourceFont") && reader.includes("styledPreviewHTML"), "saved typography must reach both source and preview panes"]
  ,[content.includes("guard case .loaded = activeCatalogState else { return }") &&
    content.includes("if let selectedSession, !ids.contains(selectedSession.id)"),
    "temporary catalog loading or failure must not clear the currently open Session"]
  ,[providerSettings.includes("SecureField") && !providerSettings.includes("TextField(\"API 密钥"), "provider API key must use a secure field"]
  ,[keychain.includes("kSecClassGenericPassword") && keychain.includes("SecItemCopyMatching") && keychain.includes("SecItemUpdate"), "provider API key must use the system keychain"]
  ,[keychain.includes("kSecUseAuthenticationUI") && keychain.includes("kSecUseAuthenticationUISkip"), "automatic Keychain reads must never present a macOS authentication dialog"]
  ,[!supervisorStartSection.includes("KeychainCredentialStore") &&
    !supervisorStartSection.includes("CompanionHostCredential") &&
    supervisor.includes("CompanionHostTokenStore()"),
    "phone-host startup and token rotation must not depend on a legacy Keychain ACL"]
  ,[supervisor.includes("Task.detached") && supervisor.includes("restoreProviderConfiguration") &&
    !supervisorStartSection.includes("restoreProviderConfiguration") &&
    !supervisorStartSection.includes("keychainAccount") &&
    savedProviderMetadataSection.includes("ProviderPreferences.load") &&
    !savedProviderMetadataSection.includes("KeychainCredentialStore") &&
    !savedProviderMetadataSection.includes(".read("),
    "app startup and saved-configuration labels must not read provider secrets from Keychain"]
  ,[providerPreferences.includes("UserDefaults") && !providerPreferences.includes("apiKey"), "UserDefaults may persist only non-secret provider settings"]
  ,[content.includes("新建 Notebook") && content.includes("新建 Session") && content.includes("creationSheet") &&
    notebookBrowser.includes("onCreateNotebook") && notebookBrowser.includes("onCreateSession"),
    "workspace creation must be available from the native Notebook browser"]
  ,[sidebarBodySection.includes("sidebarPhoneConnectionAction") &&
    sidebarBodySection.includes("sidebarSettingsAction") &&
    sidebarBodySection.includes("recentReadingSidebar") &&
    sidebarBodySection.includes("notebookBrowserAction") &&
    sidebarBodySection.indexOf("sidebarPhoneConnectionAction") < sidebarBodySection.indexOf("sidebarSettingsAction") &&
    sidebarBodySection.indexOf("sidebarSettingsAction") < sidebarBodySection.indexOf("recentReadingSidebar") &&
    sidebarBodySection.indexOf("recentReadingSidebar") < sidebarBodySection.indexOf("notebookBrowserAction") &&
    !sidebarBodySection.includes("coreStatus"),
    "the sidebar must present phone connection, Settings, recent reading, then Open Notebooks without developer core status"]
  ,[content.includes('Text("连接手机")') && content.includes('Text("显示二维码，让 Android 扫码")') &&
    content.includes('accessibilityIdentifier("sidebar-phone-connection")') && content.includes("PhoneConnectionSheet("),
    "phone connection must be a prominent first-level sidebar action that opens a focused sheet"]
  ,[phoneConnection.includes('accessibilityIdentifier("phone-pairing-qr")') &&
    phoneConnection.includes("CompanionPairingQRCode.image") &&
    phoneConnection.includes("challenge.pairingLink(") &&
    phoneConnection.includes("alternateHosts: allPairingAddresses") &&
    phoneConnection.includes("transport: endpoint.route.transport"),
    "the focused phone sheet must render a real QR code for the selected LAN or Tailscale route"]
  ,[phoneConnection.includes("正在准备手机连接") && phoneConnection.includes("正在生成二维码") &&
    phoneConnection.includes("正在检测连接网络") && phoneConnection.includes("还没有可用的连接网络") &&
    phoneConnection.includes("二维码只包含一次性配对信息"),
    "the focused phone sheet must explain host startup, generation, no-network, and ready states"]
  ,[phoneConnection.includes('accessibilityIdentifier("phone-connection-route-picker")') &&
    phoneConnection.includes('case .tailnet: "Tailscale"') &&
    phoneConnection.includes("tailnetAddress = try await coordinator.readIPv4Address()") &&
    phoneConnection.includes("手机也需登录同一 Tailscale 网络"),
    "the focused phone sheet must prefer a discovered Tailscale route while allowing an explicit LAN choice"]
  ,[supervisorStartSection.includes("Task.sleep(for: .seconds(15))") &&
    supervisorStartSection.includes('self.state = .failed("本机连接服务启动超时') &&
    phoneConnection.includes('case let .failed(message)') &&
    phoneConnection.includes('Button("重试")') &&
    phoneConnection.includes('accessibilityIdentifier("phone-connection-failed")'),
    "sidecar startup must time out into an actionable phone-connection failure instead of spinning forever"]
  ,[phoneConnection.includes("ProviderSettingsSection.select(.companion)") &&
    providerSettings.includes("TabView(selection: selectedSection)") &&
    providerSettings.includes(".tag(ProviderSettingsSection.companion)"),
    "more connection settings must deep-link directly to the Device Connection tab"]
  ,[/recentReadingSidebar\s*\.frame\(maxWidth: \.infinity, maxHeight: \.infinity\)/.test(sidebarBodySection),
    "local, remote, loading, empty, and failure states must all keep the sidebar at full height"]
  ,[content.includes('Label("打开 Notebooks", systemImage: "folder")') &&
    content.includes("MacNotebookBrowser(") &&
    notebookBrowser.includes('Image(systemName: "folder.fill")') &&
    notebookBrowser.includes("LazyVGrid") &&
    content.includes("beginCreationAfterBrowserDismiss") &&
    content.includes("await Task.yield()"),
    "Notebook selection must use a dedicated large-folder browser"]
  ,[notebookBrowser.includes(".onHover") && notebookBrowser.includes(".popover(") &&
    notebookBrowser.includes("loadPreview") && notebookBrowser.includes("fetchSessionManifest") &&
    notebookBrowser.includes("companionReader.loadDocument"),
    "hovering a Session must preview rendered source for local and connected-computer notes"]
  ,[recentReading.includes("mathnotes.recent-reading.v1") &&
    recentReading.includes("maximumStoredCount = 24") &&
    recentReading.includes("sidebarCount = 4") &&
    recentReading.includes("entries.filter { $0.id != next.id }") &&
    content.includes("MacRecentReadingStore.recording"),
    "recent reading must be bounded, deduplicated, persisted, and updated on open"]
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
  ,[companionLanPairing.includes('case tailnetHTTP = "tailnet_http"') && companionLanPairing.includes("transport.rawValue") &&
    companionHostAutomation.includes('arguments: ["ip", "-4"]') && companionHostAutomation.includes("isTailnetIPv4"),
    "Mac Tailscale QR discovery must be read-only and reuse the Android tailnet_http pairing contract"]
  ,[nativeContract.includes('"CompanionLanPairing.swift"'), "the Apple native contract must compile the LAN pairing helpers"]
  ,[!providerSettings.includes("title: \"本机地址\"") && !providerSettings.includes("旧版长期令牌"), "the host UI must not present internal or legacy-labelled values as phone inputs"]
  ,[providerSettings.includes("不会开启 Mac 互联网共享") && providerSettings.includes("不会启用 Funnel") && providerSettings.includes("若 macOS 询问是否允许传入连接"), "host guidance must state the exact local-network and manual-firewall boundary"]
  ,[companionHostAutomation.includes('arguments: ["serve", "status", "--json"]') &&
    !companionHostAutomation.includes('arguments: ["serve", "--bg"') &&
    providerSettings.includes('Button("检查已有 Tailscale 地址")') &&
    !supervisorStartSection.includes("inspectCompanionServe"),
    "Mac startup must not invoke or mutate Tailscale; an explicit Settings action may inspect existing Serve state"]
  ,[companionHostAutomation.includes("case .conflict") && companionHostAutomation.includes("throw CompanionHostAutomationError.serveConflict"), "existing conflicting Serve or Funnel configuration must stop automatic mutation"]
  ,[companionHostAutomation.includes("/opt/homebrew/bin/tailscale") && companionHostAutomation.includes("/Applications/Tailscale.app/Contents/MacOS/Tailscale"), "read-only discovery must locate both CLI and packaged Mac Tailscale installations"]
  ,[companionHostAutomation.includes('environment["TAILSCALE_BE_CLI"] = "1"'), "packaged macOS Tailscale must be forced into documented CLI mode"]
  ,[supervisor.includes("func inspectCompanionServe()") && supervisor.includes("@Published private(set) var companionPublicOrigin") &&
    providerSettings.includes("不会自动配置 Tailscale"),
    "an explicit read-only inspection may publish an existing Tailscale origin without startup-side network mutation"]
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
  ,[supervisor.includes("assistantProviderStatus") &&
    supervisor.includes("providerConnection(.assistant)") &&
    supervisor.includes("ProviderPreferences.load(.assistant) == nil") &&
    supervisor.includes("try await ensureProviderConfiguration(.recognition") &&
    supervisor.includes("keychainAccount"),
    "Mac assistant calls must lazily restore an independent keychain-backed model with recognition fallback"]
  ,[providerSettings.includes('GroupBox("与笔记对话")') && providerSettings.includes("恢复继承识别模型") && providerSettings.includes("保存对话模型"), "Mac settings must expose an independent dialogue model with recognition fallback"]
  ,[providerPreferences.includes('case deepSeek = "deepseek"') && providerPreferences.includes("options(for purpose:") && providerPreferences.includes("supportsRecognition"), "Mac provider presets must include DeepSeek for dialogue without advertising it for recognition"]
  ,[providerSettings.includes('GroupBox("识别提示词模板")') && providerSettings.includes('GroupBox("领域记号基准")') && providerSettings.includes("只有已批准规则会进入识别上下文"), "Mac settings must expose prompt templates and approved notation rules"]
  ,[aiGuidanceModels.includes("MacPromptTemplateConfig") && aiGuidanceModels.includes("MacNotationProfileConfig") && localShellClient.includes("local/v1/ai/notation-preview") && supervisor.includes("saveNotationProfiles"), "Mac AI guidance must use the trusted Core contract rather than local-only decorative state"]
  ,[macPreferences.includes("assistantFontSize") && providerSettings.includes('Text("AI 回答")') && reader.includes("styledAssistantHTML"), "Mac settings must apply answer font and size to stored and live assistant output"]
  ,[app.includes('Window("与笔记对话", id: "session-assistant")') && app.includes(".windowResizability(.contentMinSize)") && app.includes(".windowStyle(.hiddenTitleBar)"), "Mac assistant must use an independent resizable window with one MathNotes title layer"]
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
  ,[selectionEditSheetSection.includes('Button(proposal == nil ? "生成修改候选" : "重新生成")') &&
    selectionEditSheetSection.includes("replacementMarkdown") &&
    selectionEditSheetSection.includes("onGenerate(") &&
    localShellClient.includes("local/v1/session/selection-edit") &&
    localShellClient.includes("ProposeSelectionEditRequest(") &&
    localShellClient.includes("from: selection.from") &&
    localShellClient.includes("to: selection.to") &&
    localShellClient.includes("selectedText: selectedText") &&
    localShellClient.includes("instruction: instruction"),
    "AI candidate generation must pass exact UTF-16 selection and text through the trusted loopback route"]
  ,[selectionEditSheetSection.includes('Button(proposal == nil ? "生成修改候选" : "重新生成")') &&
    selectionEditSheetSection.includes("proposal?.id") &&
    reader.includes("if let replacingProposalID") &&
    reader.includes("cancelSelectionEdit(session, proposalId: replacingProposalID)"),
    "regenerating an AI candidate must supersede and cancel the previous proposal"]
  ,[selectionEditSheetSection.includes('Button(requiresUnlock ? "重试" : "应用修改")') &&
    selectionEditSheetSection.includes("原文不会自动改变；确认修改后才会写入笔记。") &&
    reader.includes("replacementMarkdown: replacementMarkdown") &&
    reader.includes("sourceWorkspace.applyAISelectionEdit(response.result.block)") &&
    localShellClient.includes("local/v1/session/selection-edit/apply"),
    "AI replacements must require explicit apply and write through the shared apply route"]
  ,[selectionEditSheetSection.includes('Button("取消")') &&
    selectionEditSheetSection.includes("try await onCancel(proposal)") &&
    reader.includes("supervisor.cancelSelectionEdit(session, proposalId: proposal.id)") &&
    localShellClient.includes("local/v1/session/selection-edit/cancel"),
    "AI selection edits must expose explicit cancellation of the current proposal"]
  ,[selectionEditSheetSection.includes("Keep the proposal visible so a revision conflict never destroys the user's candidate.") &&
    selectionEditSheetSection.includes(".interactiveDismissDisabled(true)") &&
    reader.includes("原笔记没有被覆盖。请选择明确结果，冲突证据会继续保留。"),
    "apply conflicts must keep the AI proposal and original note evidence intact"]
  ,[assistantWindow.includes("SessionAssistantSelectionEditContext") &&
    reader.includes("selectionEditContext: SessionAssistantSelectionEditContext?") &&
    reader.includes("MacSelectionEditWorkspace(") &&
    reader.includes("isEditingSelection = true") &&
    !reader.includes(".sheet(item: $selectionEditDraft)"),
    "AI selection editing must stay inside the independent conversation window"]
  ,[selectionEditSheetSection.indexOf('title: "原文"') < selectionEditSheetSection.indexOf('Text("修改后")') &&
    selectionEditSheetSection.includes("TextEditor(text: $replacementMarkdown)") &&
    selectionEditSheetSection.includes("可以继续编辑") &&
    !selectionEditSheetSection.includes("UTF-16") &&
    !selectionEditSheetSection.includes("providerName"),
    "selection editing must show a vertical original-to-editable-result comparison without developer metadata"]
  ,[localShellClient.includes("replacementMarkdown: String? = nil") &&
    localShellClient.includes("retryAfterUnlock: Bool = false") &&
    localShellServer.includes("replacementMarkdown: body.replacementMarkdown") &&
    localShellServer.includes("retryAfterUnlock: body.retryAfterUnlock") &&
    localShellServer.includes("optionalBoundedText(body.replacementMarkdown, 12_000)") &&
    localShellServer.includes('typeof body.retryAfterUnlock === "boolean"') &&
    supervisor.includes("retryAfterUnlock: retryAfterUnlock") &&
    selectionEditSheetSection.includes("isSelectionEditLockConflict") &&
    selectionEditSheetSection.includes('Button("去解锁")') &&
    selectionEditSheetSection.includes("修改候选会保留") &&
    reader.includes("revealSelectionLock") &&
    reader.includes("[weak sourceWindow]") &&
    reader.includes("sourceWindow?.makeKeyAndOrderFront(nil)"),
    "locked AI writes must retain the candidate, reveal the source lock, and retry explicitly after unlock"]
  ,[sidecarProtocol.includes("struct SessionAssistantRelatedSource") &&
    sidecarProtocol.includes("let relatedSources: [SessionAssistantRelatedSource]?") &&
    reader.includes("assistantSourceLinks(") &&
    reader.includes('Text("Notebook：\\(source.notebookTitle) · Session：\\(source.sessionTitle)")') &&
    !reader.includes('Text("[\\(source.refId)]') &&
    reader.includes("onOpenRelatedSource(source)") &&
    content.includes("private func openRelatedSource") &&
    content.includes("requestSessionSelection(session)"),
    "cross-Notebook AI references must be visible and navigate to the exact source Session"]
  ,[reader.includes('Image(systemName: isLocked ? "lock.fill" : "lock.open")') &&
    reader.includes('accessibilityLabel(isLocked ? "解除固定" : "固定这个内容段")'),
    "whole-block lock and unlock must stay visible and keyboard-accessible in the source header"]
  ,[selectionEditBlockSection.includes('isUnlocking ? "解除固定" : "固定选区"') &&
    selectionEditBlockSection.includes("selectionTargetsProtectedSpan") &&
    selectionEditBlockSection.includes("private func updateProtectedSpan") &&
    selectionEditBlockSection.includes("workspace.isDirty(blockID: manifest.id)") &&
    selectionEditBlockSection.includes("supervisor.protectMarkdownSelection(") &&
    selectionEditBlockSection.includes("supervisor.unlockMarkdownProtectedSelection(") &&
    selectionEditBlockSection.includes('workspace.setSelection("", range: nil, blockID: manifest.id)'),
    "Mac protected-span controls must choose one minimal action, require a saved exact selection, and clear stale selection after success"]
  ,[localShellClient.includes('action: "protect"') &&
    localShellClient.includes('action: "unlock"') &&
    localShellClient.includes('path: "local/v1/session/block/span/\\(action)"') &&
    localShellClient.includes("baseRevision: baseRevision") &&
    localShellClient.includes("from: selection.from") &&
    localShellClient.includes("to: selection.to") &&
    localShellClient.includes("selectedText: selection.selectedText"),
    "Mac protected-span writes must carry the exact UTF-16 selection and base revision through the loopback contract"]
  ,[localRouteSection.includes('path: "/local/v1/session/block/span/protect", capability: "local.workspace.manage"') &&
    localRouteSection.includes('path: "/local/v1/session/block/span/unlock", capability: "local.workspace.manage"') &&
    !networkRouteSection.includes("/session/block/span/") &&
    macosSidecar.includes("protectSessionBlockSpan: (input) => sessionEditor.protectMarkdownSelection(input)") &&
    macosSidecar.includes("unlockSessionBlockSpan: (input) => sessionEditor.unlockMarkdownProtectedSelection(input)"),
    "protect and unlock authority must remain on the trusted local host and never enter paired-device network routes"]
  ,[sessionEditService.includes("const spanId = `lock_${randomUUID()}`") &&
    sessionEditService.includes("const contentHash = sha256Text(input.selection.selectedText)") &&
    sessionEditService.includes("input.baseRevision !== currentRevision") &&
    sessionEditService.includes('lock.kind === "span" && lock.id === span.id') &&
    sessionEditService.includes("span.contentHash !== registeredLock.contentHash") &&
    sessionEditService.includes("locks: remainingLocks"),
    "Core must own protected-span identities, hashes, revision checks, registered-lock verification, and preservation of every other lock"]
  ,[selectionEditor.includes("let shouldRegisterAIUndo = context.coordinator.externalEditEpoch != externalEditEpoch") &&
    selectionEditor.includes("applyUndoableExternalText") &&
    selectionEditor.includes("textView.undoManager?.registerUndo") &&
    selectionEditor.includes('setActionName("AI 选区修改")') &&
    reader.includes("aiEditEpochs[payload.block.id, default: 0] += 1") &&
    reader.includes("externalEditEpoch: workspace.aiEditEpochs[manifest.id, default: 0]"),
    "applied AI edits must bump a per-block epoch and register a native undoable replacement"]
  ,[selectionEditBlockSection.includes("supervisor.appendMarkdown(") &&
    selectionEditBlockSection.includes("insertAfterBlockId: manifest.id") &&
    localShellClient.includes("AppendMarkdownRequest(") &&
    localShellClient.includes("insertAfterBlockId: insertAfterBlockId") &&
    localShellClient.includes("let insertAfterBlockId: String?") &&
    supervisor.includes("insertAfterBlockId: String? = nil"),
    "insert-after must carry the precise right-clicked block anchor through the shared append contract"]
  ,[selectionEditBlockSection.includes("markdownLockState != true") &&
    reader.includes(".disabled(!hasEditableSelection)") &&
    reader.includes("else if manifest.editable, !markdown.blockLocked") &&
    reader.includes("这个内容段已固定") &&
    reader.includes('Label("用 AI 修改选中文字"'),
    "AI selection editing must be disabled for whole-block locked content and fall back to fixed read-only text"]
  ,[providerSettings.includes('GroupBox("笔记备份")') &&
    providerSettings.includes('Label("备份笔记…", systemImage: "externaldrive.badge.plus")') &&
    providerSettings.includes("editingState.hasUnsavedSourceDrafts") &&
    providerSettings.includes("startAccessingSecurityScopedResource"),
    "Mac settings must expose one native backup action and never snapshot unsaved source drafts"]
  ,[localShellClient.includes('path: "local/v1/notes/backup"') &&
    supervisor.includes("func createNotesBackup(destinationParentDir:") &&
    macosSidecar.includes("createNotesBackup: (input) => createNotesBackup({"),
    "Mac backup must flow through the authenticated sidecar instead of copying notes in the UI process"]
  ,[localRouteSection.includes('path: "/local/v1/notes/backup", capability: "local.filesystem.manage"') &&
    !networkRouteSection.includes("/notes/backup") &&
    notesBackup.includes('const sourceNotebooksDir = path.join(notesRootDir, "notebooks")') &&
    notesBackup.includes("containsProviderSecrets: false") &&
    notesBackup.includes("备份拒绝符号链接"),
    "notes backup must remain local-only, secrets-free, hash-manifested, and resistant to link traversal"]
  ,[localShellClient.includes('path: "local/v1/session/blocks/restore"') &&
    localShellClient.includes("baseRevision: baseRevision") &&
    supervisor.includes("func restoreSessionBlocks(") &&
    reader.includes("pending.manifest.revision") &&
    reader.includes("pending.undo.deletionId"),
    "Mac delete undo must carry the opaque deletion receipt and exact post-delete revision through Core"]
  ,[localRouteSection.includes('path: "/local/v1/session/blocks/restore", capability: "local.workspace.manage"') &&
    !networkRouteSection.includes("/session/blocks/restore") &&
    macosSidecar.includes("sessionBlockOrganizer.restoreDeleted(input)"),
    "block restore authority must remain on the trusted local host and outside paired-device routes"]
  ,[sessionBlockOrganizer.includes('resolve(trashRoot, "delete.json")') &&
    sessionBlockOrganizer.includes("sessionManifestRevision(stored.session)") &&
    sessionBlockOrganizer.includes("locks: [...stored.session.locks, ...snapshot.locks]") &&
    sessionBlockOrganizer.includes('SessionBlockOrganizeError("undo_conflict", 409)') &&
    sessionBlockOrganizer.includes("await rm(trashRoot, { recursive: true, force: true })"),
    "Core delete undo must be recoverable, revision-bound, lock-preserving, conflict-safe, and one-shot"]
  ,[!unsafeRawRecognitionEvent, "Markdown headings must not terminate single-hash Swift raw JSON fixtures"]
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`MACOS_UI_CONTRACT_FAIL ${failure}\n`);
  process.exit(1);
}
console.log(`MACOS_UI_CONTRACT_OK checks=${checks.length}`);
