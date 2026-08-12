// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MathNotesMac",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "MathNotesMac", targets: ["MathNotesMac"])
    ],
    targets: [
        .executableTarget(
            name: "MathNotesMac",
            resources: [.copy("Resources")]
        )
    ]
)
