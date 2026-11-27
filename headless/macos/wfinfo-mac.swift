// wfinfo-mac — macOS helper for the WFInfo headless runner.
//
// One small command-line tool, built by WFInfo.Headless.csproj on macOS
// (swiftc, no packages). Every subcommand prints JSON on stdout and exits 0,
// or prints an error on stderr and exits non-zero.
//
//   wfinfo-mac ocr [--fast] [--correction] [--lang en-US] [--device auto|ane|cpu|gpu]
//                  <image>... | - | --frames
//                                        Vision text recognition (RecognizeTextRequest,
//                                        accurate mode unless --fast; macOS 15+)
//   wfinfo-mac devices                   compute devices Vision offers per stage
//   wfinfo-mac displays                  connected displays (id, frame, pixels)
//   wfinfo-mac windows                   on-screen application windows
//   wfinfo-mac capture --display <id> | --window <id> <out.png> | -
//                                        ScreenCaptureKit screenshot (- : PNG on stdout)
//   wfinfo-mac rewards [--display <id> | --window <id> | --file <png>|-]
//                      --reward-width <w> --reward-height <h> --reward-y <y> --line-height <l>
//                      (--ui-scale <u> | --ui-scale-min <a> --ui-scale-max <b>)
//                      [--save <png>] [--fast] [--correction] [--lang en-US] [--device ...]
//                                        capture (main display by default) or decode, crop the
//                                        reward-name strip in memory, OCR the raw colour crop;
//                                        line boxes in full-image pixels (top-left origin)
//   wfinfo-mac selfcheck [--text "Volt Prime Blueprint"] [--save <png>] [--device ...]
//                                        render the text with CoreText in memory and OCR it
//   wfinfo-mac synth --out <png> --names "A|B|C" [--width 1920] [--height 1080] [--ui-scale 1.0]
//                    [--color "#BEA966"] [--squad "p1|p2"] [--seed 1] [--line-height 48]
//                                        synthetic reward screen (test fixture) + ground-truth JSON
//
// --frames: stdin holds images back to back, each a 4-byte big-endian length
// and the encoded image. The runner uses it and `capture -`, so a scan writes
// no temporary files.
//   wfinfo-mac hotkey [--key ctrl+option+s] [--url <scan url>] [--quiet] [--fire]
//                                        global hotkey that POSTs a scan request
//                                        (--fire: one request at once, then exit)
//
// Build: swiftc -O -o wfinfo-mac wfinfo-mac.swift

import AppKit
import Carbon.HIToolbox
import CoreGraphics
import CoreML
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

// MARK: - Output helpers

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ text: String) { description = text }
}

func printJSON(_ value: Any) {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    } catch {
        fail("cannot encode JSON: \(error)")
    }
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write("wfinfo-mac: \(message)\n".data(using: .utf8)!)
    exit(code)
}

func rounded(_ value: Double, _ places: Double = 1000) -> Double {
    (value * places).rounded() / places
}

/// Reads "--flag value" pairs and bare arguments.
struct Arguments {
    var flags: [String: String] = [:]
    var switches: Set<String> = []
    var positional: [String] = []

    init(_ raw: ArraySlice<String>, valueFlags: Set<String>) throws {
        var iterator = raw.makeIterator()
        while let arg = iterator.next() {
            if valueFlags.contains(arg) {
                guard let value = iterator.next() else { throw Failure("\(arg) expects a value") }
                flags[arg] = value
            } else if arg.hasPrefix("--") {
                switches.insert(arg)
            } else {
                positional.append(arg)
            }
        }
    }
}

// MARK: - OCR

/// Pinning Vision's compute device (RecognizeTextRequest.supportedComputeStageDevices
/// and setComputeDevice) needs the macOS 26 SDK (Xcode 26, Swift 6.2). The
/// members are available from macOS 15.0 at run time, so no #available check is
/// needed, but the macOS 15 SDK (Xcode 16) does not declare them. A helper built
/// with an older Xcode uses Vision's automatic device and says so.
#if compiler(>=6.2)
let canPinComputeDevice = true
#else
let canPinComputeDevice = false
#endif

let computeDeviceNote = "pinning the Vision compute device needs a helper built with Xcode 26 or later; this build uses Vision's automatic device"

/// The Vision compute device for the recognition stages; nil keeps Vision's choice.
func computeDevice(named name: String) throws -> MLComputeDevice? {
    if name != "auto" && !canPinComputeDevice {
        guard ["ane", "neural-engine", "gpu", "cpu"].contains(name) else {
            throw Failure("unknown --device '\(name)' (auto, ane, gpu, cpu)")
        }
        FileHandle.standardError.write("wfinfo-mac: note: --device \(name) ignored: \(computeDeviceNote)\n".data(using: .utf8)!)
        return nil
    }
    switch name {
    case "auto": return nil
    case "ane", "neural-engine":
        guard let device = MLComputeDevice.allComputeDevices.first(where: {
            if case .neuralEngine = $0 { return true } else { return false }
        }) else { throw Failure("this Mac reports no Neural Engine") }
        return device
    case "gpu":
        guard let device = MLComputeDevice.allComputeDevices.first(where: {
            if case .gpu = $0 { return true } else { return false }
        }) else { throw Failure("this Mac reports no GPU compute device") }
        return device
    case "cpu":
        guard let device = MLComputeDevice.allComputeDevices.first(where: {
            if case .cpu = $0 { return true } else { return false }
        }) else { throw Failure("this Mac reports no CPU compute device") }
        return device
    default:
        throw Failure("unknown --device '\(name)' (auto, ane, gpu, cpu)")
    }
}

