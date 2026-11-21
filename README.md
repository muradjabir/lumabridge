# LumaBridge

**Native macOS external display brightness, perceptual luminance mapping, HiDPI scaling, and smooth Auto-Brightness sync for Apple Silicon.**

LumaBridge bridges your MacBook's built-in display, F1/F2 brightness keys, and ambient light sensor (ALS) with external monitors over hardware **DDC/CI (`IOAVServiceWriteI2C`)** and flicker-free **60fps CoreGraphics software gamma dimming**.

---

## Key Features

- **Hardware DDC/CI over Apple Silicon `IOAVService`** — Directly controls monitor backlight (`VCP 0x10`) and contrast (`VCP 0x12`) over USB-C DisplayPort Alt Mode, Thunderbolt, and supported HDMI outputs without third-party kernel extensions.
- **Smooth Auto-Brightness (ALS) & Coalescing DDC Ramping** — Distinguishes intentional manual F1/F2 key steps from gradual macOS Auto-Brightness drift. Filters ALS noise with a configurable exponential moving average (EMA) low-pass window, hysteresis deadband, and direction-reversal suppression, then slews external monitor DDC values smoothly step-by-step instead of jarring snaps.
- **Perceptual Luminance Mapping & Reference Nits Matching** — Maps brightness across mismatched panels (e.g., a 500-nit MacBook Liquid Retina display alongside 250-nit external IPS monitors) using CIE `L*` perceptual curves, gamma power curves, dual-stage hardware/software knee curves, or custom 5-point splines.
- **Sub-Zero Software Gamma Dimming (60fps Eased)** — Smoothly dims external displays below their hardware backlight floor (`DDC = 0`) using `CGSetDisplayTransferByTable` with Hermite S-curve and cubic ease-out interpolation, with optional contrast linking below the knee.
- **HiDPI Scaling & Display Modes** — Configure logical resolutions, HiDPI backing pixel scales, refresh rates, pixel formats, and rotation angles, with automatic re-application on display wake or hotplug.
- **Native macOS LaunchAgent + Desktop App + CLI + Web Console** — Runs silently in the background via `launchd` (`lumabridged`), controlled from a live React/Express dashboard, native Cocoa/WebKit desktop wrapper (`LumaBridge.app`), or instant CLI (`lumabridge-ctl`).

---

## Architecture

```text
  macOS Built-in Display (F1/F2 Keys · Control Center · Auto-Brightness ALS)
                                     │
                         DisplayServicesGetBrightness
                                     ▼
            ┌─────────────────────────────────────────────────┐
            │        lumabridged (macOS LaunchAgent)          │
            │  • Manual vs. ALS Velocity Classifier           │
            │  • EMA Low-Pass Filter & Deadband Hysteresis    │
            │  • Perceptual L* / Reference Nits Mapper        │
            │  • Coalescing Paced DDC Ramp + 60fps Gamma LUT  │
            └────────────────────────┬────────────────────────┘
                    ┌────────────────┴────────────────┐
                    ▼                                 ▼
      IOAVServiceWriteI2C (DDC/CI)       CGSetDisplayTransferByTable
      VCP 0x10 Luminance / 0x12          Software Gamma & HiDPI Modes
                    │                                 │
                    └────────────────┬────────────────┘
                                     ▼
                        External Displays (1..N)

  Shared Live Config: ~/.config/lumabridge/config.json
            ▲
            │  (Real-time SSE + REST API on http://localhost:3000)
            ▼
  LumaBridge Web Console / Native LumaBridge.app (Cocoa + WKWebView)
```

---

## Requirements

- **macOS 12+** (Apple Silicon M1/M2/M3/M4 recommended for native `IOAVService` DDC/CI)
- **Xcode Command Line Tools** (`xcode-select --install`) for compiling the Swift daemon and desktop app
- **Node.js 20+** (for the companion server & web control console)
- **DDC/CI enabled** in your external monitor's on-screen display (OSD) menu

---

## Quick Start

### 1. Install & Start the Native macOS Background Daemon

The background daemon (`lumabridged`) tracks your built-in brightness keys and Auto-Brightness changes in real time, persists across logins via `launchd`, and automatically restores profiles after wake or dock reconnect.

```bash
chmod +x install-lumabridge.sh
./install-lumabridge.sh
```

Manage the installed daemon:

```bash
./install-lumabridge.sh --status      # Check launchd status and recent logs
./install-lumabridge.sh --uninstall   # Stop and remove LaunchAgent & binary
```

### 2. Launch the Control Console (Web UI + Express Companion)

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Any changes made to brightness curves, scaling profiles, or daemon smoothing parameters are immediately synced to `~/.config/lumabridge/config.json` and picked up live by `lumabridged`.

### 3. Build & Launch the Native macOS App (Optional)

