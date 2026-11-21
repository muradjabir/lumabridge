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
    let syncAutoBrightness: Bool?
    let alsDeadbandPercent: Double?
    let alsSmoothingWindowMs: Int?
    let ddcRampStepMs: Int?
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

enum TransitionMode {
    case immediate
    case manual
    case ambientGentle
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

// MARK: - 60fps Cubic-Eased Software Gamma Animator (Flicker-Free GPU Transitions)
final class SoftwareGammaAnimator {
    private var timer: DispatchSourceTimer?
    private(set) var currentFactor: Double = 1.0
    private var targetFactor: Double = 1.0

    func animate(
        to target: Double,
        displayID: CGDirectDisplayID,
        duration: Double,
        gentle: Bool,
        controller: CoreGraphicsDisplayController
    ) {
        if abs(target - targetFactor) < 0.002 && timer != nil {
            return
        }
        targetFactor = target
        timer?.cancel()
        timer = nil

        let start = currentFactor
        if abs(start - target) < 0.003 || duration <= 0.015 {
            currentFactor = target
            controller.applySoftwareGamma(displayID: displayID, factor: target)
            return
        }

        let startTime = Date().timeIntervalSince1970
        let frameInterval: Double = 1.0 / 60.0

        let src = DispatchSource.makeTimerSource(queue: .main)
        src.schedule(deadline: .now(), repeating: frameInterval)
        src.setEventHandler { [weak self] in
            guard let self = self else { return }
            let elapsed = Date().timeIntervalSince1970 - startTime
            let progress = min(1.0, max(0.0, elapsed / duration))
            let eased: Double
            if gentle {
                // Smooth S-curve (Hermite) for imperceptible auto-brightness fades
                eased = progress * progress * (3.0 - 2.0 * progress)
            } else {
                // Responsive cubic ease-out for manual F1/F2 & slider updates
                let inv = 1.0 - progress
                eased = 1.0 - (inv * inv * inv)
            }
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

// MARK: - Coalescing Smooth Hardware DDC Ramp Controller
final class HardwareDDCRampController {
    private struct DisplayRampState {
        var displayName: String
        var serviceIndex: Int
        var currentDDC: Int?
        var targetDDC: Int
        var currentContrast: Int?
        var targetContrast: Int?
        var gentle: Bool
        var stepMs: Int
        var smoothTransitionMs: Int
        var retries: Int
        var retryDelayMs: Int
        var lastStepAt: TimeInterval
    }

    private let ddc: AppleSiliconDDC
    private let queue = DispatchQueue(label: "com.lumabridge.ddc.ramp", qos: .userInitiated)
    private var cachedServices: [IOAVServiceRef] = []
    private var states: [String: DisplayRampState] = [:]
    private var rampTimer: DispatchSourceTimer?

    init(ddc: AppleSiliconDDC) {
        self.ddc = ddc
    }

    func invalidateServices() {
        queue.async { [weak self] in
            self?.cachedServices.removeAll()
        }
    }

    func setTarget(
        displayId: String,
        displayName: String,
        serviceIndex: Int,
        ddcValue: UInt16,
        contrastValue: UInt16?,
        mode: TransitionMode,
        stepMs: Int,
        smoothTransitionMs: Int,
        retries: Int,
        retryDelayMs: Int
    ) {
        queue.async { [weak self] in
            guard let self = self else { return }
            let targetInt = Int(ddcValue)
            let contrastInt = contrastValue.map { Int($0) }
            let now = Date().timeIntervalSince1970

            var state = self.states[displayId] ?? DisplayRampState(
                displayName: displayName,
                serviceIndex: serviceIndex,
                currentDDC: nil,
                targetDDC: targetInt,
                currentContrast: nil,
                targetContrast: contrastInt,
                gentle: mode == .ambientGentle,
                stepMs: stepMs,
                smoothTransitionMs: smoothTransitionMs,
                retries: retries,
                retryDelayMs: retryDelayMs,
                lastStepAt: 0
            )

            state.displayName = displayName
            state.serviceIndex = serviceIndex
            state.targetDDC = targetInt
            state.targetContrast = contrastInt
            state.gentle = (mode == .ambientGentle)
            state.stepMs = max(35, min(250, stepMs))
            state.smoothTransitionMs = max(0, min(600, smoothTransitionMs))
            state.retries = max(1, min(5, retries))
            state.retryDelayMs = max(15, min(100, retryDelayMs))

            // On first boot/wake or when smoothing is disabled, apply immediately so monitors sync cleanly
            let shouldJumpImmediately = (mode == .immediate) || (state.currentDDC == nil) || (state.smoothTransitionMs == 0)
            if shouldJumpImmediately {
                if state.currentDDC != targetInt {
                    if self.writeWithCache(serviceIndex: serviceIndex, vcpCode: 0x10, value: UInt16(targetInt), retries: state.retries, delayMs: state.retryDelayMs) {
                        state.currentDDC = targetInt
                        state.lastStepAt = now
                        fputs("[LumaBridge] \(displayName): DDC -> \(targetInt) (direct)\n", stdout)
                        fflush(stdout)
                    }
                }
                if let cTarget = contrastInt, state.currentContrast != cTarget {
                    usleep(20_000)
                    if self.writeWithCache(serviceIndex: serviceIndex, vcpCode: 0x12, value: UInt16(cTarget), retries: state.retries, delayMs: state.retryDelayMs) {
                        state.currentContrast = cTarget
                    }
                }
                self.states[displayId] = state
                return
            }

            self.states[displayId] = state
            self.ensureTimerRunning()
        }
    }

    private func ensureServicesLoaded() {
        if cachedServices.isEmpty {
            cachedServices = ddc.discoverAVServices()
        }
    }

    @discardableResult
    private func writeWithCache(serviceIndex: Int, vcpCode: UInt8, value: UInt16, retries: Int, delayMs: Int) -> Bool {
        ensureServicesLoaded()
        guard serviceIndex >= 0 && serviceIndex < cachedServices.count else {
            cachedServices = ddc.discoverAVServices()
            guard serviceIndex >= 0 && serviceIndex < cachedServices.count else { return false }
            return ddc.writeVCP(service: cachedServices[serviceIndex], vcpCode: vcpCode, value: value, retries: retries, delayMs: delayMs)
        }
        if ddc.writeVCP(service: cachedServices[serviceIndex], vcpCode: vcpCode, value: value, retries: retries, delayMs: delayMs) {
            return true
        }
        // Refresh cached IOAVService handles once on I2C failure (e.g. dock/cable reconnect)
        cachedServices = ddc.discoverAVServices()
        guard serviceIndex < cachedServices.count else { return false }
        return ddc.writeVCP(service: cachedServices[serviceIndex], vcpCode: vcpCode, value: value, retries: retries, delayMs: delayMs)
    }

    private func ensureTimerRunning() {
        guard rampTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(20))
        timer.setEventHandler { [weak self] in
            self?.tick()
        }
        rampTimer = timer
        timer.resume()
    }

    private func stopTimerIfIdle() {
        let hasWork = states.values.contains { st in
            let ddcPending = (st.currentDDC ?? st.targetDDC) != st.targetDDC
            let contrastPending = (st.targetContrast != nil && st.currentContrast != st.targetContrast)
            return ddcPending || contrastPending
        }
        if !hasWork {
            rampTimer?.cancel()
            rampTimer = nil
        }
    }

    private func tick() {
        let orderedKeys = states.keys.sorted { (states[$0]?.serviceIndex ?? 0) < (states[$1]?.serviceIndex ?? 0) }
        var wroteOnThisTick = false

        for key in orderedKeys {
            guard var st = states[key] else { continue }
            let current = st.currentDDC ?? st.targetDDC
            let diff = st.targetDDC - current
            let contrastNeedsUpdate = (st.targetContrast != nil && st.currentContrast != st.targetContrast)

            if diff == 0 && !contrastNeedsUpdate {
                continue
            }

            let now = Date().timeIntervalSince1970
            let intervalSec: Double
            if st.gentle {
                // Slow, imperceptible 1-step-at-a-time slewing for auto-brightness drift
                intervalSec = max(0.14, Double(st.stepMs) * 1.8 / 1000.0)
            } else {
                // Smooth, responsive paced steps for manual F1/F2 & sliders
                intervalSec = max(0.035, Double(st.stepMs) / 1000.0)
            }

            guard (now - st.lastStepAt) >= intervalSec else { continue }

            if wroteOnThisTick {
                // Small inter-display I2C pause so dual external monitors never collide
                usleep(20_000)
            }

            if diff != 0 {
                let stepSize: Int
                if st.gentle {
                    stepSize = 1
                } else {
                    let absDiff = abs(diff)
                    let maxTicks = max(2.0, Double(max(180, st.smoothTransitionMs)) / Double(max(35, st.stepMs)))
                    stepSize = min(absDiff, max(1, Int(ceil(Double(absDiff) / maxTicks))))
                }
                let nextVal = current + (diff > 0 ? stepSize : -stepSize)
                if writeWithCache(serviceIndex: st.serviceIndex, vcpCode: 0x10, value: UInt16(nextVal), retries: st.retries, delayMs: st.retryDelayMs) {
                    st.currentDDC = nextVal
                    st.lastStepAt = Date().timeIntervalSince1970
                    wroteOnThisTick = true
                    if nextVal == st.targetDDC {
                        let tag = st.gentle ? "ALS smooth" : "manual smooth"
                        fputs("[LumaBridge] \(st.displayName): DDC settled -> \(nextVal) (\(tag))\n", stdout)
                        fflush(stdout)
                    }
                } else {
                    // Back off briefly if monitor is asleep/busy
                    st.lastStepAt = Date().timeIntervalSince1970 + 0.25
                }
            } else if let cTarget = st.targetContrast, st.currentContrast != cTarget {
                let cCurrent = st.currentContrast ?? cTarget
                let cDiff = cTarget - cCurrent
                let cStep = st.gentle ? 1 : min(abs(cDiff), max(1, abs(cDiff) / 2))
                let nextC = cCurrent + (cDiff > 0 ? cStep : -cStep)
                if writeWithCache(serviceIndex: st.serviceIndex, vcpCode: 0x12, value: UInt16(nextC), retries: st.retries, delayMs: st.retryDelayMs) {
                    st.currentContrast = nextC
                    st.lastStepAt = Date().timeIntervalSince1970
                    wroteOnThisTick = true
                }
            }

            states[key] = st
        }

        stopTimerIfIdle()
    }
}

// MARK: - Display Reconfiguration C Callback
private func lumabridgeDisplayReconfigCallback(
    _ display: CGDirectDisplayID,
    _ flags: CGDisplayChangeSummaryFlags,
    _ userInfo: UnsafeMutableRawPointer?
) {
    guard !flags.contains(.beginConfigurationFlag), let ptr = userInfo else { return }
    let daemon = Unmanaged<LumaBridgeDaemon>.fromOpaque(ptr).takeUnretainedValue()
    DispatchQueue.main.async {
        daemon.handleDisplayReconfiguration()
    }
}

// MARK: - Daemon Runtime Loop & Real-Time Manual vs. Auto-Brightness Observer
final class LumaBridgeDaemon {
    private let configURL: URL
    private var config: LumaConfig
    private let ddc = AppleSiliconDDC()
    private let cg = CoreGraphicsDisplayController()
    private lazy var ddcRamp = HardwareDDCRampController(ddc: ddc)

    private var fileSource: DispatchSourceFileSystemObject?
    private var brightnessPollTimer: Timer?

    // Velocity classifier & ALS low-pass state
    private var lastSampleBrightnessPct: Double = -1.0
    private var emaBrightnessPct: Double = -1.0
    private var lastCommittedBrightnessPct: Double = -1.0
    private var recentDeltas: [(time: TimeInterval, delta: Double)] = []
    private var manualModeUntil: TimeInterval = 0
    private var lastManualApplyTime: TimeInterval = 0
    private var manualDebounceWorkItem: DispatchWorkItem?
    private var lastAlsCommitTime: TimeInterval = 0
    private var lastAlsDirection: Int = 0

    private var gammaAnimators: [String: SoftwareGammaAnimator] = [:]
    private var reconfigDebounceItem: DispatchWorkItem?
    private var lastConfigMasterBrightness: Double?

    init(configPath: String) throws {
        self.configURL = URL(fileURLWithPath: configPath)
        let data = try Data(contentsOf: configURL)
        self.config = try JSONDecoder().decode(LumaConfig.self, from: data)
        self.lastConfigMasterBrightness = self.config.masterBrightness
    }

    func start() {
        fputs("[LumaBridge] Starting background daemon (smooth DDC ramping + ALS low-pass & deadband filter)...\n", stdout)
        fflush(stdout)

        // Register CoreGraphics display hotplug / reconfiguration observer to refresh cached IOAVServices
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        CGDisplayRegisterReconfigurationCallback(lumabridgeDisplayReconfigCallback, selfPtr)

        // Initial direct sync
        applyAllDisplays(applyScaling: true, mode: .immediate)

        // Listen for screen wake
        if config.daemon?.reapplyOnWake ?? true {
            NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.screensDidWakeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                fputs("[LumaBridge] Display wake detected — refreshing I2C handles & restoring profiles\n", stdout)
                fflush(stdout)
                self?.ddcRamp.invalidateServices()
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(450)) {
                    self?.applyAllDisplays(applyScaling: true, mode: .immediate)
                }
            }
        }

        // Live F1/F2 & Auto-Brightness (ALS) Tracking
        startBrightnessObserver()

        // Watch config file for live updates from LumaBridge app / web UI
        watchConfigFile()

        RunLoop.main.run()
    }

