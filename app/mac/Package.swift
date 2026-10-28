// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "OvisMac",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "OvisMac", path: "Sources/OvisMac"),
        .testTarget(name: "OvisMacTests", dependencies: ["OvisMac"], path: "Tests/OvisMacTests"),
    ]
)