func deviceName(_ device: MLComputeDevice) -> String {
    switch device {
    case .cpu: return "cpu"
    case .gpu(let gpu): return "gpu:\(gpu.metalDevice.name)"
    case .neuralEngine(let ane): return "ane:\(ane.totalCoreCount)-core"
    @unknown default: return "unknown"
    }
}

#if compiler(>=6.2)
func stageName(_ stage: ComputeStage) -> String {
    switch stage {
    case .main: return "main"
    case .postProcessing: return "postProcessing"
    @unknown default: return "\(stage)"
    }
}
#endif

/// Swift Vision text request (macOS 15+). A pinned device is set for every
/// stage that lists it; stages that do not list it keep Vision's choice.
func makeTextRequest(fast: Bool, correction: Bool, languages: [String], device: MLComputeDevice?) -> RecognizeTextRequest {
    var request = RecognizeTextRequest()
    request.recognitionLevel = fast ? .fast : .accurate
    request.usesLanguageCorrection = correction
    request.recognitionLanguages = languages.map { Locale.Language(identifier: $0) }
    request.minimumTextHeightFraction = 0
    #if compiler(>=6.2)
    if let device {
        for (stage, devices) in request.supportedComputeStageDevices where devices.contains(device) {
            request.setComputeDevice(device, for: stage)
        }
    }
    #endif
    return request
}

func loadImage(_ path: String) throws -> CGImage {
    let data: Data
    if path == "-" {
        data = FileHandle.standardInput.readDataToEndOfFile()
    } else {
        guard let bytes = FileManager.default.contents(atPath: path) else { throw Failure("cannot read \(path)") }
        data = bytes
    }
    return try decodeImage(data, label: path)
}

func decodeImage(_ data: Data, label: String) throws -> CGImage {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw Failure("not an image: \(label)")
    }
    return image
}

/// `--frames`: stdin holds images back to back, each a 4-byte big-endian
/// length then the encoded image (PNG). No file is written anywhere.
func readFrames() throws -> [Data] {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    var frames: [Data] = []
    var offset = input.startIndex
    while offset < input.endIndex {
        guard input.endIndex - offset >= 4 else { throw Failure("truncated frame header at byte \(offset)") }
        let length = input[offset..<offset + 4].reduce(0) { ($0 << 8) | Int($1) }
        offset += 4
        guard length > 0, input.endIndex - offset >= length else { throw Failure("truncated frame \(frames.count)") }
        frames.append(input.subdata(in: offset..<offset + length))
        offset += length
    }
    return frames
}

/// Recognized lines top to bottom, left to right, with pixel boxes (top-left origin).
/// `origin` is added to every box: pass a crop's origin to get full-image coordinates.
func recognize(_ image: CGImage, request: RecognizeTextRequest, origin: CGPoint = .zero) async throws -> [[String: Any]] {
    let observations = try await request.perform(on: image)
    let size = CGSize(width: image.width, height: image.height)
    let lines = observations.compactMap { observation -> (CGRect, RecognizedText)? in
        guard let best = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox.toImageCoordinates(size, origin: .upperLeft)
        return (box.offsetBy(dx: origin.x, dy: origin.y), best)
    }
    // Same row when the top edges differ by less than half the smaller line height.
    let ordered = lines.sorted { a, b in
        if abs(a.0.minY - b.0.minY) > min(a.0.height, b.0.height) / 2 { return a.0.minY < b.0.minY }
        return a.0.minX < b.0.minX
    }
    return ordered.map { box, text in
        [
            "text": text.string,
            "confidence": rounded(Double(text.confidence)),
            "box": [
                "x": rounded(box.minX, 10),
                "y": rounded(box.minY, 10),
                "width": rounded(box.width, 10),
                "height": rounded(box.height, 10),
            ],
        ]
    }
}

func runOcr(_ raw: ArraySlice<String>) async throws {
    let args = try Arguments(raw, valueFlags: ["--lang", "--device"])
    // Each source is a file path, "-" (one image on stdin) or an in-memory frame.
    enum Source { case path(String), frame(Int, Data) }
    let sources: [Source]
    if args.switches.contains("--frames") {
        sources = try readFrames().enumerated().map { Source.frame($0.offset, $0.element) }
        if sources.isEmpty { throw Failure("ocr --frames got no frames on stdin") }
    } else {
        sources = args.positional.map { Source.path($0) }
        if sources.isEmpty { throw Failure("ocr expects image paths, - for one image on stdin, or --frames") }
    }
    let fast = args.switches.contains("--fast")
    let correction = args.switches.contains("--correction")
    let languages = (args.flags["--lang"] ?? "en-US").split(separator: ",").map(String.init)
    let deviceChoice = args.flags["--device"] ?? "auto"
    let device = try computeDevice(named: deviceChoice)

    let started = Date()
    // One task per image: the requests run concurrently, results keep input order.
    let results = await withTaskGroup(of: (Int, [String: Any]).self) { group -> [[String: Any]] in
        for (index, source) in sources.enumerated() {
            group.addTask {
                let begin = Date()
                var entry: [String: Any] = [:]
                do {
                    let image: CGImage
                    switch source {
                    case .path(let path):
                        entry["file"] = path
                        image = try loadImage(path)
                    case .frame(let number, let data):
                        entry["frame"] = number
                        image = try decodeImage(data, label: "frame \(number)")
                    }
                    let request = makeTextRequest(fast: fast, correction: correction, languages: languages, device: device)
                    let lines = try await recognize(image, request: request)
                    entry["width"] = image.width
                    entry["height"] = image.height
                    entry["lines"] = lines
                    entry["text"] = lines.compactMap { $0["text"] as? String }.joined(separator: "\n")
                    entry["error"] = NSNull()
                } catch {
                    entry["lines"] = []
                    entry["text"] = ""
                    entry["error"] = "\(error)"
                }
                entry["ms"] = rounded(Date().timeIntervalSince(begin) * 1000, 10)
                return (index, entry)
            }
        }
        var ordered = [[String: Any]](repeating: [:], count: sources.count)
        for await (index, entry) in group { ordered[index] = entry }
        return ordered
    }

    printJSON([
        "engine": "vision",
        "api": "RecognizeTextRequest",
        "level": fast ? "fast" : "accurate",
        "languageCorrection": correction,
        "languages": languages,
        "device": device.map(deviceName) ?? "auto",
        "ms": rounded(Date().timeIntervalSince(started) * 1000, 10),
        "results": results,
    ])
}

