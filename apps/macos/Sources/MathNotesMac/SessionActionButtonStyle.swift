import SwiftUI

struct SessionActionButtonStyle: ButtonStyle {
    var prominent = false
    var selected = false

    func makeBody(configuration: Configuration) -> some View {
        ActionSurface(configuration: configuration, prominent: prominent, selected: selected)
    }

    private struct ActionSurface: View {
        let configuration: Configuration
        let prominent: Bool
        let selected: Bool
        @State private var isHovered = false
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 9)
                .frame(minWidth: 30, minHeight: 30)
                .foregroundStyle(prominent ? Color.white : Color.primary)
                .background {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(prominent ? MathNotesTheme.accent :
                              (selected ? MathNotesTheme.accentSoft : Color.primary.opacity(isHovered ? 0.07 : 0)))
                }
                .overlay {
                    if configuration.isPressed {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.primary.opacity(0.09))
                    }
                }
                .opacity(isEnabled ? 1 : 0.45)
                .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .onHover { isHovered = $0 }
        }
    }
}
