// LumaBridgeDaemon.swift — Native macOS External Display Brightness & Scaling Daemon
// Supports Apple Silicon (IOAVService DDC/CI), CoreGraphics Software Gamma Dimming,
// Real-time F1/F2 Media Key Brightness Tracking, DisplayServices integration,
// and live config file reload.
// Designed for ZERO-FLICKER hardware DDC updates and butter-smooth optical transitions.

import Foundation
import Cocoa
import CoreGraphics
import IOKit

// MARK: - Private Apple Silicon IOAVService & DisplayServices Symbols
typealias IOAVServiceRef = CFTypeRef

@_silgen_name("IOAVServiceCreate")
func IOAVServiceCreate(_ allocator: CFAllocator?) -> Unmanaged<IOAVServiceRef>?

@_silgen_name("IOAVServiceCreateWithService")
func IOAVServiceCreateWithService(_ allocator: CFAllocator?, _ service: io_service_t) -> Unmanaged<IOAVServiceRef>?

@_silgen_name("IOAVServiceWriteI2C")
func IOAVServiceWriteI2C(
    _ service: IOAVServiceRef,
    _ chipAddress: UInt32,
    _ dataAddress: UInt32,
    _ inputBuffer: UnsafeMutableRawPointer,
    _ inputBufferSize: UInt32
) -> IOReturn

@_silgen_name("DisplayServicesGetBrightness")
func DisplayServicesGetBrightness(_ display: CGDirectDisplayID, _ brightness: UnsafeMutablePointer<Float>) -> Int32

@_silgen_name("DisplayServicesSetBrightness")
func DisplayServicesSetBrightness(_ display: CGDirectDisplayID, _ brightness: Float) -> Int32

// MARK: - Configuration Models
struct CurvePoint: Codable {
    let x: Double
    let y: Double
}

struct MappingConfig: Codable {
    let mode: String?
    let gammaExponent: Double?
    let softwareKnee: Double?
    let softwareMinFactor: Double?
    let hardwareMinClamp: Double?
    let hardwareMaxClamp: Double?
    let linkContrastBelowKnee: Bool?
    let contrastMinClamp: Double?
    let matchReferenceNits: Bool?
    let customPoints: [CurvePoint]?
}

struct ScalingProfile: Codable {
    let logicalWidth: Int?
    let logicalHeight: Int?
    let hidpi: Bool?
    let refreshRate: Int?
    let rotation: Int?
}

struct DisplayProfile: Codable {
    let id: String
    let name: String
    let modelCode: String?
    let isBuiltIn: Bool
    let transport: String
    let linkedToMaster: Bool
    var brightness: Double
    var contrast: Double
    let physicalMinNits: Double
    let physicalMaxNits: Double
    let scaling: ScalingProfile?
    let mapping: MappingConfig
}

struct DaemonSettings: Codable {
    let running: Bool?
    let ambientSyncEnabled: Bool?
    let pollIntervalMs: Int?
    let ddcDebounceMs: Int?
    let interPacketDelayMs: Int?
    let retryCount: Int?
    let interceptMediaKeys: Bool?
    let reapplyOnWake: Bool?
    let smoothTransitionMs: Int?
}

struct LumaConfig: Codable {
    let schemaVersion: Int?
    var masterBrightness: Double?
    let referenceDisplayId: String?
    let daemon: DaemonSettings?
    var displays: [DisplayProfile]
}

// MARK: - DDC/CI Hardware Controller (Apple Silicon IOAVService)
final class AppleSiliconDDC {
    private let ddcChipAddress: UInt32 = 0x37
    private let ddcDataAddress: UInt32 = 0x51

    func discoverAVServices() -> [IOAVServiceRef] {
        var services: [IOAVServiceRef] = []
        var iterator: io_iterator_t = 0
        guard let matching = IOServiceMatching("DCPAVServiceProxy") else { return services }
        let kr = IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator)
        guard kr == KERN_SUCCESS else { return services }
        defer { IOObjectRelease(iterator) }

        var entry = IOIteratorNext(iterator)
        while entry != 0 {
            if let prop = IORegistryEntryCreateCFProperty(entry, "Location" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String,
               prop == "External",
               let av = IOAVServiceCreateWithService(kCFAllocatorDefault, entry)?.takeRetainedValue() {
                services.append(av)
            }
            IOObjectRelease(entry)
            entry = IOIteratorNext(iterator)
        }
        return services
    }