func runDevices() throws {
    let request = makeTextRequest(fast: false, correction: false, languages: ["en-US"], device: nil)
    var stages: [String: [String]] = [:]
    #if compiler(>=6.2)
    for (stage, devices) in request.supportedComputeStageDevices {
        stages[stageName(stage)] = devices.map(deviceName)
    }
    #endif
    var answer: [String: Any] = [
        "request": "RecognizeTextRequest (accurate)",
        "revision": "\(request.revision)",
        "allComputeDevices": MLComputeDevice.allComputeDevices.map(deviceName),
        "stages": stages,
        "canPinComputeDevice": canPinComputeDevice,
    ]
    if !canPinComputeDevice { answer["note"] = computeDeviceNote }
    printJSON(answer)
}

// MARK: - Displays and windows

func displayName(_ id: CGDirectDisplayID) -> String? {
    NSScreen.screens.first {
        ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id
    }?.localizedName
}

func runDisplays() throws {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success else { throw Failure("CGGetActiveDisplayList failed") }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { throw Failure("CGGetActiveDisplayList failed") }

    let displays: [[String: Any]] = ids.prefix(Int(count)).map { id in
        let bounds = CGDisplayBounds(id)
        let mode = CGDisplayCopyDisplayMode(id)
        return [
            "id": Int(id),
            "name": displayName(id) ?? "Display \(id)",
            "main": CGDisplayIsMain(id) != 0,
            "builtin": CGDisplayIsBuiltin(id) != 0,
            "x": Int(bounds.minX),
            "y": Int(bounds.minY),
            "width": Int(bounds.width),
            "height": Int(bounds.height),
            "pixelWidth": mode?.pixelWidth ?? Int(bounds.width),
            "pixelHeight": mode?.pixelHeight ?? Int(bounds.height),
        ]
    }
    printJSON(displays)
}

func runWindows() throws {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        throw Failure("CGWindowListCopyWindowInfo returned nothing")
    }
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var windows: [[String: Any]] = []
    for info in list {
        guard (info[kCGWindowLayer as String] as? Int) == 0,
              let id = info[kCGWindowNumber as String] as? Int,
              let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDict),
              bounds.width >= 200, bounds.height >= 150 else { continue }
        let pid = info[kCGWindowOwnerPID as String] as? Int32 ?? 0
        windows.append([
            "id": id,
            "owner": info[kCGWindowOwnerName as String] as? String ?? "unknown",
            "pid": Int(pid),
            "title": info[kCGWindowName as String] as? String ?? "",
            "x": Int(bounds.minX),
            "y": Int(bounds.minY),
            "width": Int(bounds.width),
            "height": Int(bounds.height),
            "frontmost": pid == frontPid,
        ])
    }
    printJSON(windows)
}

// MARK: - Capture

func pngData(_ image: CGImage) throws -> Data {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 1, nil) else {
        throw Failure("cannot create a PNG encoder")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw Failure("cannot encode the PNG") }
    return data as Data
}

/// What to capture: one window (--window), one display (--display), else the main display.
struct CaptureTarget {
    let filter: SCContentFilter
    /// `capture` JSON "target": "<app> <window id>" or "display <id>".
    let label: String
    /// `rewards` JSON "source": "window <id>" or "display <id>".
    let source: String
}

func captureTarget(display displayText: String?, window windowText: String?) async throws -> CaptureTarget {
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
        throw Failure("screen capture is not allowed (\(error.localizedDescription)). Grant Screen Recording to the app that started this command in System Settings > Privacy & Security > Screen & System Audio Recording, then restart that app.")
    }

    if let windowText {
        guard let id = UInt32(windowText), let window = content.windows.first(where: { $0.windowID == id }) else {
            throw Failure("window \(windowText) is not on screen")
        }
        return CaptureTarget(
            filter: SCContentFilter(desktopIndependentWindow: window),
            label: "\(window.owningApplication?.applicationName ?? "window") \(id)",
            source: "window \(id)")
    }
    let display: SCDisplay?
    if let displayText {
        guard let id = UInt32(displayText) else { throw Failure("--display expects a numeric display id") }
        display = content.displays.first { $0.displayID == id }
    } else {
        display = content.displays.first { $0.displayID == CGMainDisplayID() } ?? content.displays.first
    }
    guard let display else { throw Failure("display \(displayText ?? "main") is not connected") }
    return CaptureTarget(
        filter: SCContentFilter(display: display, excludingWindows: []),
        label: "display \(display.displayID)",
        source: "display \(display.displayID)")
}

