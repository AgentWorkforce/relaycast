// swift-tools-version: 5.9

import PackageDescription

// Root-level SwiftPM manifest for the relaycast monorepo.
//
// The relaycast Swift engine SDK lives in `packages/sdk-swift`, but SwiftPM
// git-URL dependencies require a `Package.swift` at the repository root. This
// manifest vends the existing `Relaycast` library/target from
// `packages/sdk-swift/Sources/Relaycast` so downstream packages can depend on
// relaycast directly via:
//
//     .package(url: "https://github.com/AgentWorkforce/relaycast.git", from: "x.y.z")
//
// The sources are shared with `packages/sdk-swift/Package.swift`; only the
// manifest location differs.
let package = Package(
    name: "relaycast-swift",
    platforms: [
        .macOS(.v12),
        .iOS(.v15),
        .tvOS(.v15),
        .watchOS(.v8)
    ],
    products: [
        .library(
            name: "Relaycast",
            targets: ["Relaycast"]
        )
    ],
    targets: [
        .target(
            name: "Relaycast",
            path: "packages/sdk-swift/Sources/Relaycast"
        ),
        .testTarget(
            name: "RelaycastTests",
            dependencies: ["Relaycast"],
            path: "packages/sdk-swift/Tests/RelaycastTests"
        )
    ]
)
