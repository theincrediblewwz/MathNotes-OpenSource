import AppKit
import SwiftUI

struct UTF16TextSelection: Equatable, Sendable {
    let from: Int
    let to: Int

    var isEmpty: Bool { to <= from }
}

/// Native source editor that exposes the user's current selection to the
/// learning assistant without copying it into the note or a hidden store.
struct SelectionAwareTextEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var selectedText: String
    @Binding var selectedRange: UTF16TextSelection?
    @Binding var contentHeight: CGFloat
    let externalEditEpoch: Int
    let fontPreset: String
    let fontSize: Double
    let onActivate: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            text: $text,
            selectedText: $selectedText,
            selectedRange: $selectedRange,
            contentHeight: $contentHeight,
            externalEditEpoch: externalEditEpoch,
            onActivate: onActivate
        )
    }

    func makeNSView(context: Context) -> NSTextView {
        let textView = HeightReportingTextView()
        textView.delegate = context.coordinator
        textView.string = text
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainerInset = NSSize(width: 8, height: 8)
        textView.font = editorFont
        context.coordinator.textView = textView
        textView.onLayoutChange = { [weak coordinator = context.coordinator] in
            coordinator?.scheduleHeightMeasurement()
        }
        context.coordinator.scheduleHeightMeasurement()
        return textView
    }

    func updateNSView(_ textView: NSTextView, context: Context) {
        context.coordinator.onActivate = onActivate
        let shouldRegisterAIUndo = context.coordinator.externalEditEpoch != externalEditEpoch
        context.coordinator.externalEditEpoch = externalEditEpoch
        if textView.string != text {
            if shouldRegisterAIUndo {
                context.coordinator.applyUndoableExternalText(text, to: textView)
            } else {
                context.coordinator.replaceTextWithoutUndo(text, in: textView)
            }
        }
        textView.font = editorFont
        context.coordinator.scheduleHeightMeasurement()
    }

    private var editorFont: NSFont {
        let size = CGFloat(min(24, max(10, fontSize)))
        switch fontPreset {
        case MacSourceFontPreset.menlo.rawValue:
            return NSFont(name: "Menlo", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
        case MacSourceFontPreset.monaco.rawValue:
            return NSFont(name: "Monaco", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
        default:
            return .monospacedSystemFont(ofSize: size, weight: .regular)
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        private var text: Binding<String>
        private var selectedText: Binding<String>
        private var selectedRange: Binding<UTF16TextSelection?>
        private var contentHeight: Binding<CGFloat>
        var externalEditEpoch: Int
        var onActivate: () -> Void
        weak var textView: NSTextView?
        private var pendingHeightMeasurement: DispatchWorkItem?

        init(
            text: Binding<String>,
            selectedText: Binding<String>,
            selectedRange: Binding<UTF16TextSelection?>,
            contentHeight: Binding<CGFloat>,
            externalEditEpoch: Int,
            onActivate: @escaping () -> Void
        ) {
            self.text = text
            self.selectedText = selectedText
            self.selectedRange = selectedRange
            self.contentHeight = contentHeight
            self.externalEditEpoch = externalEditEpoch
            self.onActivate = onActivate
        }

        func textDidChange(_ notification: Notification) {
            guard let textView else { return }
            onActivate()
            text.wrappedValue = textView.string
            publishSelection(from: textView)
            scheduleHeightMeasurement()
        }

        func textDidBeginEditing(_ notification: Notification) {
            onActivate()
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView else { return }
            onActivate()
            publishSelection(from: textView)
        }

        func scheduleHeightMeasurement() {
            pendingHeightMeasurement?.cancel()
            let measurement = DispatchWorkItem { [weak self] in
                self?.measureHeight()
            }
            pendingHeightMeasurement = measurement
            DispatchQueue.main.async(execute: measurement)
        }

        private func measureHeight() {
            guard let textView,
                  textView.bounds.width > 1,
                  let textContainer = textView.textContainer,
                  let layoutManager = textView.layoutManager else { return }
            layoutManager.ensureLayout(for: textContainer)
            let usedHeight = layoutManager.usedRect(for: textContainer).height
            let measured = ceil(max(96, usedHeight + textView.textContainerInset.height * 2 + 2))
            guard abs(contentHeight.wrappedValue - measured) > 1 else { return }
            var transaction = Transaction()
            transaction.animation = nil
            withTransaction(transaction) {
                contentHeight.wrappedValue = measured
            }
        }

        private func publishSelection(from textView: NSTextView) {
            let range = textView.selectedRange()
            let string = textView.string as NSString
            let value = range.length > 0 && NSMaxRange(range) <= string.length
                ? string.substring(with: range)
                : ""
            if selectedText.wrappedValue != value {
                selectedText.wrappedValue = value
            }
            let nextRange = range.length > 0 && NSMaxRange(range) <= string.length
                ? UTF16TextSelection(from: range.location, to: NSMaxRange(range))
                : nil
            if selectedRange.wrappedValue != nextRange {
                selectedRange.wrappedValue = nextRange
            }
        }

        func replaceTextWithoutUndo(_ value: String, in textView: NSTextView) {
            let oldSelection = textView.selectedRange()
            textView.string = value
            restoreSelection(oldSelection, in: textView)
        }

        func applyUndoableExternalText(_ value: String, to textView: NSTextView) {
            guard textView.string != value else { return }
            let previous = textView.string
            let oldSelection = textView.selectedRange()
            textView.undoManager?.registerUndo(withTarget: self) { coordinator in
                coordinator.applyUndoableExternalText(previous, to: textView)
            }
            textView.undoManager?.setActionName("AI 选区修改")
            textView.string = value
            restoreSelection(oldSelection, in: textView)
            text.wrappedValue = value
            publishSelection(from: textView)
            scheduleHeightMeasurement()
        }

        private func restoreSelection(_ oldSelection: NSRange, in textView: NSTextView) {
            let length = (textView.string as NSString).length
            let location = min(oldSelection.location, length)
            let selectionLength = min(oldSelection.length, length - location)
            textView.setSelectedRange(NSRange(location: location, length: selectionLength))
        }
    }
}

private final class HeightReportingTextView: NSTextView {
    var onLayoutChange: (() -> Void)?

    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = abs(frame.width - newSize.width) > 1
        super.setFrameSize(newSize)
        if widthChanged { onLayoutChange?() }
    }
}
