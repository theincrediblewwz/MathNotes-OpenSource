import AppKit
import SwiftUI

struct MacAuthorCard: View {
    var body: some View {
        Link(destination: URL(string: "https://github.com/theincrediblewwz")!) {
            HStack(spacing: 14) {
                if let url = Self.avatarURL,
                   let avatar = NSImage(contentsOf: url) {
                    Image(nsImage: avatar)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 60, height: 60)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .accessibilityLabel("WWZ SYSU 头像")
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("作者").font(.caption).foregroundStyle(.secondary)
                    Text("WWZ SYSU").font(.headline).foregroundStyle(.primary)
                    Text("github.com/theincrediblewwz").font(.callout).foregroundStyle(MathNotesTheme.accent)
                }
                Spacer()
                Image(systemName: "arrow.up.right").foregroundStyle(.secondary)
            }
            .padding(16)
            .background(MathNotesTheme.sidebar, in: RoundedRectangle(cornerRadius: 16))
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("打开 WWZ SYSU 的 GitHub 主页")
        .accessibilityIdentifier("settings-author-card")
    }

    private static var avatarURL: URL? {
        // A shipped app must never consult SwiftPM's absolute build-directory
        // fallback. On another Mac it is absent; on this Mac it can block on TCC.
        if Bundle.main.bundleURL.pathExtension == "app" {
            return Bundle.main.url(forResource: "wwz-sysu-avatar", withExtension: "jpg")
        }
        return Bundle.module.url(forResource: "wwz-sysu-avatar", withExtension: "jpg", subdirectory: "Resources")
    }
}
