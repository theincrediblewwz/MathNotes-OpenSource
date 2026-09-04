import AppKit
import CoreImage
import ImageIO
import SwiftUI

struct MacImageEditDraft: Identifiable {
    let id = UUID()
    let fileName: String
    let sourceBytes: Data
    let previewImage: NSImage
    let baseRevision: String
}

struct MacImageEditOutput: Sendable {
    let outputPngBytes: Data
    let operations: [MacImageTransformOperation]
    let annotations: [MacImageAnnotationObject]
}

private enum MacImageEditTool: String, CaseIterable, Identifiable {
    case perspective
    case crop
    case lasso
    case pen
    case arrow

    var id: String { rawValue }
    var label: String {
        return switch self {
        case .perspective: "透视"
        case .crop: "裁剪"
        case .lasso: "套索"
        case .pen: "画笔"
        case .arrow: "箭头"
        }
    }
    var systemImage: String {
        return switch self {
        case .perspective: "viewfinder"
        case .crop: "crop"
        case .lasso: "lasso"
        case .pen: "pencil.tip"
        case .arrow: "arrow.up.right"
        }
    }
}

private struct MacPendingImageEditState {
    let rotationQuarterTurns: Int
    let perspectiveCorners: [MacNormalizedPoint]
    let perspectiveEnabled: Bool
    let cropRect: MacNormalizedRect?
    let lassoPoints: [MacNormalizedPoint]
    let annotations: [MacImageAnnotationObject]
}

private struct MacCommittedImageEditSnapshot {
    let baseData: Data
    let operations: [MacImageTransformOperation]
    let annotations: [MacImageAnnotationObject]
}

struct MacImageAnnotationEditor: View {
    let draft: MacImageEditDraft
    let onCancel: () -> Void
    let onConfirm: (MacImageEditOutput) async throws -> Void

    @State private var baseData: Data
    @State private var baseImage: NSImage
    @State private var committedOperations: [MacImageTransformOperation] = []
    @State private var committedAnnotations: [MacImageAnnotationObject] = []
    @State private var committedHistory: [MacCommittedImageEditSnapshot] = []
    @State private var pendingHistory: [MacPendingImageEditState] = []
    @State private var activeTool: MacImageEditTool?
    @State private var rotationQuarterTurns = 0
    @State private var perspectiveCorners = MacImageEditingGeometry.defaultPerspectiveCorners
    @State private var perspectiveEnabled = false
    @State private var cropRect: MacNormalizedRect?
    @State private var lassoPoints: [MacNormalizedPoint] = []
    @State private var annotations: [MacImageAnnotationObject] = []
    @State private var annotationColor = "#187857"
    @State private var annotationWidth = 0.006
    @State private var gestureStart: MacNormalizedPoint?
    @State private var gesturePoints: [MacNormalizedPoint] = []
    @State private var gestureHistoryRecorded = false
    @State private var activePerspectiveCorner: Int?
    @State private var isApplying = false
    @State private var errorMessage: String?