    @discardableResult
    func writeVCP(service: IOAVServiceRef, vcpCode: UInt8, value: UInt16, retries: Int = 2, delayMs: Int = 25) -> Bool {
        var packet: [UInt8] = [
            0x84,                      // Length (4 bytes following)
            0x03,                      // Set VCP Feature
            vcpCode,                   // 0x10 = Luminance, 0x12 = Contrast
            UInt8((value >> 8) & 0xFF),
            UInt8(value & 0xFF),
            0x00                       // XOR Checksum byte
        ]
        var checksum: UInt8 = 0x6E ^ 0x51
        for i in 0..<5 { checksum ^= packet[i] }
        packet[5] = checksum

        for attempt in 0..<max(1, retries) {
            let result = packet.withUnsafeMutableBytes { buf -> IOReturn in
                guard let ptr = buf.baseAddress else { return kIOReturnBadArgument }
                return IOAVServiceWriteI2C(service, ddcChipAddress, ddcDataAddress, ptr, UInt32(buf.count))
            }
            if result == kIOReturnSuccess { return true }
            if attempt < retries - 1 {
                usleep(useconds_t(max(15, delayMs) * 1000))
            }
        }
        return false
    }
}

// MARK: - CoreGraphics Gamma & HiDPI Controller
final class CoreGraphicsDisplayController {
    func applySoftwareGamma(displayID: CGDirectDisplayID, factor: Double) {
        let clamped = max(0.01, min(1.0, factor))
        let tableSize: UInt32 = 256
        var redTable = [CGGammaValue](repeating: 0, count: Int(tableSize))
        var greenTable = [CGGammaValue](repeating: 0, count: Int(tableSize))
        var blueTable = [CGGammaValue](repeating: 0, count: Int(tableSize))

        for i in 0..<Int(tableSize) {
            let norm = Float(i) / Float(tableSize - 1)
            let val = CGGammaValue(norm * Float(clamped))
            redTable[i] = val
            greenTable[i] = val
            blueTable[i] = val
        }

        CGSetDisplayTransferByTable(displayID, tableSize, &redTable, &greenTable, &blueTable)
    }

    func applyHiDPIScaling(displayID: CGDirectDisplayID, profile: ScalingProfile) -> Bool {
        guard let modeList = CGDisplayCopyAllDisplayModes(displayID, nil) as? [CGDisplayMode] else { return false }
        for mode in modeList {
            let logicalW = mode.width
            let logicalH = mode.height
            let isHiDPI = mode.pixelWidth > mode.width
            let refresh = Int(round(mode.refreshRate))

            let targetW = profile.logicalWidth ?? 1920
            let targetH = profile.logicalHeight ?? 1080
            let targetHiDPI = profile.hidpi ?? false
            let targetRefresh = profile.refreshRate ?? 60

            if logicalW == targetW &&
               logicalH == targetH &&
               isHiDPI == targetHiDPI &&
               (targetRefresh <= 0 || refresh == targetRefresh) {
                var configRef: CGDisplayConfigRef?
                if CGBeginDisplayConfiguration(&configRef) == .success, let ref = configRef {
                    CGConfigureDisplayWithDisplayMode(ref, displayID, mode, nil)
                    CGCompleteDisplayConfiguration(ref, .permanently)
                    return true
                }
            }
        }
        return false
    }
}

// MARK: - Colorimetric Math & Spline Evaluator
func lStarToLinear(_ lStar: Double) -> Double {
    let l = max(0.0, min(100.0, lStar))
    if l <= 8.0 {
        return (l / 903.3)
    }
    let p = (l + 16.0) / 116.0
    return pow(p, 3.0)
}

func evaluateCustomSpline(_ points: [CurvePoint], xInput: Double) -> Double {
    guard points.count >= 2 else { return xInput }
    let sorted = points.sorted { $0.x < $1.x }
    if xInput <= sorted.first!.x { return sorted.first!.y }
    if xInput >= sorted.last!.x { return sorted.last!.y }

    for i in 0..<(sorted.count - 1) {
        let p0 = sorted[i]
        let p1 = sorted[i + 1]
        if xInput >= p0.x && xInput <= p1.x {
            let span = max(p1.x - p0.x, 0.001)
            let t = (xInput - p0.x) / span
            let smoothT = t * t * (3.0 - 2.0 * t)
            return max(0.0, min(100.0, p0.y + (p1.y - p0.y) * smoothT))
        }
    }
    return xInput
}

