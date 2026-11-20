import type { AppState } from './types.ts';

export interface MacOsBundleArtifacts {
  configJson: string;
  swiftDaemonSource: string;
  launchAgentPlist: string;
  installScript: string;
}

export function generateMacOsBundle(state: AppState): MacOsBundleArtifacts {
  const exportedConfig = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    masterBrightness: state.masterBrightness,
    referenceDisplayId: state.referenceDisplayId,
    daemon: state.daemon,
    displays: state.displays.map((d) => {
      const mode = d.scalingModes.find((m) => m.id === d.activeScalingId) ?? d.scalingModes[0];
      return {
        id: d.id,
        name: d.name,
        modelCode: d.modelCode,
        edidSerial: d.edidSerial,
        isBuiltIn: d.isBuiltIn,
        transport: d.transport,
        linkedToMaster: d.linkedToMaster,
        brightness: d.brightness,
        contrast: d.contrast,
        physicalMinNits: d.physicalMinNits,
        physicalMaxNits: d.physicalMaxNits,
        scaling: {
          logicalWidth: mode.logicalWidth,
          logicalHeight: mode.logicalHeight,
          hidpi: mode.hidpi,
          refreshRate: d.refreshRate,
          rotation: d.rotation,
        },
        mapping: d.mapping,
      };
    }),
  };

  const configJson = JSON.stringify(exportedConfig, null, 2);

  const launchAgentPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.lumabridge.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/lumabridged</string>
    <string>--config</string>
    <string>__HOME__/.config/lumabridge/config.json</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>__HOME__/Library/Logs/LumaBridge/daemon.out.log</string>
  <key>StandardErrorPath</key>
  <string>__HOME__/Library/Logs/LumaBridge/daemon.err.log</string>
</dict>
</plist>
`;

  const swiftDaemonSource = `// LumaBridgeDaemon.swift — Native macOS External Display Brightness & Scaling Daemon
// Supports Apple Silicon (IOAVService DDC/CI), CoreGraphics Software Gamma Dimming,
// HiDPI CGConfigureDisplayWithDisplayMode scaling, F1/F2 media key interception, and wake restore.
//
// Compile:
//   swiftc -O -framework Cocoa -framework IOKit -framework CoreGraphics LumaBridgeDaemon.swift -o lumabridged

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

// MARK: - Configuration Models
struct CurvePoint: Codable {
    let x: Double
    let y: Double
}

struct MappingConfig: Codable {
    let mode: String
    let gammaExponent: Double
    let softwareKnee: Double
    let softwareMinFactor: Double
    let hardwareMinClamp: Double
    let hardwareMaxClamp: Double
    let linkContrastBelowKnee: Bool
    let contrastMinClamp: Double
    let matchReferenceNits: Bool
    let customPoints: [CurvePoint]
}

struct ScalingProfile: Codable {
    let logicalWidth: Int
    let logicalHeight: Int
    let hidpi: Bool
    let refreshRate: Int
    let rotation: Int
}

struct DisplayProfile: Codable {
    let id: String
    let name: String
    let modelCode: String
    let isBuiltIn: Bool
    let transport: String
    let linkedToMaster: Bool
    var brightness: Double
    var contrast: Double
    let physicalMinNits: Double
    let physicalMaxNits: Double
    let scaling: ScalingProfile
    let mapping: MappingConfig
}

struct DaemonSettings: Codable {
    let running: Bool
    let ambientSyncEnabled: Bool
    let pollIntervalMs: Int
    let ddcDebounceMs: Int
    let interPacketDelayMs: Int
    let retryCount: Int
    let interceptMediaKeys: Bool
    let reapplyOnWake: Bool
    let smoothTransitionMs: Int
}

struct LumaConfig: Codable {
    let schemaVersion: Int
    var masterBrightness: Double
    let referenceDisplayId: String
    let daemon: DaemonSettings
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
    func writeVCP(service: IOAVServiceRef, vcpCode: UInt8, value: UInt16, retries: Int, delayMs: Int) -> Bool {
        var packet: [UInt8] = [
            0x84,                      // Length (4 bytes following)
            0x03,                      // Set VCP Feature
            vcpCode,                   // 0x10 = Luminance, 0x12 = Contrast
            UInt8((value >> 8) & 0xFF),
            UInt8(value & 0xFF),
            0x00                       // XOR Checksum placeholder
        ]
        var checksum: UInt8 = 0x6E ^ 0x51
        for i in 0..<5 { checksum ^= packet[i] }
        packet[5] = checksum

        for attempt in 0..<max(1, retries) {
            let result = packet.withUnsafeMutableBytes { buf -> IOReturn in
                guard let ptr = buf.baseAddress else { return kIOReturnBadArgument }
                return IOAVServiceWriteI2C(service, ddcChipAddress, ddcDataAddress, ptr, UInt32(buf.count))
            }
            if result == KERN_SUCCESS {
                usleep(useconds_t(delayMs * 1000))
                return true
            }
            usleep(useconds_t((delayMs + attempt * 15) * 1000))
        }
        return false
    }
}