/// Full pixel resolution, no cursor, no window shadow. Returns the image and its point-to-pixel scale.
func captureImage(_ filter: SCContentFilter) async throws -> (CGImage, CGFloat) {
    let config = SCStreamConfiguration()
    let scale = CGFloat(filter.pointPixelScale)
    config.width = max(1, Int((filter.contentRect.width * scale).rounded()))
    config.height = max(1, Int((filter.contentRect.height * scale).rounded()))
    config.showsCursor = false
    config.ignoreShadowsSingleWindow = true
    config.captureResolution = .best
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    return (image, scale)
}

func runCapture(_ raw: ArraySlice<String>) async throws {
    let args = try Arguments(raw, valueFlags: ["--display", "--window"])
    guard let out = args.positional.first else { throw Failure("capture expects an output .png path, or - for stdout") }

    let target = try await captureTarget(display: args.flags["--display"], window: args.flags["--window"])
    let label = target.label

    let begin = Date()
    let (image, scale) = try await captureImage(target.filter)
    let png = try pngData(image)
    if out == "-" {
        // The PNG itself is the output: no file, no JSON.
        FileHandle.standardOutput.write(png)
        return
    }
    guard FileManager.default.createFile(atPath: out, contents: png) else { throw Failure("cannot write \(out)") }
    printJSON([
        "path": out,
        "target": label,
        "width": image.width,
        "height": image.height,
        "scale": Double(scale),
        "ms": rounded(Date().timeIntervalSince(begin) * 1000, 10),
    ])
}

// MARK: - Reward screen

func parseNumber(_ text: String, flag: String) throws -> Double {
    guard let value = Double(text), value.isFinite else { throw Failure("\(flag) expects a number, got '\(text)'") }
    return value
}

func requiredNumber(_ args: Arguments, _ flag: String, command: String) throws -> Double {
    guard let text = args.flags[flag] else { throw Failure("\(command) needs \(flag)") }
    return try parseNumber(text, flag: flag)
}

/// The reward-name strip in image pixels (top-left origin). W and H are the
/// image size; w, h, y, l are WFInfo's 1080p constants; a..b is the UI scale
/// range. The box is deliberately generous: .NET filters the exact rows.
func rewardCrop(width: Int, height: Int, rewardWidth w: Double, rewardHeight h: Double,
                rewardY y: Double, lineHeight l: Double, uiMin a: Double, uiMax b: Double) throws -> (Double, CGRect) {
    let W = Double(width), H = Double(height)
    let s = min(W / 1920, H / 1080)
    let cropWidth = (w + 40) * s * b
    let left = W / 2 - cropWidth / 2
    let right = left + cropWidth
    let top = H / 2 - (y - h + l + 24) * s * b
    let bottom = H / 2 - (y - h) * 0.5 * s * a
    // Round outward, then clamp to the image.
    let x0 = max(0, left.rounded(.down)), x1 = min(W, right.rounded(.up))
    let y0 = max(0, top.rounded(.down)), y1 = min(H, bottom.rounded(.up))
    guard x1 > x0, y1 > y0 else {
        throw Failure("the reward crop is empty for a \(width)x\(height) image (x \(left)..\(right), y \(top)..\(bottom))")
    }
    return (s, CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0))
}

/// A crop of `image` (`rect` in pixels, top-left origin). `cropping(to:)`
/// shares the pixels; a redraw is the fallback for images it refuses.
func cropImage(_ image: CGImage, to rect: CGRect) throws -> CGImage {
    if let cropped = image.cropping(to: rect) { return cropped }
    guard let context = CGContext(data: nil, width: Int(rect.width), height: Int(rect.height), bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw Failure("cannot crop the image")
    }
    // CGContext has a bottom-left origin: shift the image so the crop lands at (0, 0).
    context.draw(image, in: CGRect(x: -rect.minX, y: rect.maxY - CGFloat(image.height),
                                   width: CGFloat(image.width), height: CGFloat(image.height)))
    guard let cropped = context.makeImage() else { throw Failure("cannot crop the image") }
    return cropped
}

func savePNG(_ image: CGImage, to path: String) throws {
    let png = try pngData(image)
    guard FileManager.default.createFile(atPath: path, contents: png) else { throw Failure("cannot write \(path)") }
}

