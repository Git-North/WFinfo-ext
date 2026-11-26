// swift-tools-version:5.9
// SwiftPM build of the wfinfo-mac helper (CI and manual builds). The .NET
// project compiles the same file with swiftc (WFInfo.Headless.csproj,
// BuildMacHelper), so both builds use one source.
import PackageDescription

let package = Package(
    name: "wfinfo-mac",
    platforms: [.macOS("15.0")], // RecognizeTextRequest (Swift Vision API)
    targets: [
        .executableTarget(
            name: "wfinfo-mac",
            path: ".",
            exclude: ["MacHelper.cs", "MacNative.cs", "OcrEngines.cs"],
            sources: ["wfinfo-mac.swift"]
        ),
    ]
)