```bash
mkdir -p LumaBridge.app/Contents/MacOS
cp macos/Info.plist LumaBridge.app/Contents/Info.plist
npm run build:app
npm run app
```

### 4. Compile & Use the Command-Line Tool (Optional)

```bash
swiftc -O -framework IOKit -framework CoreGraphics macos/lumabridge-ctl.swift -o macos/lumabridge-ctl

./macos/lumabridge-ctl get-builtin            # Read built-in brightness (0.0..1.0)
./macos/lumabridge-ctl set-brightness 1 65    # Set external display #1 DDC brightness to 65
./macos/lumabridge-ctl set-contrast 1 75      # Set external display #1 DDC contrast to 75
```

---

## Tuning Smooth Auto-Brightness (ALS)

External monitors use discrete 0–100 hardware DDC steps and snap visibly if driven directly by raw macOS Auto-Brightness micro-fluctuations. Open **Background Process → Daemon Parameters** to fine-tune transition behavior:

| Parameter | Default | Description |
| :--- | :---: | :--- |
| **Sync Auto-Brightness (ALS) Drift** | `On` | Gradually mirrors macOS ambient light sensor drift. Turn **Off** to keep external displays rock-steady and sync only manual F1/F2 keys and sliders. |
| **ALS Deadband Threshold** | `±3.0%` | Minimum filtered brightness drift required before triggering a gentle external fade (reversals require `1.4×` deadband to eliminate ping-ponging). |
| **ALS Smoothing Window** | `2.0 s` | First-order EMA low-pass filter window that absorbs passing shadows and brief screen reflections. |
| **DDC Fade Step Pace** | `85 ms` | Paced interval between hardware DDC steps during manual changes; ALS drift automatically slews 1 DDC unit at `1.8×` pace. |
| **Smooth Luminance Easing** | `260 ms` | Target duration for manual fades and 60fps CoreGraphics gamma LUT interpolation (`0 ms` disables ramping). |

---

## Project Structure

```text
├── install-lumabridge.sh          # One-step macOS Swift compiler & LaunchAgent installer
├── macos/
│   ├── LumaBridgeDaemon.swift     # Native Apple Silicon DDC/CI + ALS + 60fps gamma daemon
│   ├── LumaBridgeApp.swift        # Native Cocoa/WKWebView macOS desktop app wrapper
│   ├── lumabridge-ctl.swift       # Lightweight DDC/CI & CoreDisplay CLI
│   ├── com.lumabridge.daemon.plist# launchd LaunchAgent manifest
│   ├── Info.plist                 # macOS .app bundle metadata
│   └── config.default.json        # Starter multi-display profile
├── server.ts                      # Express API + SSE telemetry stream + macOS fallback poller
├── src/
│   ├── shared/
│   │   ├── types.ts               # Shared TypeScript interfaces
│   │   ├── brightnessEngine.ts    # Perceptual L*, spline, and dual-stage mapping math
│   │   └── macosGenerator.ts      # Self-contained macOS installer bundle exporter
│   └── components/                # Displays, Brightness Mapping, Scaling, Daemon, Installer views
└── .github/workflows/release.yml  # Automated Apple Silicon macOS release workflow on v* tags
```

---

## Releasing a New Version on GitHub

This repository includes an automated GitHub Actions release workflow (`.github/workflows/release.yml`). Pushing a semantic version tag compiles native `arm64` macOS binaries (`lumabridged` and `lumabridge-ctl`), packages a release tarball with SHA-256 checksums, and publishes the GitHub Release automatically:

```bash
git add .
git commit -m "Release v1.0.0"
git tag -a v1.0.0 -m "LumaBridge v1.0.0"
git push origin main --tags
```

Or publish directly from your terminal using the GitHub CLI:

```bash
gh release create v1.0.0 --title "LumaBridge v1.0.0" --notes-file CHANGELOG.md
```

---

## Troubleshooting

- **External monitor does not respond to DDC writes**: Confirm **DDC/CI** is enabled in your monitor's OSD settings. Note that some Apple Silicon built-in HDMI ports or passive HDMI adapters block DDC/CI; USB-C (DP Alt Mode) or DisplayPort cables are recommended.
- **Inspect live daemon logs**:
  ```bash
  tail -f ~/Library/Logs/LumaBridge/daemon.out.log ~/Library/Logs/LumaBridge/daemon.err.log
  ```
- **Recompile and restart local daemon after editing Swift source**:
  ```bash
  swiftc -O -framework Cocoa -framework IOKit -framework CoreGraphics macos/LumaBridgeDaemon.swift -o /usr/local/bin/lumabridged
  launchctl kickstart -k "gui/$(id -u)/com.lumabridge.daemon"
  ```

---

## License

Licensed under the [Apache-2.0 License](https://www.apache.org/licenses/LICENSE-2.0).