func runRewards(_ raw: ArraySlice<String>) async throws {
    let args = try Arguments(raw, valueFlags: [
        "--display", "--window", "--file", "--reward-width", "--reward-height", "--reward-y", "--line-height",
        "--ui-scale", "--ui-scale-min", "--ui-scale-max", "--save", "--lang", "--device",
    ])
    if let extra = args.positional.first { throw Failure("rewards: unexpected argument '\(extra)'") }
    if ["--display", "--window", "--file"].filter({ args.flags[$0] != nil }).count > 1 {
        throw Failure("rewards takes only one of --display, --window or --file")
    }
    let w = try requiredNumber(args, "--reward-width", command: "rewards")
    let h = try requiredNumber(args, "--reward-height", command: "rewards")
    let y = try requiredNumber(args, "--reward-y", command: "rewards")
    let l = try requiredNumber(args, "--line-height", command: "rewards")
    guard w > 0, h > 0, l > 0 else { throw Failure("--reward-width, --reward-height and --line-height must be positive") }
    let a: Double, b: Double
    if let uText = args.flags["--ui-scale"] {
        guard args.flags["--ui-scale-min"] == nil, args.flags["--ui-scale-max"] == nil else {
            throw Failure("use --ui-scale, or --ui-scale-min with --ui-scale-max, not both")
        }
        a = try parseNumber(uText, flag: "--ui-scale")
        b = a
    } else {
        guard let minText = args.flags["--ui-scale-min"], let maxText = args.flags["--ui-scale-max"] else {
            throw Failure("rewards needs --ui-scale, or --ui-scale-min and --ui-scale-max")
        }
        a = try parseNumber(minText, flag: "--ui-scale-min")
        b = try parseNumber(maxText, flag: "--ui-scale-max")
    }
    guard a > 0, b >= a else { throw Failure("the UI scale range must satisfy 0 < min <= max (got \(a)..\(b))") }
    let fast = args.switches.contains("--fast")
    let correction = args.switches.contains("--correction")
    let languages = (args.flags["--lang"] ?? "en-US").split(separator: ",").map(String.init)
    let device = try computeDevice(named: args.flags["--device"] ?? "auto")

    let started = Date()
    let image: CGImage
    let source: String
    if let path = args.flags["--file"] {
        image = try loadImage(path)
        source = "file \(path)"
    } else {
        let target = try await captureTarget(display: args.flags["--display"], window: args.flags["--window"])
        (image, _) = try await captureImage(target.filter)
        source = target.source
    }
    let captureMs = Date().timeIntervalSince(started) * 1000

    let (s, crop) = try rewardCrop(width: image.width, height: image.height, rewardWidth: w, rewardHeight: h,
                                   rewardY: y, lineHeight: l, uiMin: a, uiMax: b)
    let ocrBegin = Date()
    // The raw colour crop: no threshold, no colour filter.
    let strip = try cropImage(image, to: crop)
    let request = makeTextRequest(fast: fast, correction: correction, languages: languages, device: device)
    let lines = try await recognize(strip, request: request, origin: crop.origin)
    let ocrMs = Date().timeIntervalSince(ocrBegin) * 1000

    var saved: Any = NSNull()
    if let path = args.flags["--save"] {
        try savePNG(image, to: path)
        saved = path
    }

    printJSON([
        "source": source,
        "width": image.width,
        "height": image.height,
        "screenScaling": rounded(s, 1_000_000),
        "uiScaleMin": a,
        "uiScaleMax": b,
        "crop": ["x": Int(crop.minX), "y": Int(crop.minY), "width": Int(crop.width), "height": Int(crop.height)],
        "lines": lines,
        "saved": saved,
        "api": "RecognizeTextRequest",
        "level": fast ? "fast" : "accurate",
        "device": device.map(deviceName) ?? "auto",
        "ms": [
            "capture": rounded(captureMs, 10),
            "ocr": rounded(ocrMs, 10),
            "total": rounded(Date().timeIntervalSince(started) * 1000, 10),
        ],
    ])
}

// MARK: - Drawing (selfcheck, synth)

/// An in-memory sRGB bitmap. Every method takes top-left-origin coordinates.
final class Canvas {
    let context: CGContext
    let width: Int
    let height: Int

    init(width: Int, height: Int) throws {
        guard width > 0, height > 0,
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw Failure("cannot create a \(width)x\(height) bitmap")
        }
        self.context = context
        self.width = width
        self.height = height
        context.textMatrix = .identity
    }

    /// Top-left rect to CoreGraphics' bottom-left rect.
    func flip(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX, y: CGFloat(height) - rect.maxY, width: rect.width, height: rect.height)
    }

    func fill(_ rect: CGRect, _ color: CGColor) {
        context.setFillColor(color)
        context.fill(flip(rect))
    }

    func fillEllipse(_ rect: CGRect, _ color: CGColor) {
        context.setFillColor(color)
        context.fillEllipse(in: flip(rect))
    }

    func stroke(_ rect: CGRect, _ color: CGColor, width lineWidth: CGFloat) {
        context.setStrokeColor(color)
        context.setLineWidth(lineWidth)
        context.stroke(flip(rect))
    }

    /// Draws `line` with its typographic top-left at (x, top); returns the
    /// typographic box (ascent + descent tall).
    @discardableResult
    func draw(_ line: CTLine, x: CGFloat, top: CGFloat) -> CGRect {
        var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
        let width = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, &leading))
        context.textPosition = CGPoint(x: x, y: CGFloat(height) - (top + ascent))
        CTLineDraw(line, context)
        return CGRect(x: x, y: top, width: width, height: ascent + descent)
    }

    /// Adds deterministic per-channel noise in -amplitude...amplitude.
    func addNoise(_ rng: inout SplitMix64, amplitude: Int) {
        guard amplitude > 0, let base = context.data else { return }
        let bytes = base.bindMemory(to: UInt8.self, capacity: context.bytesPerRow * height)
        let span = UInt64(2 * amplitude + 1)
        for row in 0..<height {
            let rowStart = row * context.bytesPerRow
            for column in 0..<width {
                let pixel = rowStart + column * 4
                var bits = rng.next()
                for channel in 0..<3 {
                    let delta = Int(bits % span) - amplitude
                    bits /= span
                    let value = Int(bytes[pixel + channel]) + delta
                    bytes[pixel + channel] = UInt8(clamping: value)
                }
            }
        }
    }

    func image() throws -> CGImage {
        guard let image = context.makeImage() else { throw Failure("cannot render the bitmap") }
        return image
    }
}