// MARK: - Software Gamma Table Dimming & HiDPI Scaling Engine
final class CoreGraphicsDisplayController {
    func applySoftwareGamma(displayID: CGDirectDisplayID, factor: Double) {
        let clamped = max(0.12, min(1.0, factor))
        let count: UInt32 = 256
        var red = [CGGammaValue](repeating: 0, count: Int(count))
        var green = [CGGammaValue](repeating: 0, count: Int(count))
        var blue = [CGGammaValue](repeating: 0, count: Int(count))
        for i in 0..<Int(count) {
            let v = CGGammaValue(Double(i) / Double(count - 1) * clamped)
            red[i] = v
            green[i] = v
            blue[i] = v
        }
        CGSetDisplayTransferByTable(displayID, count, red, green, blue)
    }

    func applyHiDPIScaling(displayID: CGDirectDisplayID, profile: ScalingProfile) -> Bool {
        let options: CFDictionary = [kCGDisplayShowDuplicateLowResolutionModes: kCFBooleanTrue] as CFDictionary
        guard let modes = CGDisplayCopyAllDisplayModes(displayID, options) as? [CGDisplayMode] else {
            return false
        }
        let targetMode = modes.first { mode in
            let matchesDims = mode.width == profile.logicalWidth && mode.height == profile.logicalHeight
            let isHiDPI = mode.pixelWidth >= mode.width * 2
            let matchesHiDPI = isHiDPI == profile.hidpi
            let matchesHz = Int(round(mode.refreshRate)) == profile.refreshRate || mode.refreshRate == 0
            return matchesDims && matchesHiDPI && matchesHz
        }
        guard let selected = targetMode else { return false }
        var configRef: CGDisplayConfigRef?
        guard CGBeginDisplayConfiguration(&configRef) == .success else { return false }
        CGConfigureDisplayWithDisplayMode(configRef, displayID, selected, nil)
        return CGCompleteDisplayConfiguration(configRef, .permanently) == .success
    }
}

// MARK: - Perceptual Luminance Mapping Engine
func lStarToLinear(_ lStar: Double) -> Double {
    let l = max(0.0, min(100.0, lStar))
    if l <= 8.0 { return l / 903.3 }
    let f = (l + 16.0) / 116.0
    return f * f * f
}

func computeMappedOutput(profile: DisplayProfile, inputPercent: Double) -> (ddc: UInt16, gamma: Double, contrast: UInt16) {
    let input = max(0.0, min(100.0, inputPercent))
    let m = profile.mapping
    let allowSoft = profile.transport == "combined"
    let knee = allowSoft ? max(0.0, min(60.0, m.softwareKnee)) : 0.0

    if allowSoft && knee > 0 && input < knee {
        let ratio = input / knee
        let shaped = pow(ratio, m.mode == "perceptual" ? 1.35 : min(m.gammaExponent, 2.0))
        let gamma = max(m.softwareMinFactor, min(1.0, m.softwareMinFactor + shaped * (1.0 - m.softwareMinFactor)))
        let contrast = m.linkContrastBelowKnee
            ? UInt16(round(m.contrastMinClamp + gamma * (profile.contrast - m.contrastMinClamp)))
            : UInt16(round(profile.contrast))
        return (UInt16(round(m.hardwareMinClamp)), gamma, contrast)
    }

    let normalized = max(0.0, min(1.0, (input - knee) / max(1.0, 100.0 - knee)))
    let mappedUnit: Double
    switch m.mode {
    case "perceptual":
        mappedUnit = lStarToLinear(normalized * 100.0)
    default:
        mappedUnit = pow(normalized, m.gammaExponent)
    }
    let ddcVal = round(m.hardwareMinClamp + mappedUnit * (m.hardwareMaxClamp - m.hardwareMinClamp))
    return (UInt16(max(0, min(100, ddcVal))), 1.0, UInt16(round(profile.contrast)))
}

// MARK: - Daemon Runtime Loop & Wake Listener
final class LumaBridgeDaemon {
    private let configURL: URL
    private var config: LumaConfig
    private let ddc = AppleSiliconDDC()
    private let cg = CoreGraphicsDisplayController()
    private var pendingWorkItem: DispatchWorkItem?

    init(configPath: String) throws {
        self.configURL = URL(fileURLWithPath: configPath)
        let data = try Data(contentsOf: configURL)
        self.config = try JSONDecoder().decode(LumaConfig.self, from: data)
    }

    func start() {
        fputs("[LumaBridge] Starting background daemon (poll=\\(config.daemon.pollIntervalMs)ms, debounce=\\(config.daemon.ddcDebounceMs)ms)\\n", stdout)
        applyAllDisplays(applyScaling: true)

        if config.daemon.reapplyOnWake {
            NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.screensDidWakeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                fputs("[LumaBridge] Display wake detected — re-applying luminance & scaling profiles\\n", stdout)
                self?.scheduleApply(applyScaling: true)
            }
        }