func computeMappedOutput(profile: DisplayProfile, inputPercent: Double, referenceNits: Double? = nil) -> (ddc: UInt16, gamma: Double, contrast: UInt16) {
    let input = max(0.0, min(100.0, inputPercent))
    let m = profile.mapping
    let allowSoft = profile.transport == "combined"
    let knee = allowSoft ? max(0.0, min(60.0, m.softwareKnee ?? 0.0)) : 0.0
    let matchRef = m.matchReferenceNits ?? false
    let hwMin = max(0.0, min(100.0, m.hardwareMinClamp ?? 0.0))
    let hwMax = max(hwMin, min(100.0, m.hardwareMaxClamp ?? 100.0))
    let minFactor = m.softwareMinFactor ?? 0.18
    let contrastMin = m.contrastMinClamp ?? 50.0
    let linkContrast = m.linkContrastBelowKnee ?? false
    let gammaExp = m.gammaExponent ?? 1.65
    let mode = m.mode ?? "dual-stage"

    // Reference Match mode: solve for physical nits matching built-in screen
    if matchRef, let refNits = referenceNits {
        let targetNits = max(1.0, min(profile.physicalMaxNits, refNits))
        let nitsAtHwMin = profile.physicalMinNits + (hwMin / 100.0) * (profile.physicalMaxNits - profile.physicalMinNits)
        let nitsAtHwMax = profile.physicalMinNits + (hwMax / 100.0) * (profile.physicalMaxNits - profile.physicalMinNits)

        if targetNits < nitsAtHwMin && profile.transport != "ddc-ci" {
            let gammaNeeded = max(minFactor, min(1.0, targetNits / max(nitsAtHwMin, 1.0)))
            let contrast = linkContrast
                ? UInt16(round(contrastMin + gammaNeeded * (profile.contrast - contrastMin)))
                : UInt16(round(profile.contrast))
            return (UInt16(round(hwMin)), gammaNeeded, contrast)
        }

        let ratio = max(0.0, min(1.0, (targetNits - nitsAtHwMin) / max(nitsAtHwMax - nitsAtHwMin, 1.0)))
        let ddcVal = round(hwMin + ratio * (hwMax - hwMin))
        return (UInt16(max(0, min(100, ddcVal))), 1.0, UInt16(round(profile.contrast)))
    }

    if profile.transport == "software-gamma" {
        let unit = mode == "perceptual"
            ? lStarToLinear(input)
            : (mode == "custom-spline" ? evaluateCustomSpline(m.customPoints ?? [], xInput: input) / 100.0 : pow(input / 100.0, gammaExp))
        let gamma = max(minFactor, min(1.0, minFactor + unit * (1.0 - minFactor)))
        return (75, gamma, UInt16(round(profile.contrast)))
    }

    if allowSoft && knee > 0 && input < knee {
        let ratio = input / knee
        let shaped = pow(ratio, mode == "perceptual" ? 1.35 : min(gammaExp, 2.0))
        let gamma = max(minFactor, min(1.0, minFactor + shaped * (1.0 - minFactor)))
        let contrast = linkContrast
            ? UInt16(round(contrastMin + gamma * (profile.contrast - contrastMin)))
            : UInt16(round(profile.contrast))
        return (UInt16(round(hwMin)), gamma, contrast)
    }

    let normalized = max(0.0, min(1.0, (input - knee) / max(1.0, 100.0 - knee)))
    let mappedUnit: Double
    switch mode {
    case "perceptual":
        mappedUnit = lStarToLinear(normalized * 100.0)
    case "custom-spline":
        mappedUnit = evaluateCustomSpline(m.customPoints ?? [], xInput: input) / 100.0
    default:
        mappedUnit = pow(normalized, gammaExp)
    }
    let ddcVal = round(hwMin + mappedUnit * (hwMax - hwMin))
    return (UInt16(max(0, min(100, ddcVal))), 1.0, UInt16(round(profile.contrast)))
}

// MARK: - Butter-Smooth Software Gamma Animator (100% Flicker-Free GPU Transitions)
final class SoftwareGammaAnimator {
    private var timer: DispatchSourceTimer?
    private(set) var currentFactor: Double = 1.0

    func animate(to target: Double, displayID: CGDirectDisplayID, duration: Double = 0.12, controller: CoreGraphicsDisplayController) {
        timer?.cancel()
        timer = nil

        let start = currentFactor
        if abs(start - target) < 0.005 || duration <= 0.01 {
            currentFactor = target
            controller.applySoftwareGamma(displayID: displayID, factor: target)
            return
        }

        let steps = 6
        let interval = duration / Double(steps)
        var step = 0

        let src = DispatchSource.makeTimerSource(queue: .main)
        src.schedule(deadline: .now(), repeating: interval)
        src.setEventHandler { [weak self] in
            guard let self = self else { return }
            step += 1
            let progress = min(1.0, Double(step) / Double(steps))
            let eased = progress * (2.0 - progress) // Ease out quadratic
            let val = start + (target - start) * eased
            self.currentFactor = val
            controller.applySoftwareGamma(displayID: displayID, factor: val)

            if progress >= 1.0 {
                self.timer?.cancel()
                self.timer = nil
                self.currentFactor = target
            }
        }
        self.timer = src
        src.resume()
    }
}