/// Deterministic random numbers (SplitMix64), so --seed reproduces a fixture.
struct SplitMix64 {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }
    mutating func range(_ low: Double, _ high: Double) -> Double { low + (high - low) * unit() }
    mutating func pick<T>(_ items: [T]) -> T { items[Int(next() % UInt64(items.count))] }
}

func srgb(_ r: Double, _ g: Double, _ b: Double, _ alpha: Double = 1) -> CGColor {
    CGColor(srgbRed: r, green: g, blue: b, alpha: alpha)
}

func parseColor(_ text: String) throws -> CGColor {
    let hex = text.hasPrefix("#") ? String(text.dropFirst()) : text
    guard hex.count == 6, let value = UInt32(hex, radix: 16) else { throw Failure("--color expects #RRGGBB, got '\(text)'") }
    return srgb(Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255)
}

func boldFont(_ size: CGFloat) -> CTFont { CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil) }
func plainFont(_ size: CGFloat) -> CTFont { CTFontCreateWithName("Helvetica" as CFString, size, nil) }

func textLine(_ text: String, font: CTFont, color: CGColor) -> CTLine {
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
    ]
    return CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
}

func lineWidth(_ line: CTLine) -> CGFloat { CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)) }

/// Greedy word wrap into at most `maxLines` lines no wider than `width`; nil when it does not fit.
func wrap(_ text: String, font: CTFont, width: CGFloat, maxLines: Int) -> [String]? {
    var lines: [String] = []
    var current = ""
    for word in text.split(separator: " ").map(String.init) {
        let candidate = current.isEmpty ? word : current + " " + word
        if lineWidth(textLine(candidate, font: font, color: srgb(0, 0, 0))) <= width {
            current = candidate
            continue
        }
        if current.isEmpty { return nil } // one word wider than the box
        lines.append(current)
        current = word
        if lineWidth(textLine(current, font: font, color: srgb(0, 0, 0))) > width { return nil }
    }
    if !current.isEmpty { lines.append(current) }
    return lines.count <= maxLines ? lines : nil
}

// MARK: - Self-check

func runSelfcheck(_ raw: ArraySlice<String>) async throws {
    let args = try Arguments(raw, valueFlags: ["--text", "--save", "--device"])
    let text = args.flags["--text"] ?? "Volt Prime Blueprint"
    let device = try computeDevice(named: args.flags["--device"] ?? "auto")

    // Black on white, 1400x260, about 64 px high, centred; nothing touches disk.
    let canvas = try Canvas(width: 1400, height: 260)
    canvas.fill(CGRect(x: 0, y: 0, width: 1400, height: 260), srgb(1, 1, 1))
    var size: CGFloat = 64
    var line = textLine(text, font: plainFont(size), color: srgb(0, 0, 0))
    while lineWidth(line) > 1400 * 0.92, size > 12 {
        size -= 2
        line = textLine(text, font: plainFont(size), color: srgb(0, 0, 0))
    }
    let glyphs = CTLineGetImageBounds(line, canvas.context)
    canvas.context.textPosition = CGPoint(x: 700 - glyphs.midX, y: 130 - glyphs.midY)
    CTLineDraw(line, canvas.context)
    let image = try canvas.image()

    let begin = Date()
    let request = makeTextRequest(fast: false, correction: false, languages: ["en-US"], device: device)
    let lines = try await recognize(image, request: request)
    let ms = rounded(Date().timeIntervalSince(begin) * 1000, 10)

    var saved: Any = NSNull()
    if let path = args.flags["--save"] {
        try savePNG(image, to: path)
        saved = path
    }
    printJSON([
        "text": lines.compactMap { $0["text"] as? String }.joined(separator: " "),
        "lines": lines,
        "ms": ms,
        "saved": saved,
    ])
}

// MARK: - Synthetic reward screen

