// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OvisPushCore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "OvisPushCore", targets: ["OvisPushCore"])],
    targets: [
        .target(name: "OvisPushCore"),
        .testTarget(name: "OvisPushCoreTests", dependencies: ["OvisPushCore"])
    ]
)