// MARK: - Daemon Runtime Loop & Real-Time Brightness Observer
final class LumaBridgeDaemon {
    private let configURL: URL
    private var config: LumaConfig
    private let ddc = AppleSiliconDDC()
    private let cg = CoreGraphicsDisplayController()
    private let ddcQueue = DispatchQueue(label: "com.lumabridge.ddc", qos: .userInitiated)

    private var fileSource: DispatchSourceFileSystemObject?
    private var brightnessPollTimer: Timer?
    private var lastObservedBrightness: Float = -1.0
    private var lastApplyTimestamp: TimeInterval = 0
    private var debounceWorkItem: DispatchWorkItem?

    private var lastWrittenDDC: [String: UInt16] = [:]
    private var lastWrittenContrast: [String: UInt16] = [:]
    private var gammaAnimators: [String: SoftwareGammaAnimator] = [:]

    init(configPath: String) throws {
        self.configURL = URL(fileURLWithPath: configPath)
        let data = try Data(contentsOf: configURL)
        self.config = try JSONDecoder().decode(LumaConfig.self, from: data)
    }

    func start() {
        fputs("[LumaBridge] Starting background daemon (flicker-free single-write DDC + live F1/F2 sync)...\n", stdout)
        fflush(stdout)

        // Initial sync
        applyAllDisplays(applyScaling: true)

        // Listen for screen wake
        if config.daemon?.reapplyOnWake ?? true {
            NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.screensDidWakeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                fputs("[LumaBridge] Display wake detected — re-applying luminance & scaling profiles\n", stdout)
                fflush(stdout)
                self?.applyAllDisplays(applyScaling: true)
            }
        }

        // Live F1/F2 & Built-in Screen Brightness Tracking
        startBrightnessObserver()

        // Watch config file for changes from web UI
        watchConfigFile()