func runSynth(_ raw: ArraySlice<String>) throws {
    let args = try Arguments(raw, valueFlags: [
        "--out", "--width", "--height", "--ui-scale", "--names", "--color", "--squad", "--seed", "--line-height",
    ])
    guard let out = args.flags["--out"] else { throw Failure("synth needs --out <png>") }
    guard let namesText = args.flags["--names"] else { throw Failure("synth needs --names \"A|B|C\"") }
    let names = namesText.split(separator: "|", omittingEmptySubsequences: false).map {
        $0.trimmingCharacters(in: .whitespaces).uppercased()
    }
    guard (1...4).contains(names.count), !names.contains(where: \.isEmpty) else {
        throw Failure("--names expects 1 to 4 non-empty names separated by |")
    }
    let squad = (args.flags["--squad"] ?? "").split(separator: "|", omittingEmptySubsequences: false).map(String.init)
    guard let width = Int(args.flags["--width"] ?? "1920"), let height = Int(args.flags["--height"] ?? "1080"),
          width >= 320, height >= 240 else { throw Failure("--width and --height expect whole numbers (at least 320x240)") }
    let u = try parseNumber(args.flags["--ui-scale"] ?? "1.0", flag: "--ui-scale")
    guard u > 0 else { throw Failure("--ui-scale must be positive") }
    let lineHeight = try parseNumber(args.flags["--line-height"] ?? "48", flag: "--line-height")
    guard let seed = UInt64(args.flags["--seed"] ?? "1") else { throw Failure("--seed expects a whole number") }
    let nameColor = try parseColor(args.flags["--color"] ?? "#BEA966")

    let W = CGFloat(width), H = CGFloat(height)
    let s = min(W / 1920, H / 1080)
    let k = s * CGFloat(u) // 1080p units to pixels
    let n = names.count
    let slot = 242 * k
    let cardTop = H / 2 - 235 * k, cardBottom = H / 2 - 60 * k
    let rowTop = H / 2 - (316 - 235 + CGFloat(lineHeight)) * k
    var rng = SplitMix64(seed: seed)
    let canvas = try Canvas(width: width, height: height)

    // Background: gradient, coloured shapes, noise.
    let colors = (0..<3).map { _ in srgb(rng.range(0.03, 0.35), rng.range(0.03, 0.3), rng.range(0.05, 0.4)) }
    canvas.fill(CGRect(x: 0, y: 0, width: W, height: H), colors[0]) // opaque base under everything
    if let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: [0, 0.5, 1]) {
        canvas.context.drawLinearGradient(gradient, start: CGPoint(x: rng.range(0, Double(W)), y: 0),
                                          end: CGPoint(x: rng.range(0, Double(W)), y: H),
                                          options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }
    for _ in 0..<70 {
        let size = CGSize(width: rng.range(20, 420) * s, height: rng.range(20, 300) * s)
        let rect = CGRect(x: rng.range(-50, Double(W)), y: rng.range(-50, Double(H)), width: size.width, height: size.height)
        let color = srgb(rng.unit(), rng.unit(), rng.unit(), rng.range(0.12, 0.5))
        if rng.unit() < 0.5 { canvas.fillEllipse(rect, color) } else { canvas.fill(rect, color) }
    }
    canvas.addNoise(&rng, amplitude: 14)

    // Distractor words, never inside the card band (the name and squad rows).
    let band = CGRect(x: 0, y: cardTop - 12 * k, width: W, height: cardBottom - cardTop + 24 * k)
    let words = ["VOID", "FISSURE", "RELIC", "LITH", "MESO", "NEO", "AXI", "REACTANT", "10/10", "TENNO",
                 "MISSION", "EXTRACTION", "ORBITER", "CREDITS", "ENDO", "WAVE 5"]
    var placed: [CGRect] = []
    for _ in 0..<12 {
        let line = textLine(rng.pick(words), font: rng.unit() < 0.5 ? boldFont(rng.range(14, 32) * s) : plainFont(rng.range(14, 32) * s),
                            color: srgb(rng.range(0.3, 1), rng.range(0.3, 1), rng.range(0.3, 1)))
        let wordWidth = lineWidth(line), wordHeight = 40 * s
        for _ in 0..<60 {
            let rect = CGRect(x: rng.range(0, Double(W - wordWidth)), y: rng.range(0, Double(H - wordHeight)),
                              width: wordWidth, height: wordHeight)
            if rect.intersects(band) || placed.contains(where: { $0.intersects(rect) }) { continue }
            canvas.draw(line, x: rect.minX, top: rect.minY)
            placed.append(rect)
            break
        }
    }
    // "SELECT A REWARD" far above the cards.
    let title = textLine("SELECT A REWARD", font: boldFont(30 * k), color: srgb(0.92, 0.92, 0.88))
    canvas.draw(title, x: W / 2 - lineWidth(title) / 2, top: cardTop - 90 * k)

    // Cards, "1 OWNED", names, squad names.
    var slots: [[String: Any]] = []
    for (index, name) in names.enumerated() {
        let centre = W / 2 + (CGFloat(index) - CGFloat(n - 1) / 2) * slot
        let card = CGRect(x: centre - slot * 0.47, y: cardTop, width: slot * 0.94, height: cardBottom - cardTop)
        canvas.fill(card, srgb(0.04, 0.05, 0.07, 0.82))
        canvas.stroke(card.insetBy(dx: 1 * k, dy: 1 * k), srgb(0.55, 0.5, 0.35, 0.8), width: max(1, 1.5 * k))

        let owned = textLine("1 OWNED", font: plainFont(11 * k), color: srgb(0.85, 0.85, 0.85))
        canvas.draw(owned, x: centre - lineWidth(owned) / 2, top: cardTop + 8 * k)

        // Names: bold caps, at most 2 lines inside 0.9 of the slot; shrink a long name until it fits.
        var size = 17 * k
        var wrapped = wrap(name, font: boldFont(size), width: slot * 0.9, maxLines: 2)
        while wrapped == nil, size > 9 * k {
            size *= 0.95
            wrapped = wrap(name, font: boldFont(size), width: slot * 0.9, maxLines: 2)
        }
        guard let nameLines = wrapped else { throw Failure("name '\(name)' does not fit in two lines") }
        var boxes: [[String: Any]] = []
        for (row, text) in nameLines.enumerated() {
            let line = textLine(text, font: boldFont(size), color: nameColor)
            let box = canvas.draw(line, x: centre - lineWidth(line) / 2, top: rowTop + 4 * k + CGFloat(row) * 20 * k)
            boxes.append(["text": text, "box": [
                "x": rounded(box.minX, 10), "y": rounded(box.minY, 10),
                "width": rounded(box.width, 10), "height": rounded(box.height, 10),
            ]])
        }
        var entry: [String: Any] = ["name": name, "centreX": rounded(centre, 10), "fontSize": rounded(size, 10), "lines": boxes]
        let player = index < squad.count ? squad[index] : ""
        if !player.isEmpty {
            let line = textLine(player, font: plainFont(12 * k), color: srgb(0.9, 0.9, 0.92))
            canvas.draw(line, x: centre - lineWidth(line) / 2, top: H / 2 - 81 * k + 14 * k)
            entry["squad"] = player
        }
        slots.append(entry)
    }
    canvas.addNoise(&rng, amplitude: 4)

    try savePNG(try canvas.image(), to: out)
    printJSON([
        "path": out,
        "width": width,
        "height": height,
        "screenScaling": rounded(Double(s), 1_000_000),
        "uiScale": u,
        "seed": Int(seed),
        "nameRows": ["top": rounded(rowTop, 10), "bottom": rounded(rowTop + CGFloat(lineHeight) * k, 10)],
        "slots": slots,
    ])
}

