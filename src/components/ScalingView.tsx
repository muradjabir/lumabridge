import React from 'react';
import { Check, RotateCw } from 'lucide-react';
import { computeScalingMetrics } from '../shared/brightnessEngine.ts';
import type { DisplayConfig, PixelFormat, RotationDegrees } from '../shared/types.ts';

interface ScalingViewProps {
  displays: DisplayConfig[];
  selectedDisplayId: string;
  onSelectDisplay: (id: string) => void;
  onUpdateDisplay: (id: string, patch: Partial<DisplayConfig>) => void;
}

const PIXEL_FORMATS: PixelFormat[] = ['RGB 10-bit', 'RGB 8-bit', 'YCbCr 4:2:2'];
const ROTATIONS: RotationDegrees[] = [0, 90, 180, 270];

export const ScalingView: React.FC<ScalingViewProps> = ({
  displays,
  selectedDisplayId,
  onSelectDisplay,
  onUpdateDisplay,
}) => {
  const display = displays.find((d) => d.id === selectedDisplayId) ?? displays[0];
  const metrics = computeScalingMetrics(display);

  // Compute UI scale factor for live workspace density preview relative to 2560px logical baseline
  const previewScale = Math.max(0.65, Math.min(1.25, 2560 / Math.max(metrics.activeMode.logicalWidth, 1280)));

  return (
    <div className="space-y-8">
      {/* Header & Display Switcher */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-[#111418] dark:text-[#F3F5F8] tracking-tight">
            HiDPI Scaling & Display Modes
          </h1>
          <p className="mt-1 text-sm text-[#5A6475] dark:text-[#8E97A8]">
            Configure CoreGraphics logical HiDPI resolutions, backing framebuffers, refresh rates, and orientation for macOS external monitors.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-[#EBEEF3] dark:bg-[#141820] border border-[#DCE1E9] dark:border-[#1E2430] overflow-x-auto max-w-full">
          {displays.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => onSelectDisplay(d.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                d.id === display.id
                  ? 'bg-white dark:bg-[#222938] text-[#111418] dark:text-white shadow-xs'
                  : 'text-[#5A6475] dark:text-[#8E97A8] hover:text-[#111418] dark:hover:text-white'
              }`}
            >
              {d.name}
            </button>
          ))}
        </div>
      </div>

      {/* Top Optical & GPU Framebuffer Metrics Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-5">
          <div className="text-xs text-[#667085] dark:text-[#8E97A8]">Logical Workspace</div>
          <div className="mt-1.5 font-mono text-lg font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
            {metrics.activeMode.logicalWidth} × {metrics.activeMode.logicalHeight}
          </div>
          <div className="mt-1 text-xs text-[#667085] dark:text-[#7F889B] tabular-nums">
            {metrics.activeMode.hidpi ? '2× HiDPI Retina Pipeline' : '1× Unscaled Native'}
          </div>
        </div>

        <div className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-5">
          <div className="text-xs text-[#667085] dark:text-[#8E97A8]">Backing Framebuffer</div>
          <div className="mt-1.5 font-mono text-lg font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
            {metrics.activeMode.backingWidth} × {metrics.activeMode.backingHeight}
          </div>
          <div className="mt-1 text-xs text-[#667085] dark:text-[#7F889B] tabular-nums">
            {metrics.isIntegerScale
              ? '1.00× Integer (Zero Downscale Blur)'
              : `${metrics.gpuOversampleRatio}× GPU Supersampled`}
          </div>
        </div>

        <div className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-5">
          <div className="text-xs text-[#667085] dark:text-[#8E97A8]">Effective Logical PPI</div>
          <div className="mt-1.5 font-mono text-lg font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
            {metrics.effectiveLogicalPpi} <span className="text-xs font-normal text-[#667085]">PPI</span>
          </div>
          <div className="mt-1 text-xs text-[#667085] dark:text-[#7F889B] tabular-nums">
            Native Panel {metrics.nativePpi} PPI · {display.diagonalInches}&quot;
          </div>
        </div>

        <div className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-5">
          <div className="text-xs text-[#667085] dark:text-[#8E97A8]">Display Link Bandwidth</div>
          <div className="mt-1.5 font-mono text-lg font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
            {metrics.bandwidthGbps} <span className="text-xs font-normal text-[#667085]">Gbps</span>
          </div>
          <div className="mt-1 text-xs text-[#667085] dark:text-[#7F889B] tabular-nums">
            {display.refreshRate} Hz · {display.pixelFormat}
          </div>
        </div>
      </section>

      {/* Main Split: Scaling Mode Selector Table + Live UI Density Comparator */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Resolution & HiDPI Mode Table */}
        <section className="xl:col-span-7 rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] overflow-hidden">
          <div className="px-6 py-4 border-b border-[#EBEEF3] dark:border-[#1C222D]">
            <h2 className="font-display text-base font-semibold text-[#111418] dark:text-[#F3F5F8]">
              Available Display Modes
            </h2>
            <p className="text-xs text-[#667085] dark:text-[#8E97A8] mt-0.5">
              Select a logical scaling profile. Non-integer HiDPI modes render at 2× logical resolution and downsample to {display.nativeWidth}×{display.nativeHeight}.
            </p>
          </div>

          <div className="divide-y divide-[#EBEEF3] dark:divide-[#1A202B]">
            {display.scalingModes.map((mode) => {
              const active = mode.id === display.activeScalingId;
              const oversample = (
                (mode.backingWidth * mode.backingHeight) /
                Math.max(display.nativeWidth * display.nativeHeight, 1)
              ).toFixed(2);
              const isExact =
                mode.backingWidth === display.nativeWidth && mode.backingHeight === display.nativeHeight;

              return (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() =>
                    onUpdateDisplay(display.id, {
                      activeScalingId: mode.id,
                      refreshRate: mode.refreshRates.includes(display.refreshRate)
                        ? display.refreshRate
                        : mode.refreshRates[0],
                    })
                  }
                  className={`w-full px-6 py-3.5 flex items-center justify-between gap-4 text-left transition-colors ${
                    active
                      ? 'bg-amber-500/8 dark:bg-amber-500/12'
                      : 'hover:bg-[#F8FAFC] dark:hover:bg-[#161B24]'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
                        {mode.logicalWidth} × {mode.logicalHeight}
                      </span>
                      <span className="text-xs text-[#5A6475] dark:text-[#9AA3B5] truncate">
                        {mode.hidpi ? 'HiDPI' : '1× Native'}
                        {mode.recommended ? ' · Recommended' : ''}
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-[#667085] dark:text-[#7F889B] tabular-nums">
                      Framebuffer {mode.backingWidth}×{mode.backingHeight} · {isExact ? 'Integer 1.00×' : `GPU ${oversample}×`}
                    </div>
                  </div>

                  <div className="shrink-0">
                    {active ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                        <Check className="w-4 h-4" />
                        Active
                      </span>
                    ) : (
                      <span className="text-xs text-[#667085] dark:text-[#7F889B]">Apply</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Signal & Geometry Controls */}
          <div className="p-6 border-t border-[#EBEEF3] dark:border-[#1C222D] grid grid-cols-1 sm:grid-cols-3 gap-5">
            {/* Refresh Rate */}
            <div>
              <div className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5] mb-2">
                Refresh Rate
              </div>
              <div className="flex flex-wrap gap-1.5">
                {metrics.activeMode.refreshRates.map((hz) => (
                  <button
                    key={hz}
                    type="button"
                    onClick={() => onUpdateDisplay(display.id, { refreshRate: hz })}
                    className={`px-3 py-1.5 font-mono text-xs tabular-nums rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                      display.refreshRate === hz
                        ? 'border-amber-500 bg-amber-500/10 text-[#111418] dark:text-white font-medium'
                        : 'border-[#DCE1E9] dark:border-[#262E3D] text-[#5A6475] dark:text-[#8E97A8]'
                    }`}
                  >
                    {hz} Hz
                  </button>
                ))}
              </div>
            </div>

            {/* Color / Pixel Format */}
            <div>
              <div className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5] mb-2">
                Pixel Encoding
              </div>
              <select
                value={display.pixelFormat}
                onChange={(e) => onUpdateDisplay(display.id, { pixelFormat: e.target.value as PixelFormat })}
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-[#FAFBFD] dark:bg-[#0E1117] text-[#111418] dark:text-[#F3F5F8] focus:outline-none focus:ring-2 focus:ring-amber-500/40"
              >
                {PIXEL_FORMATS.map((fmt) => (
                  <option key={fmt} value={fmt}>
                    {fmt}
                  </option>
                ))}
              </select>
            </div>

            {/* Orientation / Rotation */}
            <div>
              <div className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5] mb-2">
                Rotation
              </div>
              <div className="flex items-center gap-1">
                {ROTATIONS.map((deg) => (
                  <button
                    key={deg}
                    type="button"
                    onClick={() => onUpdateDisplay(display.id, { rotation: deg })}
                    className={`flex-1 py-1.5 font-mono text-xs tabular-nums rounded-lg border transition-colors ${
                      display.rotation === deg
                        ? 'border-amber-500 bg-amber-500/10 text-[#111418] dark:text-white font-medium'
                        : 'border-[#DCE1E9] dark:border-[#262E3D] text-[#5A6475] dark:text-[#8E97A8]'
                    }`}
                  >
                    {deg}°
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Right: Visual macOS UI Density & Sharpness Preview */}
        <section className="xl:col-span-5 rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-base font-semibold text-[#111418] dark:text-[#F3F5F8]">
                Visual UI Density Preview
              </h2>
              <p className="text-xs text-[#667085] dark:text-[#8E97A8] mt-0.5">
                Relative window chrome and text size at {metrics.effectiveLogicalPpi} effective logical PPI.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                const nextIdx = (ROTATIONS.indexOf(display.rotation) + 1) % ROTATIONS.length;
                onUpdateDisplay(display.id, { rotation: ROTATIONS[nextIdx] });
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#5A6475] dark:text-[#9AA3B5] hover:text-[#111418] dark:hover:text-white whitespace-nowrap shrink-0"
            >
              <RotateCw className="w-3.5 h-3.5" />
              Rotate
            </button>
          </div>

          <div className="rounded-lg bg-[#E9EEF5] dark:bg-[#090B0F] border border-[#DCE1E9] dark:border-[#1C222E] p-5 h-[290px] overflow-hidden flex items-center justify-center">
            <div
              className="w-full max-w-[360px] rounded-lg bg-white dark:bg-[#151A24] border border-[#CFD6E2] dark:border-[#293244] shadow-md overflow-hidden transition-transform duration-200 origin-center"
              style={{ transform: `scale(${previewScale})` }}
            >
              {/* Simulated macOS Titlebar */}
              <div className="px-3 py-2 bg-[#F2F4F8] dark:bg-[#1B212E] border-b border-[#E2E6ED] dark:border-[#252D3D] flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#FF5F56]" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[#FFBD2E]" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[#27C93F]" />
                </div>
                <span className="text-[11px] font-medium text-[#5A6475] dark:text-[#9AA3B5]">
                  Code Editor — {metrics.activeMode.logicalWidth}×{metrics.activeMode.logicalHeight}
                </span>
                <span className="w-8" />
              </div>

              {/* Simulated Crisp Vector Text */}
              <div className="p-4 space-y-2">
                <div className="text-sm font-semibold text-[#111418] dark:text-[#F3F5F8]">
                  Subpixel Typography Sample
                </div>
                <p className="text-xs leading-relaxed text-[#525B6B] dark:text-[#9AA3B5]">
                  macOS targets ~110 logical PPI for optimal legibility at typical desk distance (60 cm). Current density is{' '}
                  <span className="font-mono text-[#111418] dark:text-white">{metrics.effectiveLogicalPpi} PPI</span>.
                </p>
                <div className="pt-2 flex items-center justify-between font-mono text-[11px] text-[#667085] dark:text-[#8E97A8] border-t border-[#EBEEF3] dark:border-[#222938]">
                  <span>Scale {metrics.scaleFactor}×</span>
                  <span>{metrics.activeMode.hidpi ? 'Retina Vector 2×' : 'Standard 1×'}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="text-xs text-[#667085] dark:text-[#8E97A8] leading-relaxed">
            {metrics.effectiveLogicalPpi >= 100 && metrics.effectiveLogicalPpi <= 122
              ? 'Optimal macOS ergonomic range (100–122 logical PPI). Menu bars and body typography match Apple Retina sizing.'
              : metrics.effectiveLogicalPpi < 100
                ? 'Larger interface sizing (<100 logical PPI). Ideal for long viewing distances or low-strain reading.'
                : 'High-density workspace (>122 logical PPI). Maximizes simultaneous windows with compact UI chrome.'}
          </div>
        </section>
      </div>
    </div>
  );
};