    init(
        draft: MacImageEditDraft,
        onCancel: @escaping () -> Void,
        onConfirm: @escaping (MacImageEditOutput) async throws -> Void
    ) {
        self.draft = draft
        self.onCancel = onCancel
        self.onConfirm = onConfirm
        _baseData = State(initialValue: draft.sourceBytes)
        _baseImage = State(initialValue: draft.previewImage)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            toolbar
            Divider()
            imageWorkspace
            Divider()
            footer
        }
        .frame(minWidth: 860, idealWidth: 1_020, minHeight: 640, idealHeight: 760)
        .background(MathNotesTheme.canvas)
        .interactiveDismissDisabled(isApplying)
        .alert("图片编辑没有完成", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("好", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "未知错误")
        }
        .accessibilityIdentifier("mac-image-annotation-editor")
    }

    private var header: some View {
        HStack(spacing: MathNotesTheme.Spacing.standard) {
            VStack(alignment: .leading, spacing: 3) {
                Text("图片编辑")
                    .font(.title2.weight(.semibold))
                Text(draft.fileName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Button {
                onCancel()
            } label: {
                Image(systemName: "xmark")
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .disabled(isApplying)
            .help("关闭图片编辑")
            .accessibilityLabel("关闭图片编辑")
        }
        .padding(.horizontal, MathNotesTheme.Spacing.section)
        .padding(.vertical, MathNotesTheme.Spacing.standard)
    }

    private var toolbar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: MathNotesTheme.Spacing.compact) {
                ForEach(MacImageEditTool.allCases) { tool in
                    toolButton(tool)
                }
                Divider().frame(height: 24)
                compactButton("左转", systemImage: "rotate.left") { rotate(by: 3) }
                compactButton("右转", systemImage: "rotate.right") { rotate(by: 1) }
                Divider().frame(height: 24)
                compactButton("撤销", systemImage: "arrow.uturn.backward") { undo() }
                    .disabled(!canUndo)
                compactButton("重置当前", systemImage: "arrow.counterclockwise") { resetPending(recordHistory: true) }
                    .disabled(!hasPendingEdits)
                if !annotations.isEmpty {
                    compactButton("删除最后标注", systemImage: "trash") {
                        recordPendingHistory()
                        annotations.removeLast()
                    }
                }
                if activeTool == .pen || activeTool == .arrow {
                    Divider().frame(height: 24)
                    annotationControls
                }
            }
            .padding(.horizontal, MathNotesTheme.Spacing.section)
            .padding(.vertical, MathNotesTheme.Spacing.compact)
        }
        .background(MathNotesTheme.sidebar.opacity(0.72))
        .accessibilityIdentifier("mac-image-annotation-toolbar")
    }

    private func toolButton(_ tool: MacImageEditTool) -> some View {
        Button {
            activeTool = activeTool == tool ? nil : tool
        } label: {
            Label(tool.label, systemImage: tool.systemImage)
                .font(.callout.weight(.medium))
                .padding(.horizontal, 10)
                .frame(height: 32)
                .background(
                    activeTool == tool ? MathNotesTheme.accentSoft : Color.clear,
                    in: RoundedRectangle(cornerRadius: MathNotesTheme.Radius.control, style: .continuous)
                )
        }
        .buttonStyle(.plain)
        .foregroundStyle(activeTool == tool ? MathNotesTheme.accent : .primary)
        .accessibilityLabel("图片编辑工具：\(tool.label)")
        .accessibilityAddTraits(activeTool == tool ? .isSelected : [])
    }

    private func compactButton(_ label: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: systemImage)
                .font(.callout)
                .padding(.horizontal, 8)
                .frame(height: 32)
        }
        .buttonStyle(.plain)
        .help(label)
    }

    private var annotationControls: some View {
        HStack(spacing: MathNotesTheme.Spacing.compact) {
            ForEach(["#187857", "#d84b3e", "#2563a8", "#1f201d", "#f0b429"], id: \.self) { color in
                Button {
                    annotationColor = color
                } label: {
                    Circle()
                        .fill(Color(mathNotesHex: color))
                        .frame(width: 18, height: 18)
                        .overlay {
                            Circle().stroke(Color.primary.opacity(annotationColor == color ? 0.8 : 0.2), lineWidth: annotationColor == color ? 2 : 1)
                        }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("标注颜色 \(color)")
                .accessibilityAddTraits(annotationColor == color ? .isSelected : [])
            }
            Slider(value: $annotationWidth, in: 0.003...0.018)
                .frame(width: 92)
                .accessibilityLabel("标注粗细")
        }
    }

    private var imageWorkspace: some View {
        GeometryReader { geometry in
            let fitted = MacImageEditingGeometry.aspectFitRect(
                imageSize: baseImage.size,
                containerSize: geometry.size,
                padding: 28
            )
            ZStack(alignment: .topLeading) {
                Color(nsColor: .windowBackgroundColor)
                Image(nsImage: baseImage)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: fitted.width, height: fitted.height)
                    .offset(x: fitted.minX, y: fitted.minY)
                    .shadow(color: .black.opacity(0.12), radius: 14, y: 5)
                editorOverlay(size: fitted.size)
                    .frame(width: fitted.width, height: fitted.height)
                    .offset(x: fitted.minX, y: fitted.minY)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityLabel("图片编辑画布")
    }

    private func editorOverlay(size: CGSize) -> some View {
        ZStack(alignment: .topLeading) {
            Canvas { context, canvasSize in
                drawSelections(context: &context, size: canvasSize)
                drawAnnotations(context: &context, size: canvasSize)
                drawLiveGesture(context: &context, size: canvasSize)
            }
            .contentShape(Rectangle())
            .gesture(canvasGesture(size: size))

            if activeTool == .perspective {
                ForEach(Array(perspectiveCorners.enumerated()), id: \.offset) { index, point in
                    perspectiveHandle(index: index, point: point, size: size)
                }
            }
            if activeTool == .crop, let cropRect {
                ForEach(0..<4, id: \.self) { index in
                    cropHandle(index: index, rect: cropRect, size: size)
                }
            }
        }
        .coordinateSpace(name: "mathnotes-image-editor-canvas")
        .clipped()
    }

    private func perspectiveHandle(index: Int, point: MacNormalizedPoint, size: CGSize) -> some View {
        Circle()
            .fill(MathNotesTheme.accent)
            .overlay { Circle().stroke(.white, lineWidth: 2) }
            .frame(width: 16, height: 16)
            .position(x: CGFloat(point.x) * size.width, y: CGFloat(point.y) * size.height)
            .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named("mathnotes-image-editor-canvas"))
                .onChanged { value in
                    if activePerspectiveCorner != index {
                        recordPendingHistory()
                        activePerspectiveCorner = index
                    }
                    let point = MacImageEditingGeometry.normalized(value.location, in: size)
                    var next = perspectiveCorners
                    next[index] = point
                    if MacImageEditingGeometry.isValidPerspective(next) {
                        perspectiveCorners = next
                        perspectiveEnabled = true
                    }
                }
                .onEnded { _ in activePerspectiveCorner = nil })
            .accessibilityLabel("透视角点 \(index + 1)")
    }

    private func cropHandle(index: Int, rect: MacNormalizedRect, size: CGSize) -> some View {
        let points = MacImageEditingGeometry.corners(of: rect)
        return Circle()
            .fill(.white)
            .overlay { Circle().stroke(MathNotesTheme.accent, lineWidth: 2) }
            .frame(width: 14, height: 14)
            .position(x: CGFloat(points[index].x) * size.width, y: CGFloat(points[index].y) * size.height)
            .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named("mathnotes-image-editor-canvas"))
                .onChanged { value in
                    if !gestureHistoryRecorded {
                        recordPendingHistory()
                        gestureHistoryRecorded = true
                    }
                    let point = MacImageEditingGeometry.normalized(value.location, in: size)
                    let resized = MacImageEditingGeometry.resized(rect, corner: index, to: point)
                    if resized.width >= 0.005, resized.height >= 0.005 {
                        cropRect = resized
                    }
                }
                .onEnded { _ in gestureHistoryRecorded = false })
            .accessibilityLabel("裁剪角点 \(index + 1)")
    }

    private func canvasGesture(size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                guard activeTool != nil, activeTool != .perspective else { return }
                let point = MacImageEditingGeometry.normalized(value.location, in: size)
                if !gestureHistoryRecorded {
                    recordPendingHistory()
                    gestureHistoryRecorded = true
                    gestureStart = point
                    gesturePoints = [point]
                    if activeTool == .crop { lassoPoints = [] }
                    if activeTool == .lasso { cropRect = nil }
                }
                switch activeTool {
                case .crop:
                    if let start = gestureStart { cropRect = MacImageEditingGeometry.rect(from: start, to: point) }
                case .lasso, .pen:
                    if let previous = gesturePoints.last,
                       MacImageEditingGeometry.distance(previous, point) >= 0.006 {
                        gesturePoints.append(point)
                    }
                case .arrow:
                    gesturePoints = [gestureStart ?? point, point]
                case .perspective, .none:
                    break
                }
            }
            .onEnded { value in
                defer {
                    gestureStart = nil
                    gesturePoints = []
                    gestureHistoryRecorded = false
                }
                guard let activeTool else { return }
                let end = MacImageEditingGeometry.normalized(value.location, in: size)
                switch activeTool {
                case .crop:
                    guard let start = gestureStart else { return }
                    let rect = MacImageEditingGeometry.rect(from: start, to: end)
                    cropRect = rect.width >= 0.005 && rect.height >= 0.005 ? rect : nil
                case .lasso:
                    if gesturePoints.count >= 3 { lassoPoints = gesturePoints }
                case .pen:
                    if gesturePoints.count >= 2 {
                        annotations.append(.pen(
                            id: "annotation-\(UUID().uuidString)",
                            points: gesturePoints,
                            color: annotationColor,
                            width: annotationWidth
                        ))
                    }
                case .arrow:
                    guard let start = gestureStart,
                          MacImageEditingGeometry.distance(start, end) >= 0.002 else { return }
                    annotations.append(.arrow(
                        id: "annotation-\(UUID().uuidString)",
                        start: start,
                        end: end,
                        color: annotationColor,
                        width: annotationWidth
                    ))
                case .perspective:
                    break
                }
            }
    }

    private func drawSelections(context: inout GraphicsContext, size: CGSize) {
        if let cropRect {
            let rect = CGRect(
                x: CGFloat(cropRect.x) * size.width,
                y: CGFloat(cropRect.y) * size.height,
                width: CGFloat(cropRect.width) * size.width,
                height: CGFloat(cropRect.height) * size.height
            )
            context.stroke(Path(rect), with: .color(MathNotesTheme.accent), style: StrokeStyle(lineWidth: 2, dash: [7, 5]))
        }
        if lassoPoints.count >= 2 {
            context.stroke(
                polygonPath(lassoPoints, size: size, close: true),
                with: .color(MathNotesTheme.accent),
                style: StrokeStyle(lineWidth: 2, dash: [6, 4])
            )
        }
        if activeTool == .perspective {
            context.stroke(
                polygonPath(perspectiveCorners, size: size, close: true),
                with: .color(MathNotesTheme.accent),
                style: StrokeStyle(lineWidth: 2)
            )
        }
    }

    private func drawAnnotations(context: inout GraphicsContext, size: CGSize) {
        for annotation in annotations {
            draw(annotation, context: &context, size: size)
        }
    }

    private func drawLiveGesture(context: inout GraphicsContext, size: CGSize) {
        guard !gesturePoints.isEmpty else { return }
        switch activeTool {
        case .lasso:
            context.stroke(
                polygonPath(gesturePoints, size: size, close: false),
                with: .color(MathNotesTheme.accent),
                style: StrokeStyle(lineWidth: 2, dash: [6, 4])
            )
        case .pen:
            draw(.pen(id: "live", points: gesturePoints, color: annotationColor, width: annotationWidth), context: &context, size: size)
        case .arrow:
            if gesturePoints.count == 2 {
                draw(.arrow(
                    id: "live", start: gesturePoints[0], end: gesturePoints[1],
                    color: annotationColor, width: annotationWidth
                ), context: &context, size: size)
            }
        default:
            break
        }
    }

    private func draw(_ annotation: MacImageAnnotationObject, context: inout GraphicsContext, size: CGSize) {
        let color = Color(mathNotesHex: annotation.color)
        let width = max(1.5, CGFloat(annotation.width) * min(size.width, size.height))
        switch annotation {
        case let .pen(_, points, _, _):
            context.stroke(polygonPath(points, size: size, close: false), with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
        case let .arrow(_, start, end, _, _):
            var path = Path()
            let startPoint = CGPoint(x: CGFloat(start.x) * size.width, y: CGFloat(start.y) * size.height)
            let endPoint = CGPoint(x: CGFloat(end.x) * size.width, y: CGFloat(end.y) * size.height)
            path.move(to: startPoint)
            path.addLine(to: endPoint)
            let heads = MacImageEditingGeometry.arrowHead(start: start, end: end, width: annotation.width)
            for head in heads {
                path.move(to: endPoint)
                path.addLine(to: CGPoint(x: CGFloat(head.x) * size.width, y: CGFloat(head.y) * size.height))
            }
            context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
        }
    }

    private func polygonPath(_ points: [MacNormalizedPoint], size: CGSize, close: Bool) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: CGPoint(x: CGFloat(first.x) * size.width, y: CGFloat(first.y) * size.height))
        for point in points.dropFirst() {
            path.addLine(to: CGPoint(x: CGFloat(point.x) * size.width, y: CGFloat(point.y) * size.height))
        }
        if close { path.closeSubpath() }
        return path
    }

    private var footer: some View {
        HStack(spacing: MathNotesTheme.Spacing.standard) {
            Label(activeInstruction, systemImage: activeTool?.systemImage ?? "photo")
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer()
            Button("取消") { onCancel() }
                .disabled(isApplying)
            Button {
                Task { await applyCurrentOperation() }
            } label: {
                if isApplying {
                    ProgressView().controlSize(.small)
                } else {
                    Label("应用当前操作", systemImage: "checkmark")
                }
            }
            .disabled(!hasPendingEdits || isApplying)
            Button {
                Task { await confirmImage() }
            } label: {
                Text(isApplying ? "正在保存…" : "插入图片")
            }
            .buttonStyle(.borderedProminent)
            .tint(MathNotesTheme.accent)
            .disabled(isApplying)
        }
        .padding(.horizontal, MathNotesTheme.Spacing.section)
        .padding(.vertical, MathNotesTheme.Spacing.standard)
        .background(MathNotesTheme.sidebar.opacity(0.68))
    }

    private var activeInstruction: String {
        return switch activeTool {
        case .perspective: "拖动四个角，对齐纸张或黑板的边缘。"
        case .crop: "拖动框选范围；选好后可继续拖动四角微调。"
        case .lasso: "沿内容轮廓拖动，轮廓之外会以白色填充。"
        case .pen: "在图片上拖动绘制；颜色和粗细可在上方调整。"
        case .arrow: "从起点拖到终点绘制箭头。"
        case .none: "可旋转、校正透视、裁剪或添加标注；原图会一并保留。"
        }
    }

    private var hasPendingEdits: Bool {
        rotationQuarterTurns != 0 || perspectiveEnabled || cropRect != nil || lassoPoints.count >= 3 || !annotations.isEmpty
    }

    private var canUndo: Bool { !pendingHistory.isEmpty || !committedHistory.isEmpty }

    private var pendingOperations: [MacImageTransformOperation] {
        var result: [MacImageTransformOperation] = []
        if rotationQuarterTurns != 0 { result.append(.rotate(quarterTurns: rotationQuarterTurns)) }
        if perspectiveEnabled, MacImageEditingGeometry.isValidPerspective(perspectiveCorners) {
            result.append(.perspective(corners: perspectiveCorners))
        }
        if let cropRect { result.append(.crop(rect: cropRect)) }
        if lassoPoints.count >= 3 {
            result.append(.lasso(points: lassoPoints, boundingBox: .bounding(lassoPoints)))
        }
        return result
    }

    private func rotate(by quarterTurns: Int) {
        recordPendingHistory()
        rotationQuarterTurns = (rotationQuarterTurns + quarterTurns) % 4
        cropRect = nil
        lassoPoints = []
        perspectiveCorners = MacImageEditingGeometry.defaultPerspectiveCorners
        perspectiveEnabled = false
        annotations = []
    }

    private func recordPendingHistory() {
        pendingHistory.append(MacPendingImageEditState(
            rotationQuarterTurns: rotationQuarterTurns,
            perspectiveCorners: perspectiveCorners,
            perspectiveEnabled: perspectiveEnabled,
            cropRect: cropRect,
            lassoPoints: lassoPoints,
            annotations: annotations
        ))
        if pendingHistory.count > 80 { pendingHistory.removeFirst(pendingHistory.count - 80) }
    }

    private func undo() {
        if let previous = pendingHistory.popLast() {
            restore(previous)
            return
        }
        guard let previous = committedHistory.popLast(), let image = NSImage(data: previous.baseData) else { return }
        baseData = previous.baseData
        baseImage = image
        committedOperations = previous.operations
        committedAnnotations = previous.annotations
        resetPending(recordHistory: false)
    }

    private func restore(_ state: MacPendingImageEditState) {
        rotationQuarterTurns = state.rotationQuarterTurns
        perspectiveCorners = state.perspectiveCorners
        perspectiveEnabled = state.perspectiveEnabled
        cropRect = state.cropRect
        lassoPoints = state.lassoPoints
        annotations = state.annotations
    }

    private func resetPending(recordHistory: Bool) {
        if recordHistory, hasPendingEdits { self.recordPendingHistory() }
        rotationQuarterTurns = 0
        perspectiveCorners = MacImageEditingGeometry.defaultPerspectiveCorners
        perspectiveEnabled = false
        cropRect = nil
        lassoPoints = []
        annotations = []
        gestureStart = nil
        gesturePoints = []
        gestureHistoryRecorded = false
        activePerspectiveCorner = nil
    }

    @MainActor
    private func applyCurrentOperation() async {
        guard hasPendingEdits, !isApplying else { return }
        isApplying = true
        defer { isApplying = false }
        do {
            let png = try await renderPendingImage()
            guard let image = NSImage(data: png) else { throw MacImageEditRenderingError.invalidOutput }
            committedHistory.append(MacCommittedImageEditSnapshot(
                baseData: baseData,
                operations: committedOperations,
                annotations: committedAnnotations
            ))
            let metadata = MacImageEditMetadata(
                operations: committedOperations + pendingOperations,
                annotations: committedAnnotations + annotations
            )
            committedOperations = metadata.operations
            committedAnnotations = metadata.annotations
            baseData = png
            baseImage = image
            pendingHistory.removeAll()
            resetPending(recordHistory: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func confirmImage() async {
        guard !isApplying else { return }
        isApplying = true
        defer { isApplying = false }
        do {
            let png = try await renderPendingImage()
            let metadata = MacImageEditMetadata(
                operations: committedOperations + pendingOperations,
                annotations: committedAnnotations + annotations
            )
            try await onConfirm(MacImageEditOutput(
                outputPngBytes: png,
                operations: metadata.operations,
                annotations: metadata.annotations
            ))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func renderPendingImage() async throws -> Data {
        let data = baseData
        let rotation = rotationQuarterTurns
        let perspective = perspectiveEnabled ? perspectiveCorners : nil
        let crop = cropRect
        let lasso = lassoPoints.count >= 3 ? lassoPoints : nil
        let pendingAnnotations = annotations
        return try await Task.detached(priority: .userInitiated) {
            try MacImageEditRenderer.renderPNG(
                data: data,
                rotationQuarterTurns: rotation,
                perspectiveCorners: perspective,
                cropRect: crop,
                lassoPoints: lasso,
                annotations: pendingAnnotations
            )
        }.value
    }
}

private enum MacImageEditingGeometry {
    static let defaultPerspectiveCorners = [
        MacNormalizedPoint(x: 0.02, y: 0.02),
        MacNormalizedPoint(x: 0.98, y: 0.02),
        MacNormalizedPoint(x: 0.98, y: 0.98),
        MacNormalizedPoint(x: 0.02, y: 0.98)
    ]

    static func aspectFitRect(imageSize: CGSize, containerSize: CGSize, padding: CGFloat) -> CGRect {
        let available = CGSize(
            width: max(1, containerSize.width - padding * 2),
            height: max(1, containerSize.height - padding * 2)
        )
        let imageWidth = max(1, imageSize.width)
        let imageHeight = max(1, imageSize.height)
        let scale = min(available.width / imageWidth, available.height / imageHeight)
        let size = CGSize(width: imageWidth * scale, height: imageHeight * scale)
        return CGRect(
            x: (containerSize.width - size.width) / 2,
            y: (containerSize.height - size.height) / 2,
            width: size.width,
            height: size.height
        )
    }

    static func normalized(_ point: CGPoint, in size: CGSize) -> MacNormalizedPoint {
        MacNormalizedPoint(
            x: size.width > 0 ? Double(point.x / size.width) : 0,
            y: size.height > 0 ? Double(point.y / size.height) : 0
        )
    }

    static func distance(_ first: MacNormalizedPoint, _ second: MacNormalizedPoint) -> Double {
        hypot(first.x - second.x, first.y - second.y)
    }

    static func rect(from first: MacNormalizedPoint, to second: MacNormalizedPoint) -> MacNormalizedRect {
        MacNormalizedRect(
            x: min(first.x, second.x),
            y: min(first.y, second.y),
            width: abs(second.x - first.x),
            height: abs(second.y - first.y)
        )
    }

    static func corners(of rect: MacNormalizedRect) -> [MacNormalizedPoint] {
        [
            MacNormalizedPoint(x: rect.x, y: rect.y),
            MacNormalizedPoint(x: rect.x + rect.width, y: rect.y),
            MacNormalizedPoint(x: rect.x + rect.width, y: rect.y + rect.height),
            MacNormalizedPoint(x: rect.x, y: rect.y + rect.height)
        ]
    }

    static func resized(_ rect: MacNormalizedRect, corner: Int, to point: MacNormalizedPoint) -> MacNormalizedRect {
        let fixed = corners(of: rect)[(corner + 2) % 4]
        return self.rect(from: fixed, to: point)
    }

    static func isValidPerspective(_ corners: [MacNormalizedPoint]) -> Bool {
        guard corners.count == 4 else { return false }
        let crossProducts = corners.indices.map { index -> Double in
            let point = corners[index]
            let next = corners[(index + 1) % 4]
            let after = corners[(index + 2) % 4]
            return (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x)
        }
        guard let direction = crossProducts.first(where: { abs($0) > 0.000001 }).map({ $0 > 0 ? 1.0 : -1.0 }) else {
            return false
        }
        let area = abs(corners.indices.reduce(0.0) { sum, index in
            let next = corners[(index + 1) % 4]
            return sum + corners[index].x * next.y - next.x * corners[index].y
        }) / 2
        return area >= 0.001 && crossProducts.allSatisfy { ($0 > 0 ? 1.0 : -1.0) == direction && abs($0) > 0.000001 }
    }

    static func arrowHead(
        start: MacNormalizedPoint,
        end: MacNormalizedPoint,
        width: Double
    ) -> [MacNormalizedPoint] {
        let angle = atan2(end.y - start.y, end.x - start.x)
        let length = max(width * 4, 0.025)
        let spread = Double.pi / 7
        return [angle - spread, angle + spread].map { headAngle in
            MacNormalizedPoint(
                x: end.x - length * cos(headAngle),
                y: end.y - length * sin(headAngle)
            )
        }
    }
}

private enum MacImageEditRenderingError: LocalizedError {
    case invalidSource
    case invalidPerspective
    case invalidOutput

    var errorDescription: String? {
        return switch self {
        case .invalidSource: "无法读取这张图片。"
        case .invalidPerspective: "透视角点需要形成一个不交叉的四边形。"
        case .invalidOutput: "编辑后的图片没有成功生成。"
        }
    }
}

private enum MacImageEditRenderer {
    static func renderPNG(
        data: Data,
        rotationQuarterTurns: Int,
        perspectiveCorners: [MacNormalizedPoint]?,
        cropRect: MacNormalizedRect?,
        lassoPoints: [MacNormalizedPoint]?,
        annotations: [MacImageAnnotationObject]
    ) throws -> Data {
        guard var image = cgImage(from: data) else { throw MacImageEditRenderingError.invalidSource }
        if rotationQuarterTurns % 4 != 0 {
            image = try rotated(image, quarterTurns: rotationQuarterTurns)
        }
        if !annotations.isEmpty {
            image = try annotated(image, annotations: annotations)
        }
        if let perspectiveCorners {
            guard MacImageEditingGeometry.isValidPerspective(perspectiveCorners) else {
                throw MacImageEditRenderingError.invalidPerspective
            }
            image = try perspectiveCorrected(image, corners: perspectiveCorners)
        }
        if let lassoPoints, lassoPoints.count >= 3 {
            image = try lassoCropped(image, points: lassoPoints)
        } else if let cropRect {
            image = try cropped(image, rect: cropRect)
        }
        return try pngData(from: image)
    }

    private static func cgImage(from data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    private static func pngData(from image: CGImage) throws -> Data {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output as CFMutableData,
            "public.png" as CFString,
            1,
            nil
        ) else { throw MacImageEditRenderingError.invalidOutput }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw MacImageEditRenderingError.invalidOutput }
        return output as Data
    }

    private static func rotated(_ image: CGImage, quarterTurns: Int) throws -> CGImage {
        let orientation: CGImagePropertyOrientation = switch ((quarterTurns % 4) + 4) % 4 {
        case 1: .right
        case 2: .down
        case 3: .left
        default: .up
        }
        let output = CIImage(cgImage: image).oriented(orientation)
        return try rendered(output)
    }

    private static func perspectiveCorrected(_ image: CGImage, corners: [MacNormalizedPoint]) throws -> CGImage {
        let input = CIImage(cgImage: image)
        guard let filter = CIFilter(name: "CIPerspectiveCorrection") else {
            throw MacImageEditRenderingError.invalidOutput
        }
        let extent = input.extent
        func vector(_ point: MacNormalizedPoint) -> CIVector {
            CIVector(
                x: extent.minX + CGFloat(point.x) * extent.width,
                y: extent.maxY - CGFloat(point.y) * extent.height
            )
        }
        filter.setValue(input, forKey: kCIInputImageKey)
        filter.setValue(vector(corners[0]), forKey: "inputTopLeft")
        filter.setValue(vector(corners[1]), forKey: "inputTopRight")
        filter.setValue(vector(corners[2]), forKey: "inputBottomRight")
        filter.setValue(vector(corners[3]), forKey: "inputBottomLeft")
        guard let output = filter.outputImage else { throw MacImageEditRenderingError.invalidOutput }
        return try rendered(output)
    }

    private static func rendered(_ image: CIImage) throws -> CGImage {
        let extent = image.extent.integral
        guard !extent.isInfinite, !extent.isNull, extent.width >= 1, extent.height >= 1,
              let output = CIContext(options: nil).createCGImage(image, from: extent) else {
            throw MacImageEditRenderingError.invalidOutput
        }
        return output
    }

    private static func annotated(_ image: CGImage, annotations: [MacImageAnnotationObject]) throws -> CGImage {
        guard let context = topLeftContext(width: image.width, height: image.height) else {
            throw MacImageEditRenderingError.invalidOutput
        }
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        context.setLineCap(.round)
        context.setLineJoin(.round)
        for annotation in annotations {
            context.setStrokeColor(NSColor(mathNotesHex: annotation.color).cgColor)
            context.setLineWidth(max(1, CGFloat(annotation.width) * min(width, height)))
            context.beginPath()
            switch annotation {
            case let .pen(_, points, _, _):
                guard let first = points.first else { continue }
                context.move(to: CGPoint(x: CGFloat(first.x) * width, y: CGFloat(first.y) * height))
                for point in points.dropFirst() {
                    context.addLine(to: CGPoint(x: CGFloat(point.x) * width, y: CGFloat(point.y) * height))
                }
            case let .arrow(_, start, end, _, annotationWidth):
                let endPoint = CGPoint(x: CGFloat(end.x) * width, y: CGFloat(end.y) * height)
                context.move(to: CGPoint(x: CGFloat(start.x) * width, y: CGFloat(start.y) * height))
                context.addLine(to: endPoint)
                for head in MacImageEditingGeometry.arrowHead(start: start, end: end, width: annotationWidth) {
                    context.move(to: endPoint)
                    context.addLine(to: CGPoint(x: CGFloat(head.x) * width, y: CGFloat(head.y) * height))
                }
            }
            context.strokePath()
        }
        guard let output = context.makeImage() else { throw MacImageEditRenderingError.invalidOutput }
        return output
    }

    private static func cropped(_ image: CGImage, rect: MacNormalizedRect) throws -> CGImage {
        let sourceWidth = CGFloat(image.width)
        let sourceHeight = CGFloat(image.height)
        let pixelRect = CGRect(
            x: CGFloat(rect.x) * sourceWidth,
            y: CGFloat(rect.y) * sourceHeight,
            width: CGFloat(rect.width) * sourceWidth,
            height: CGFloat(rect.height) * sourceHeight
        ).integral
        let outputWidth = max(1, Int(pixelRect.width))
        let outputHeight = max(1, Int(pixelRect.height))
        guard let context = topLeftContext(width: outputWidth, height: outputHeight) else {
            throw MacImageEditRenderingError.invalidOutput
        }
        context.draw(image, in: CGRect(
            x: -pixelRect.minX,
            y: -pixelRect.minY,
            width: sourceWidth,
            height: sourceHeight
        ))
        guard let output = context.makeImage() else { throw MacImageEditRenderingError.invalidOutput }
        return output
    }

    private static func lassoCropped(_ image: CGImage, points: [MacNormalizedPoint]) throws -> CGImage {
        let sourceWidth = CGFloat(image.width)
        let sourceHeight = CGFloat(image.height)
        let bounds = MacNormalizedRect.bounding(points)
        let pixelRect = CGRect(
            x: CGFloat(bounds.x) * sourceWidth,
            y: CGFloat(bounds.y) * sourceHeight,
            width: CGFloat(bounds.width) * sourceWidth,
            height: CGFloat(bounds.height) * sourceHeight
        ).integral
        let outputWidth = max(1, Int(pixelRect.width))
        let outputHeight = max(1, Int(pixelRect.height))
        guard let context = topLeftContext(width: outputWidth, height: outputHeight) else {
            throw MacImageEditRenderingError.invalidOutput
        }
        context.setFillColor(NSColor.white.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))
        context.beginPath()
        guard let first = points.first else { throw MacImageEditRenderingError.invalidOutput }
        context.move(to: CGPoint(
            x: CGFloat(first.x) * sourceWidth - pixelRect.minX,
            y: CGFloat(first.y) * sourceHeight - pixelRect.minY
        ))
        for point in points.dropFirst() {
            context.addLine(to: CGPoint(
                x: CGFloat(point.x) * sourceWidth - pixelRect.minX,
                y: CGFloat(point.y) * sourceHeight - pixelRect.minY
            ))
        }
        context.closePath()
        context.clip()
        context.draw(image, in: CGRect(
            x: -pixelRect.minX,
            y: -pixelRect.minY,
            width: sourceWidth,
            height: sourceHeight
        ))
        guard let output = context.makeImage() else { throw MacImageEditRenderingError.invalidOutput }
        return output
    }

    private static func topLeftContext(width: Int, height: Int) -> CGContext? {
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: 1, y: -1)
        return context
    }
}

private extension Color {
    init(mathNotesHex: String) {
        self.init(nsColor: NSColor(mathNotesHex: mathNotesHex))
    }
}

private extension NSColor {
    convenience init(mathNotesHex value: String) {
        let normalized = value.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        let parsed = UInt64(normalized, radix: 16) ?? 0
        self.init(
            calibratedRed: CGFloat((parsed >> 16) & 0xff) / 255,
            green: CGFloat((parsed >> 8) & 0xff) / 255,
            blue: CGFloat(parsed & 0xff) / 255,
            alpha: 1
        )
    }
}
