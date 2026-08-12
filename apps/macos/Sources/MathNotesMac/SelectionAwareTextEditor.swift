import AppKit
import SwiftUI

/// Native source editor that exposes the user's current selection to the
/// learning assistant without copying it into the note or a hidden store.
struct SelectionAwareTextEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var selectedText: String
    @Binding var contentHeight: CGFloat
    let fontPreset: String
    let fontSize: Double
    let onActivate: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            text: $text,
            selectedText: $selectedText,
            contentHeight: $contentHeight,
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
        if textView.string != text {
            let oldSelection = textView.selectedRange()
            textView.string = text
            let location = min(oldSelection.location, (text as NSString).length)
            let length = min(oldSelection.length, (text as NSString).length - location)
            textView.setSelectedRange(NSRange(location: location, length: length))
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
        private var contentHeight: Binding<CGFloat>
        var onActivate: () -> Void
        weak var textView: NSTextView?
        private var pendingHeightMeasurement: DispatchWorkItem?

        init(
            text: Binding<String>,
            selectedText: Binding<String>,
            contentHeight: Binding<CGFloat>,
            onActivate: @escaping () -> Void
        ) {
            self.text = text
            self.selectedText = selectedText
            self.contentHeight = contentHeight
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