    func handleDisplayReconfiguration() {
        ddcRamp.invalidateServices()
        reconfigDebounceItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.applyAllDisplays(applyScaling: false, mode: .immediate)
        }
        reconfigDebounceItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(500), execute: item)
    }

    private func startBrightnessObserver() {
        var initial: Float = 0.5
        if DisplayServicesGetBrightness(CGMainDisplayID(), &initial) == 0 {
            let pct = Double(initial) * 100.0
            lastSampleBrightnessPct = pct
            emaBrightnessPct = pct
            lastCommittedBrightnessPct = pct
        } else {
            let fallback = config.masterBrightness ?? 50.0
            lastSampleBrightnessPct = fallback
            emaBrightnessPct = fallback
            lastCommittedBrightnessPct = fallback
        }

        // Poll built-in DisplayServices brightness every 40ms
        brightnessPollTimer = Timer.scheduledTimer(withTimeInterval: 0.04, repeats: true) { [weak self] _ in
            self?.pollBuiltInBrightnessTick()
        }
    }

    private func pollBuiltInBrightnessTick() {
        guard config.daemon?.running ?? true else { return }

        var raw: Float = 0.0
        guard DisplayServicesGetBrightness(CGMainDisplayID(), &raw) == 0 else { return }

        let now = Date().timeIntervalSince1970
        let currentPct = max(0.0, min(100.0, Double(raw) * 100.0))

        if lastSampleBrightnessPct < 0 {
            lastSampleBrightnessPct = currentPct
            emaBrightnessPct = currentPct
            lastCommittedBrightnessPct = currentPct
            return
        }

        let deltaPct = currentPct - lastSampleBrightnessPct
        let absDelta = abs(deltaPct)
        lastSampleBrightnessPct = currentPct

        // Maintain rolling 180ms delta window to distinguish manual key/slider moves from slow ALS drift
        if absDelta > 0.01 {
            recentDeltas.append((time: now, delta: deltaPct))
        }
        recentDeltas.removeAll { (now - $0.time) > 0.18 }
        let rollingNetDelta = abs(recentDeltas.reduce(0.0) { $0 + $1.delta })

        // Standard F1/F2 step = 6.25%, Option+Shift fine step = 1.5625%, Control Center slider > 2.2%/180ms.
        // macOS Auto-Brightness (ALS) dribbles slowly at < 0.8% per 40ms tick.
        let isManualImpulse = (absDelta >= 1.25) || (rollingNetDelta >= 2.2)
        if isManualImpulse {
            manualModeUntil = now + 0.65
        }

        let inManualMode = (now <= manualModeUntil)

        if inManualMode {
            // Manual F1/F2 or Control Center slider adjustment: responsive & smooth
            emaBrightnessPct = currentPct
            guard abs(currentPct - lastCommittedBrightnessPct) >= 0.35 else { return }

            let debounceMs = max(35, min(140, config.daemon?.ddcDebounceMs ?? 45))
            let timeSinceLastManual = now - lastManualApplyTime

            if timeSinceLastManual >= 0.12 {
                manualDebounceWorkItem?.cancel()
                manualDebounceWorkItem = nil
                lastManualApplyTime = now
                lastCommittedBrightnessPct = currentPct
                config.masterBrightness = currentPct
                fputs("[LumaBridge] Manual Brightness Sync: \(String(format: "%.1f", currentPct))%\n", stdout)
                fflush(stdout)
                applyAllDisplays(applyScaling: false, referenceBrightnessPct: currentPct, mode: .manual)
            } else {
                manualDebounceWorkItem?.cancel()
                let capturedPct = currentPct
                let item = DispatchWorkItem { [weak self] in
                    guard let self = self else { return }
                    self.lastManualApplyTime = Date().timeIntervalSince1970
                    self.lastCommittedBrightnessPct = capturedPct
                    self.config.masterBrightness = capturedPct
                    fputs("[LumaBridge] Manual Brightness Sync (Settled): \(String(format: "%.1f", capturedPct))%\n", stdout)
                    fflush(stdout)
                    self.applyAllDisplays(applyScaling: false, referenceBrightnessPct: capturedPct, mode: .manual)
                }
                manualDebounceWorkItem = item
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(debounceMs), execute: item)
            }
            return
        }

        // Gradual Auto-Brightness (ALS) drift path
        let ambientLoopEnabled = config.daemon?.ambientSyncEnabled ?? true
        let syncAutoBrightness = config.daemon?.syncAutoBrightness ?? true
        if !ambientLoopEnabled || !syncAutoBrightness {
            // Keep EMA aligned silently without touching external monitors
            emaBrightnessPct = currentPct
            return
        }

        // First-order discrete EMA low-pass filter (dt = 0.04s)
        let smoothingMs = max(400, min(6000, config.daemon?.alsSmoothingWindowMs ?? 2000))
        let tauSec = Double(smoothingMs) / 1000.0
        let alpha = 1.0 - exp(-0.04 / tauSec)
        emaBrightnessPct += alpha * (currentPct - emaBrightnessPct)

        // Hysteresis deadband + direction-reversal suppression to eliminate ping-ponging
        let baseDeadband = max(0.5, min(10.0, config.daemon?.alsDeadbandPercent ?? 3.0))
        let signedDrift = emaBrightnessPct - lastCommittedBrightnessPct
        let direction = signedDrift >= 0 ? 1 : -1
        let isRecentReversal = (lastAlsDirection != 0) && (direction != lastAlsDirection) && ((now - lastAlsCommitTime) < max(12.0, tauSec * 5.0))
        let requiredDeadband = isRecentReversal ? (baseDeadband * 1.4) : baseDeadband
        let alsCooldown = max(0.8, tauSec * 0.75)

        if abs(signedDrift) >= requiredDeadband && (now - lastAlsCommitTime) >= alsCooldown {
            let committed = (emaBrightnessPct * 10.0).rounded() / 10.0
            lastCommittedBrightnessPct = committed
            lastAlsCommitTime = now
            lastAlsDirection = direction
            config.masterBrightness = committed
            fputs("[LumaBridge] Auto-Brightness (ALS) Gentle Sync: \(String(format: "%.1f", committed))% (raw \(String(format: "%.1f", currentPct))%, deadband \(String(format: "%.1f", requiredDeadband))%)\n", stdout)
            fflush(stdout)
            applyAllDisplays(applyScaling: false, referenceBrightnessPct: committed, mode: .ambientGentle)
        }
    }

    private func watchConfigFile() {
        fileSource?.cancel()
        let fd = open(configURL.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        source.setEventHandler { [weak self] in
            // Debounce file writes by 50ms so full payload is flushed on disk
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
        let masterChanged = (updated.masterBrightness != lastConfigMasterBrightness)
        self.lastConfigMasterBrightness = updated.masterBrightness
        self.config = updated

        if masterChanged, let master = updated.masterBrightness {
            self.lastCommittedBrightnessPct = master
            self.emaBrightnessPct = master
            applyAllDisplays(applyScaling: false, referenceBrightnessPct: master, mode: .manual)
        } else {
            let liveRef = lastCommittedBrightnessPct >= 0 ? lastCommittedBrightnessPct : (updated.masterBrightness ?? 64.0)
            applyAllDisplays(applyScaling: false, referenceBrightnessPct: liveRef, mode: .manual)
        }
    }

    func applyAllDisplays(applyScaling: Bool, referenceBrightnessPct: Double? = nil, mode: TransitionMode = .manual) {
        guard config.daemon?.running ?? true else { return }

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

        let retries = self.config.daemon?.retryCount ?? 2
        let retryDelayMs = self.config.daemon?.interPacketDelayMs ?? 25
        let smoothMs = self.config.daemon?.smoothTransitionMs ?? 260
        let stepMs = self.config.daemon?.ddcRampStepMs ?? 85

        let gammaDurationSec: Double
        switch mode {
        case .immediate:
            gammaDurationSec = 0.0
        case .manual:
            gammaDurationSec = smoothMs == 0 ? 0.0 : max(0.16, Double(smoothMs) / 1000.0)
        case .ambientGentle:
            gammaDurationSec = smoothMs == 0 ? 0.0 : max(0.65, Double(smoothMs) * 2.8 / 1000.0)
        }

        var extIdx = 0
        for profile in config.displays where !profile.isBuiltIn {
            let input = profile.linkedToMaster ? refPct : profile.brightness
            let out = computeMappedOutput(profile: profile, inputPercent: input, referenceNits: refNits)
            let displayID = extIdx < externalIDs.count ? externalIDs[extIdx] : nil

            // 1. 60fps Eased GPU Software Gamma Animation (100% flicker-free)
            if let dID = displayID {
                let animator = gammaAnimators[profile.id] ?? SoftwareGammaAnimator()
                gammaAnimators[profile.id] = animator
                animator.animate(
                    to: out.gamma,
                    displayID: dID,
                    duration: gammaDurationSec,
                    gentle: mode == .ambientGentle,
                    controller: self.cg
                )
            }

            // 2. Coalescing Smooth Paced Hardware DDC Ramp (zero snap, zero I2C flood)
            if profile.transport != "software-gamma" {
                let linkedContrast: UInt16? = (profile.mapping.linkContrastBelowKnee ?? false) ? out.contrast : nil
                ddcRamp.setTarget(
                    displayId: profile.id,
                    displayName: profile.name,
                    serviceIndex: extIdx,
                    ddcValue: out.ddc,
                    contrastValue: linkedContrast,
                    mode: mode,
                    stepMs: stepMs,
                    smoothTransitionMs: smoothMs,
                    retries: retries,
                    retryDelayMs: retryDelayMs
                )
            }

            // 3. HiDPI Scaling profile (only applied on boot/wake/explicit change)
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
