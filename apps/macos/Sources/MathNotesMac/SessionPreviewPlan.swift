import Foundation

// Continuous Markdown and original attachments have separate loading lifetimes.
// A PDF/image can be available without ever producing a Markdown payload.
struct SessionPreviewPlan {
    let markdown: [SessionBlockManifest]
    let attachments: [SessionBlockManifest]

    init(blocks: [SessionBlockManifest]) {
        markdown = blocks.filter { $0.renderInNote && $0.type == "markdown" }
        attachments = blocks.filter { $0.renderInNote && ($0.type == "image" || $0.type == "pdf") }
    }
}
