# Changelog

All notable changes to **LumaBridge** are documented in this file.

## [1.0.0] - 2026-11-20

### Added
- **Native macOS Background Daemon (`lumabridged`)**: Apple Silicon `IOAVServiceWriteI2C` DDC/CI luminance (`VCP 0x10`) and contrast (`VCP 0x12`) controller with `launchd` LaunchAgent persistence and wake/hotplug restoration.
- **Smooth Auto-Brightness (ALS) & Coalescing DDC Ramping**:
  - Velocity classifier separating intentional manual F1/F2 & slider input from slow macOS ambient light sensor (ALS) drift.
  - Configurable EMA low-pass filter (`alsSmoothingWindowMs`), hysteresis deadband (`alsDeadbandPercent`), direction-reversal suppression (`1.4×`), and a toggle (`syncAutoBrightness`) to ignore ALS drift completely.
  - Coalescing paced hardware DDC ramp controller (`ddcRampStepMs`) that slews 1 step at a time during ALS drift with cached `IOAVService` handles.
  - 60fps time-based eased CoreGraphics software gamma LUT animations (`CGSetDisplayTransferByTable`) for flicker-free sub-zero dimming.
- **Perceptual Luminance Mapping & HiDPI Scaling**: CIE `L*`, gamma power, dual-stage hardware/software knee, Reference Nits matching, and custom 5-point spline curves alongside HiDPI resolution, refresh rate, and rotation management.
- **Control Dashboard, Native Desktop App & CLI**:
  - React + Express web console with live SSE dispatch logs, light/dark themes, and macOS display hardware auto-detection.
  - Native Cocoa/WebKit desktop app wrapper (`LumaBridgeApp.swift`) and instant command-line tool (`lumabridge-ctl.swift`).
  - One-step installer (`install-lumabridge.sh`) with `--status` and `--uninstall` commands and automated GitHub Actions macOS release workflow.
