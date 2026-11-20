// lumabridge-ctl.swift — Native Apple Silicon DDC/CI & CoreDisplay Controller CLI
// Provides instant DDC hardware writes via IOAVServiceWriteI2C and CoreDisplay brightness controls.

import Foundation
import CoreGraphics
import IOKit

typealias IOAVServiceRef = CFTypeRef

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

func discoverExternalAVServices() -> [IOAVServiceRef] {
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

func writeVCP(service: IOAVServiceRef, vcpCode: UInt8, value: UInt16) -> Bool {
    var packet: [UInt8] = [
        0x84,
        0x03,
        vcpCode,
        UInt8((value >> 8) & 0xFF),
        UInt8(value & 0xFF),
        0x00
    ]
    var checksum: UInt8 = 0x6E ^ 0x51
    for i in 0..<5 { checksum ^= packet[i] }
    packet[5] = checksum

    for _ in 0..<3 {
        let kr = packet.withUnsafeMutableBytes { buf -> IOReturn in
            guard let ptr = buf.baseAddress else { return -1 }
            return IOAVServiceWriteI2C(service, 0x37, 0x51, ptr, UInt32(buf.count))
        }
        if kr == KERN_SUCCESS { return true }
        usleep(25000)
    }
    return false
}

let args = CommandLine.arguments
if args.count < 2 {
    print("Usage: lumabridge-ctl <command> [args...]")
    print("  set-brightness <displayIndex 1..N> <value 0..100>")
    print("  set-contrast <displayIndex 1..N> <value 0..100>")
    print("  get-builtin")
    print("  set-builtin <value 0.0..1.0>")
    exit(1)
}

let cmd = args[1]
switch cmd {
case "set-brightness", "set-contrast":
    guard args.count >= 4,
          let displayIdx = Int(args[2]),
          let val = Double(args[3]) else {
        print("Invalid arguments")
        exit(1)
    }
    let services = discoverExternalAVServices()
    if displayIdx < 1 || displayIdx > services.count {
        print("Display index \(displayIdx) out of range (found \(services.count) external displays)")
        exit(1)
    }
    let vcp: UInt8 = (cmd == "set-brightness") ? 0x10 : 0x12
    let clamped = UInt16(max(0, min(100, round(val))))
    let success = writeVCP(service: services[displayIdx - 1], vcpCode: vcp, value: clamped)
    print(success ? "OK" : "FAILED")

case "get-builtin":
    var b: Float = 0.0
    if DisplayServicesGetBrightness(CGMainDisplayID(), &b) == 0 {
        print(String(format: "%.4f", b))
    } else {
        exit(1)
    }

case "set-builtin":
    guard args.count >= 3, let val = Float(args[2]) else {
        print("Invalid value")
        exit(1)
    }
    let clamped = max(0.0, min(1.0, val))
    let kr = DisplayServicesSetBrightness(CGMainDisplayID(), clamped)
    print(kr == 0 ? "OK" : "FAILED")

default:
    print("Unknown command: \(cmd)")
    exit(1)
}
