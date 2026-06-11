// swift-tools-version: 5.9

import PackageDescription

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
            name: "Relaycast"
        ),
        .testTarget(
            name: "RelaycastTests",
            dependencies: ["Relaycast"]
        )
    ]
)