        RunLoop.main.run()
    }

    private func startBrightnessObserver() {
        var initial: Float = 0.5
        _ = DisplayServicesGetBrightness(CGMainDisplayID(), &initial)
        lastObservedBrightness = initial

        // Check for brightness key changes every 40ms
        brightnessPollTimer = Timer.scheduledTimer(withTimeInterval: 0.04, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            var current: Float = 0.0
            guard DisplayServicesGetBrightness(CGMainDisplayID(), &current) == 0 else { return }

            // Detect any brightness change from F1, F2, Control Center, or ALS
            if abs(current - self.lastObservedBrightness) >= 0.003 {
                self.lastObservedBrightness = current
                let currentPct = Double(current * 100.0)
                self.config.masterBrightness = currentPct

                let now = Date().timeIntervalSince1970
                let timeSinceLast = now - self.lastApplyTimestamp

                // If user is holding the key down, throttle at 120ms intervals
                if timeSinceLast >= 0.12 {
                    self.debounceWorkItem?.cancel()
                    self.debounceWorkItem = nil
                    self.lastApplyTimestamp = now
                    fputs("[LumaBridge] F1/F2 Sync (Throttled): \(String(format: "%.1f", currentPct))%\n", stdout)
                    fflush(stdout)
                    self.applyAllDisplays(applyScaling: false, referenceBrightnessPct: currentPct)
                } else {
                    // Otherwise debounce by 75ms so key taps settle before single DDC write
                    self.debounceWorkItem?.cancel()
                    let item = DispatchWorkItem { [weak self] in
                        guard let self = self else { return }
                        self.lastApplyTimestamp = Date().timeIntervalSince1970
                        fputs("[LumaBridge] F1/F2 Sync (Settled): \(String(format: "%.1f", currentPct))%\n", stdout)
                        fflush(stdout)
                        self.applyAllDisplays(applyScaling: false, referenceBrightnessPct: currentPct)
                    }
                    self.debounceWorkItem = item
                    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(75), execute: item)
                }
            }
        }
    }

    private func watchConfigFile() {
        fileSource?.cancel()
        let fd = open(configURL.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        source.setEventHandler { [weak self] in
            // Debounce file writes by 50ms so full payload is on disk
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(50)) {
                self?.reloadAndApply()
            }
            if source.data.contains(.rename) || source.data.contains(.delete) {
                self?.watchConfigFile()
            }
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        self.fileSource = source
    }

    private func reloadAndApply() {
        guard let data = try? Data(contentsOf: configURL),
              let updated = try? JSONDecoder().decode(LumaConfig.self, from: data) else { return }
        self.config = updated
        applyAllDisplays(applyScaling: false)
    }

    func applyAllDisplays(applyScaling: Bool, referenceBrightnessPct: Double? = nil) {
        let avServices = ddc.discoverAVServices()
        var displayCount: UInt32 = 0
        var activeIDs = [CGDirectDisplayID](repeating: 0, count: 16)
        CGGetActiveDisplayList(16, &activeIDs, &displayCount)
        let externalIDs = activeIDs.prefix(Int(displayCount)).filter { CGDisplayIsBuiltin($0) == 0 }

        // Compute reference display physical luminance in nits
        let refPct = referenceBrightnessPct ?? (config.masterBrightness ?? 64.0)
        let builtInProfile = config.displays.first(where: { $0.isBuiltIn })
        let minNits = builtInProfile?.physicalMinNits ?? 2.0
        let maxNits = builtInProfile?.physicalMaxNits ?? 500.0
        let refNits = minNits + lStarToLinear(refPct) * (maxNits - minNits)

        var extIdx = 0
        for profile in config.displays where !profile.isBuiltIn {
            let input = profile.linkedToMaster ? refPct : profile.brightness
            let out = computeMappedOutput(profile: profile, inputPercent: input, referenceNits: refNits)

            let service = extIdx < avServices.count ? avServices[extIdx] : nil
            let displayID = extIdx < externalIDs.count ? externalIDs[extIdx] : nil
            let retries = self.config.daemon?.retryCount ?? 2
            let delayMs = self.config.daemon?.interPacketDelayMs ?? 25
            let transport = profile.transport
            let ddcVal = out.ddc
            let contrastVal = out.contrast
            let targetGamma = out.gamma
            let profId = profile.id
            let profName = profile.name

            // 1. Butter-smooth GPU Gamma animation (100% flicker-free)
            if let dID = displayID {
                let animator = gammaAnimators[profId] ?? SoftwareGammaAnimator()
                gammaAnimators[profId] = animator
                animator.animate(to: targetGamma, displayID: dID, duration: 0.10, controller: self.cg)
            }

            // 2. Hardware DDC Write: Single clean write per target step (No 25ms flood = Zero Flicker)
            let prevDDC = lastWrittenDDC[profId]
            if prevDDC != ddcVal && transport != "software-gamma", let s = service {
                lastWrittenDDC[profId] = ddcVal
                ddcQueue.async { [weak self] in
                    guard let self = self else { return }
                    self.ddc.writeVCP(service: s, vcpCode: 0x10, value: ddcVal, retries: retries, delayMs: delayMs)
                    // Inter-display pause so multiple external displays never collide on I2C
                    usleep(25_000)
                }
                fputs("[LumaBridge] \(profName): DDC -> \(ddcVal) (target: \(String(format: "%.1f", refNits)) nits, gamma: \(String(format: "%.2f", targetGamma)))\n", stdout)
                fflush(stdout)
            }

            // 3. Hardware Contrast Write: Only if contrast changed
            let prevContrast = lastWrittenContrast[profId]
            if prevContrast != contrastVal, let s = service, profile.mapping.linkContrastBelowKnee ?? false {
                lastWrittenContrast[profId] = contrastVal
                ddcQueue.async { [weak self] in
                    guard let self = self else { return }
                    self.ddc.writeVCP(service: s, vcpCode: 0x12, value: contrastVal, retries: retries, delayMs: delayMs)
                    usleep(25_000)
                }
            }

            // 4. HiDPI Scaling profile (only applied on boot/wake/explicit change)
            if applyScaling, let dID = displayID, let sc = profile.scaling {
                let p = ScalingProfile(
                    logicalWidth: sc.logicalWidth ?? 1920,
                    logicalHeight: sc.logicalHeight ?? 1080,
                    hidpi: sc.hidpi ?? false,
                    refreshRate: sc.refreshRate ?? 60,
                    rotation: sc.rotation ?? 0
                )
                _ = self.cg.applyHiDPIScaling(displayID: dID, profile: p)
            }

            extIdx += 1
        }
    }
}

// Entry Point
let args = CommandLine.arguments
let configIndex = args.firstIndex(of: "--config").map { $0 + 1 }
let defaultPath = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/lumabridge/config.json").path
let path = (configIndex != nil && configIndex! < args.count) ? args[configIndex!] : defaultPath

do {
    let daemon = try LumaBridgeDaemon(configPath: path)
    daemon.start()
} catch {
    fputs("[LumaBridge] Failed to load config at \(path): \(error)\n", stderr)
    exit(1)
}
