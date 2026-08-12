import AppKit
import SwiftUI

enum MathNotesTheme {
    static let accent = Color(red: 0.10, green: 0.47, blue: 0.34)
    static let accentSoft = dynamicColor(
        light: NSColor(red: 0.91, green: 0.96, blue: 0.94, alpha: 1),
        dark: NSColor(red: 0.10, green: 0.20, blue: 0.17, alpha: 1)
    )
    static let canvas = dynamicColor(
        light: NSColor(red: 0.985, green: 0.98, blue: 0.965, alpha: 1),
        dark: NSColor(red: 0.075, green: 0.078, blue: 0.075, alpha: 1)
    )
    static let sidebar = dynamicColor(
        light: NSColor(red: 0.955, green: 0.95, blue: 0.935, alpha: 1),
        dark: NSColor(red: 0.105, green: 0.11, blue: 0.105, alpha: 1)
    )
    static let separator = Color(nsColor: .separatorColor)
    static let warning = Color(red: 0.88, green: 0.55, blue: 0.14)
    static let failure = Color(red: 0.70, green: 0.23, blue: 0.20)

    enum Spacing {
        static let compact: CGFloat = 6
        static let standard: CGFloat = 12
        static let section: CGFloat = 20
        static let page: CGFloat = 28
    }

    enum Radius {
        static let control: CGFloat = 6
        static let panel: CGFloat = 8
    }

    private static func dynamicColor(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        })
    }
}

private struct MathNotesControlSurface: ViewModifier {
    let interactive: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @AppStorage(MacPreferenceKeys.materialOpacity) private var materialOpacity = MacMaterialPreferences.defaultOpacity
    @AppStorage(MacPreferenceKeys.materialBlur) private var materialBlur = MacMaterialPreferences.defaultBlur

    @ViewBuilder
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        if reduceTransparency {
            content
                .background(MathNotesTheme.sidebar, in: shape)
                .overlay { shape.strokeBorder(MathNotesTheme.separator.opacity(0.7)) }
        } else if #available(macOS 26.0, *) {
            ZStack {
                adjustableMaterial(shape: shape)
                content
            }
            .glassEffect(.regular.interactive(interactive), in: shape)
        } else {
            ZStack {
                adjustableMaterial(shape: shape)
                content
            }
                .overlay { shape.strokeBorder(Color.primary.opacity(0.08)) }
        }
    }

    @ViewBuilder
    private func adjustableMaterial(shape: RoundedRectangle) -> some View {
        let opacity = min(1, max(0.45, materialOpacity))
        let blur = min(1, max(0, materialBlur))
        if blur < 0.25 {
            shape.fill(.ultraThinMaterial).opacity(opacity)
        } else if blur < 0.55 {
            shape.fill(.thinMaterial).opacity(opacity)
        } else if blur < 0.82 {
            shape.fill(.regularMaterial).opacity(opacity)
        } else {
            shape.fill(.thickMaterial).opacity(opacity)
        }
    }
}

extension View {
    func mathNotesControlSurface(interactive: Bool = false) -> some View {
        modifier(MathNotesControlSurface(interactive: interactive))
    }
}

struct MathNotesMaterialBackground<SurfaceShape: Shape>: View {
    let shape: SurfaceShape
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @AppStorage(MacPreferenceKeys.materialOpacity) private var materialOpacity = MacMaterialPreferences.defaultOpacity
    @AppStorage(MacPreferenceKeys.materialBlur) private var materialBlur = MacMaterialPreferences.defaultBlur

    var body: some View {
        Group {
            if reduceTransparency {
                shape.fill(MathNotesTheme.sidebar)
            } else if materialBlur < 0.25 {
                shape.fill(.ultraThinMaterial).opacity(clampedOpacity)
            } else if materialBlur < 0.55 {
                shape.fill(.thinMaterial).opacity(clampedOpacity)
            } else if materialBlur < 0.82 {
                shape.fill(.regularMaterial).opacity(clampedOpacity)
            } else {
                shape.fill(.thickMaterial).opacity(clampedOpacity)
            }
        }
        .overlay {
            shape.stroke(MathNotesTheme.separator.opacity(0.62), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.07), radius: 12, y: 4)
    }

    private var clampedOpacity: Double {
        min(1, max(0.45, materialOpacity))
    }
}