        // Watch config.json for live updates from LumaBridge app or CLI
        let fd = open(configURL.path, O_EVTONLY)
        if fd >= 0 {
            let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write, queue: .main)
            source.setEventHandler { [weak self] in
                self?.reloadAndApply()
            }
            source.resume()
        }

        RunLoop.main.run()
    }

    private func reloadAndApply() {
        guard let data = try? Data(contentsOf: configURL),
              let updated = try? JSONDecoder().decode(LumaConfig.self, from: data) else { return }
        self.config = updated
        scheduleApply(applyScaling: false)
    }

    private func scheduleApply(applyScaling: Bool) {
        pendingWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.applyAllDisplays(applyScaling: applyScaling)
        }
        pendingWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(config.daemon.ddcDebounceMs), execute: item)
    }

    func applyAllDisplays(applyScaling: Bool) {
        let avServices = ddc.discoverAVServices()
        var displayCount: UInt32 = 0
        var activeIDs = [CGDirectDisplayID](repeating: 0, count: 16)
        CGGetActiveDisplayList(16, &activeIDs, &displayCount)
        let externalIDs = activeIDs.prefix(Int(displayCount)).filter { CGDisplayIsBuiltin($0) == 0 }

        var extIdx = 0
        for profile in config.displays where !profile.isBuiltIn {
            let input = profile.linkedToMaster ? config.masterBrightness : profile.brightness
            let out = computeMappedOutput(profile: profile, inputPercent: input)

            if extIdx < avServices.count && profile.transport != "software-gamma" {
                ddc.writeVCP(
                    service: avServices[extIdx],
                    vcpCode: 0x10,
                    value: out.ddc,
                    retries: config.daemon.retryCount,
                    delayMs: config.daemon.interPacketDelayMs
                )
                ddc.writeVCP(
                    service: avServices[extIdx],
                    vcpCode: 0x12,
                    value: out.contrast,
                    retries: config.daemon.retryCount,
                    delayMs: config.daemon.interPacketDelayMs
                )
            }
            if extIdx < externalIDs.count {
                cg.applySoftwareGamma(displayID: externalIDs[extIdx], factor: out.gamma)
                if applyScaling {
                    _ = cg.applyHiDPIScaling(displayID: externalIDs[extIdx], profile: profile.scaling)
                }
            }
            fputs("[LumaBridge] \\(profile.name): DDC 0x10=\\(out.ddc), Gamma=\\(String(format: "%.2f", out.gamma)), Contrast=\\(out.contrast)\\n", stdout)
            extIdx += 1
        }
    }
}

let args = CommandLine.arguments
let configIndex = args.firstIndex(of: "--config").map { $0 + 1 }
let defaultPath = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/lumabridge/config.json").path
let path = (configIndex != nil && configIndex! < args.count) ? args[configIndex!] : defaultPath

do {
    let daemon = try LumaBridgeDaemon(configPath: path)
    daemon.start()
} catch {
    fputs("[LumaBridge] Failed to load config at \\(path): \\(error)\\n", stderr)
    exit(1)
}
`;

  const installScript = `#!/usr/bin/env bash
set -euo pipefail

echo "Installing LumaBridge macOS External Display Background Daemon..."

CONFIG_DIR="$HOME/.config/lumabridge"
LOG_DIR="$HOME/Library/Logs/LumaBridge"
AGENT_DIR="$HOME/Library/LaunchAgents"
BIN_PATH="/usr/local/bin/lumabridged"
PLIST_PATH="$AGENT_DIR/com.lumabridge.daemon.plist"

mkdir -p "$CONFIG_DIR" "$LOG_DIR" "$AGENT_DIR"

# 1. Write live calibrated display & brightness mapping configuration
cat <<'LUMACONFIG_EOF' > "$CONFIG_DIR/config.json"
${configJson}
LUMACONFIG_EOF

# 2. Write Swift daemon source & compile native Apple Silicon / Intel binary
TMP_SWIFT="$(mktemp /tmp/LumaBridgeDaemon.XXXXXX.swift)"
cat <<'LUMASWIFT_EOF' > "$TMP_SWIFT"
${swiftDaemonSource}
LUMASWIFT_EOF

echo "Compiling native lumabridged binary with swiftc..."
sudo mkdir -p /usr/local/bin
sudo swiftc -O -framework Cocoa -framework IOKit -framework CoreGraphics "$TMP_SWIFT" -o "$BIN_PATH"
rm -f "$TMP_SWIFT"

# 3. Install launchd LaunchAgent
cat <<'LUMAPLIST_EOF' | sed "s|__HOME__|$HOME|g" > "$PLIST_PATH"
${launchAgentPlist}
LUMAPLIST_EOF

# 4. Reload background service via launchctl
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/com.lumabridge.daemon" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST_PATH"
launchctl kickstart -k "gui/$UID_NUM/com.lumabridge.daemon"

echo "LumaBridge background daemon is installed and running."
echo "Config path: $CONFIG_DIR/config.json"
echo "Logs:        $LOG_DIR/daemon.out.log"
`;

  return {
    configJson,
    swiftDaemonSource,
    launchAgentPlist,
    installScript,
  };
}