// MARK: - Hotkey

let keyCodes: [String: Int] = [
    "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
    "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
    "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
    "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
    "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y,
    "z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
    "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8,
    "9": kVK_ANSI_9, "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5,
    "f6": kVK_F6, "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11,
    "f12": kVK_F12, "f13": kVK_F13, "f14": kVK_F14, "f15": kVK_F15, "space": kVK_Space,
]

func parseHotkey(_ text: String) throws -> (UInt32, UInt32) {
    var modifiers: UInt32 = 0
    var key: Int?
    for part in text.lowercased().split(separator: "+").map(String.init) {
        switch part {
        case "ctrl", "control": modifiers |= UInt32(controlKey)
        case "alt", "opt", "option": modifiers |= UInt32(optionKey)
        case "shift": modifiers |= UInt32(shiftKey)
        case "cmd", "command": modifiers |= UInt32(cmdKey)
        default:
            guard let code = keyCodes[part] else { throw Failure("unknown key '\(part)' in --key \(text)") }
            key = code
        }
    }
    guard let key else { throw Failure("--key \(text) names no key") }
    return (UInt32(key), modifiers)
}

final class HotkeyState {
    static var url = URL(string: "http://127.0.0.1:8000/scan/run")!
    static var quiet = false
    static var busy = false
    /// --fire: run one scan right after registering, then exit with its result.
    static var fireOnce = false
}

func play(_ name: String) {
    if !HotkeyState.quiet { NSSound(named: NSSound.Name(name))?.play() }
}

func log(_ text: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    print("\(stamp) \(text)")
    fflush(stdout)
}

func triggerScan() {
    if HotkeyState.busy {
        log("scan already running; press ignored")
        return
    }
    HotkeyState.busy = true
    play("Tink")
    log("hotkey: POST \(HotkeyState.url.absoluteString)")
    var request = URLRequest(url: HotkeyState.url, timeoutInterval: 200)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    URLSession.shared.dataTask(with: request) { data, response, error in
        DispatchQueue.main.async {
            HotkeyState.busy = false
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            var message = error?.localizedDescription ?? "HTTP \(status)"
            if let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                message = (body["message"] as? String) ?? (body["error"] as? String) ?? message
            }
            log("scan: \(message)")
            play(status == 200 ? "Glass" : "Basso")
            if HotkeyState.fireOnce { exit(status == 200 ? 0 : 1) }
        }
    }.resume()
}

func runHotkey(_ raw: ArraySlice<String>) throws -> Never {
    let args = try Arguments(raw, valueFlags: ["--key", "--url"])
    let keyText = args.flags["--key"] ?? "ctrl+option+s"
    let (code, modifiers) = try parseHotkey(keyText)
    if let urlText = args.flags["--url"] {
        guard let url = URL(string: urlText) else { throw Failure("bad --url \(urlText)") }
        HotkeyState.url = url
    }
    HotkeyState.quiet = args.switches.contains("--quiet")
    HotkeyState.fireOnce = args.switches.contains("--fire")

    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)

    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let handlerStatus = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
        triggerScan()
        return noErr
    }, 1, &spec, nil, nil)
    guard handlerStatus == noErr else { throw Failure("InstallEventHandler failed (\(handlerStatus))") }

    var ref: EventHotKeyRef?
    let id = EventHotKeyID(signature: OSType(0x5746_494E), id: 1) // "WFIN"
    let status = RegisterEventHotKey(code, modifiers, id, GetApplicationEventTarget(), 0, &ref)
    guard status == noErr else { throw Failure("cannot register \(keyText) (\(status)); another app may own it") }

    log("hotkey \(keyText) registered; press it to scan via \(HotkeyState.url.absoluteString). Ctrl-C stops.")
    if HotkeyState.fireOnce { DispatchQueue.main.async { triggerScan() } }
    app.run()
    exit(0)
}

// MARK: - Entry

/// Runs an async subcommand from top-level code and waits for it.
func runAsync(_ body: @escaping @Sendable () async throws -> Void) throws {
    let done = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var failure: Error?
    Task {
        do { try await body() } catch { failure = error }
        done.signal()
    }
    done.wait()
    if let failure { throw failure }
}

let argv = CommandLine.arguments
guard argv.count >= 2 else {
    fail("usage: wfinfo-mac ocr|devices|displays|windows|capture|rewards|selfcheck|synth|hotkey ...", code: 2)
}

do {
    let rest = argv.dropFirst(2)
    switch argv[1] {
    case "ocr": try runAsync { try await runOcr(rest) }
    case "devices": try runDevices()
    case "displays": try runDisplays()
    case "windows": try runWindows()
    case "capture": try runAsync { try await runCapture(rest) }
    case "rewards": try runAsync { try await runRewards(rest) }
    case "selfcheck": try runAsync { try await runSelfcheck(rest) }
    case "synth": try runSynth(rest)
    case "hotkey": try runHotkey(rest)
    default: fail("unknown subcommand \(argv[1])", code: 2)
    }
} catch {
    fail("\(error)")
}
