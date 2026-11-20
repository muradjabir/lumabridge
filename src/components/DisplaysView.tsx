import React from 'react';
import {
  ChevronDown,
  ChevronUp,
  Link2,
  Link2Off,
  SlidersHorizontal,
  Scaling,
  Trash2,
} from 'lucide-react';
import { computeBrightnessOutput, computeScalingMetrics } from '../shared/brightnessEngine.ts';
import type { ControlTransport, DisplayConfig } from '../shared/types.ts';
import type { WorkspaceTab } from './Sidebar.tsx';

interface DisplaysViewProps {
  displays: DisplayConfig[];
  selectedDisplayId: string;
  masterBrightness: number;
  referenceDisplayId: string;
  onSelectDisplay: (id: string) => void;
  onChangeMasterBrightness: (value: number) => void;
  onStepHotkey: (action: 'step-up' | 'step-down' | 'fine-up' | 'fine-down', displayId?: string) => void;
  onUpdateDisplay: (id: string, patch: Partial<DisplayConfig>) => void;
  onRemoveDisplay: (id: string) => void;
  onNavigateTab: (tab: WorkspaceTab) => void;
}

const STUDIO_PRESETS: { label: string; nitsHint: string; brightness: number }[] = [
  { label: 'Daylight', nitsHint: '~300 nits', brightness: 86 },
  { label: 'Studio', nitsHint: '~160 nits', brightness: 64 },
  { label: 'Evening', nitsHint: '~80 nits', brightness: 38 },
  { label: 'Night Floor', nitsHint: '~18 nits', brightness: 12 },
];

const TRANSPORT_OPTIONS: { id: ControlTransport; label: string; desc: string }[] = [
  { id: 'combined', label: 'DDC + Soft Dim', desc: 'Hardware VCP 0x10 with sub-zero gamma table dimming' },
  { id: 'ddc-ci', label: 'Hardware DDC', desc: 'Pure VCP 0x10 I2C commands (stops at panel floor)' },
  { id: 'software-gamma', label: 'Gamma LUT Only', desc: 'CoreGraphics transfer table (HDMI / DisplayLink)' },
];

export const DisplaysView: React.FC<DisplaysViewProps> = ({
  displays,
  selectedDisplayId,
  masterBrightness,
  referenceDisplayId,
  onSelectDisplay,
  onChangeMasterBrightness,
  onStepHotkey,
  onUpdateDisplay,
  onRemoveDisplay,
  onNavigateTab,
}) => {
  const selected = displays.find((d) => d.id === selectedDisplayId) ?? displays[0];
  const refDisplay = displays.find((d) => d.id === referenceDisplayId) ?? displays[0];
  const refOutput = refDisplay ? computeBrightnessOutput(refDisplay) : undefined;
  const selectedOutput = selected
    ? computeBrightnessOutput(selected, selected.brightness, refOutput?.estimatedNits)
    : undefined;
  const selectedScaling = selected ? computeScalingMetrics(selected) : undefined;

  const linkedCount = displays.filter((d) => d.linkedToMaster).length;

  return (
    <div className="space-y-8">
      {/* Section 1: Unified Master Brightness Control */}
      <section className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-[#EBEEF3] dark:border-[#1C222D]">
          <div>
            <h1 className="font-display text-xl font-semibold text-[#111418] dark:text-[#F3F5F8] tracking-tight">
              Unified Display Brightness
            </h1>
            <p className="mt-1 text-sm text-[#5A6475] dark:text-[#8E97A8]">
              Drives {linkedCount} linked {linkedCount === 1 ? 'display' : 'displays'} through individual DDC/CI and perceptual gamma curves. Use <kbd className="font-mono text-xs px-1.5 py-0.5 rounded bg-[#EFF2F6] dark:bg-[#1D2330] text-[#111418] dark:text-[#E2E8F0]">[</kbd> and <kbd className="font-mono text-xs px-1.5 py-0.5 rounded bg-[#EFF2F6] dark:bg-[#1D2330] text-[#111418] dark:text-[#E2E8F0]">]</kbd> for macOS F1/F2 steps.
            </p>
          </div>

          {/* Native macOS 16-Step Brightness Key Triggers */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onStepHotkey('step-down')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#111418] dark:text-[#E5E9F0] hover:border-amber-500 transition-colors whitespace-nowrap shrink-0"
              title="Decrease by 1 macOS brightness notch (-6.25%)"
            >
              <ChevronDown className="w-3.5 h-3.5" />
              F1 Step
            </button>
            <button
              type="button"
              onClick={() => onStepHotkey('step-up')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#111418] dark:text-[#E5E9F0] hover:border-amber-500 transition-colors whitespace-nowrap shrink-0"
              title="Increase by 1 macOS brightness notch (+6.25%)"
            >
              <ChevronUp className="w-3.5 h-3.5" />
              F2 Step
            </button>
          </div>
        </div>

        {/* Master Slider + 16-Step macOS OSD Tick Bar */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
          <div className="lg:col-span-8">
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-xs font-medium text-[#5A6475] dark:text-[#8E97A8]">
                Master Luminance Command
              </span>
              <span className="font-mono text-lg font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
                {masterBrightness.toFixed(1)}%
              </span>
            </div>

            <div className="relative flex items-center h-7">
              <div className="w-full h-1.5 rounded-full bg-[#E3E7EE] dark:bg-[#1F2633] overflow-hidden">
                <div
                  className="h-full bg-amber-500 transition-all duration-100"
                  style={{ width: `${masterBrightness}%` }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={0.5}
                value={masterBrightness}
                aria-label="Master Brightness"
                onChange={(e) => onChangeMasterBrightness(Number(e.target.value))}
                className="luma-slider absolute inset-0 w-full"
              />
            </div>

            {/* 16-notch Apple OSD indicator */}
            <div className="mt-2 grid grid-cols-16 gap-1" aria-hidden="true">
              {Array.from({ length: 16 }).map((_, idx) => {
                const threshold = ((idx + 1) / 16) * 100;
                const filled = masterBrightness >= threshold - 3.1;
                return (
                  <div
                    key={idx}
                    className={`h-1 rounded-xs transition-colors ${
                      filled ? 'bg-amber-500/90' : 'bg-[#E3E7EE] dark:bg-[#1F2633]'
                    }`}
                  />
                );
              })}
            </div>
          </div>

          {/* Quick Calibrated Presets */}
          <div className="lg:col-span-4 grid grid-cols-2 gap-2">
            {STUDIO_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => onChangeMasterBrightness(preset.brightness)}
                className="flex flex-col items-start px-3 py-2 rounded-lg border border-[#E2E6ED] dark:border-[#222936] hover:border-amber-500/70 bg-[#FAFBFD] dark:bg-[#161B24] transition-colors text-left"
              >
                <span className="text-xs font-medium text-[#111418] dark:text-[#F3F5F8] whitespace-nowrap">
                  {preset.label}
                </span>
                <span className="font-mono text-[11px] text-[#667085] dark:text-[#7F889B] tabular-nums">
                  {preset.nitsHint} · {preset.brightness}%
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Section 2: Interactive Multi-Monitor Desk Stage */}
      <section className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-5">
          <div>
            <h2 className="font-display text-base font-semibold text-[#111418] dark:text-[#F3F5F8]">
              Display Arrangement & Live Luminance Preview
            </h2>
            <p className="text-xs text-[#667085] dark:text-[#8E97A8] mt-0.5">
              Select any display to calibrate its DDC/CI output, sub-zero gamma table, or HiDPI scaling density.
            </p>
          </div>
          {refDisplay && refOutput && (
            <div className="text-xs text-[#5A6475] dark:text-[#8E97A8] font-mono tabular-nums">
              Reference: {refDisplay.name} · {refOutput.estimatedNits} cd/m²
            </div>
          )}
        </div>

        {/* Desk Canvas */}
        <div className="rounded-lg bg-[#EAEFF5] dark:bg-[#090B0E] border border-[#DCE1E9] dark:border-[#1B212C] p-6 sm:p-8 overflow-x-auto">
          <div className="flex items-end justify-center gap-6 min-w-max mx-auto">
            {displays.map((d) => {
              const out = computeBrightnessOutput(d, d.brightness, refOutput?.estimatedNits);
              const sc = computeScalingMetrics(d);
              const isSelected = d.id === selected?.id;

              // Visual physical proportions scaled cleanly by diagonal inches
              const aspect = d.rotation === 90 || d.rotation === 270
                ? d.nativeHeight / d.nativeWidth
                : d.nativeWidth / d.nativeHeight;
              const baseHeight = Math.round(Math.min(185, Math.max(96, d.diagonalInches * 5.6)));
              const baseWidth = Math.round(baseHeight * aspect);

              // Simulated perceived screen luminance (0.08 .. 1.0)
              const visualLuminance = Math.max(0.08, Math.min(1, out.estimatedNits / 400));
              // Grid density reflects HiDPI logical scaling
              const densityScale = Math.max(0.65, Math.min(1.2, 2560 / Math.max(sc.activeMode.logicalWidth, 1200)));

              return (
                <div key={d.id} className="flex flex-col items-center">
                  <button
                    type="button"
                    onClick={() => onSelectDisplay(d.id)}
                    style={{ width: `${baseWidth}px`, height: `${baseHeight}px` }}
                    className={`group relative rounded-lg p-1.5 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                      isSelected
                        ? 'bg-[#1D2430] ring-2 ring-amber-500 shadow-lg'
                        : 'bg-[#202632] ring-1 ring-[#353E50] hover:ring-[#56637D]'
                    }`}
                  >
                    {/* Simulated Monitor Glass */}
                    <div
                      className="relative w-full h-full rounded-sm overflow-hidden flex flex-col justify-between p-2.5 text-left transition-all duration-150"
                      style={{
                        background: `linear-gradient(145deg, rgba(246, 248, 252, ${visualLuminance * 0.95}) 0%, rgba(212, 222, 236, ${visualLuminance * 0.85}) 100%)`,
                      }}
                    >
                      {/* Mini macOS menu bar reflecting logical scaling density */}
                      <div
                        className="flex items-center justify-between px-1.5 rounded-xs bg-black/20 backdrop-blur-xs"
                        style={{ height: `${Math.round(12 * densityScale)}px` }}
                      >
                        <div className="flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-white/80" />
                          <span className="w-5 h-1 rounded-xs bg-white/60" />
                        </div>
                        <span className="w-4 h-1 rounded-xs bg-white/70" />
                      </div>

                      {/* Mini Desktop Content Window Preview */}
                      <div
                        className="my-auto mx-auto w-[78%] rounded-xs bg-white/80 shadow-xs border border-black/10 p-1.5"
                        style={{ transform: `scale(${Math.min(1, densityScale)})` }}
                      >
                        <div className="h-1.5 w-1/2 rounded-xs bg-slate-800/70 mb-1" />
                        <div className="h-1 w-full rounded-xs bg-slate-500/40 mb-0.5" />
                        <div className="h-1 w-4/5 rounded-xs bg-slate-500/40" />
                      </div>

                      {/* Live Nits & DDC Overlay Bar */}
                      <div className="flex items-center justify-between px-1.5 py-0.5 rounded-xs bg-black/65 text-white font-mono text-[10px] tabular-nums">
                        <span>{out.estimatedNits} nits</span>
                        <span>{d.isBuiltIn ? 'XDR' : `DDC ${out.hardwareDdc}`}</span>
                      </div>
                    </div>
                  </button>

                  {/* Monitor Stand or MacBook Base */}
                  {d.isBuiltIn ? (
                    <div className="w-[88%] h-2 rounded-b-md bg-[#7E8796] dark:bg-[#3A4252] mt-0.5" />
                  ) : (
                    <div className="flex flex-col items-center">
                      <div className="w-3.5 h-5 bg-[#8E97A8] dark:bg-[#2F3746]" />
                      <div className="w-16 h-1.5 rounded-full bg-[#7E8796] dark:bg-[#3A4252]" />
                    </div>
                  )}

                  {/* Clean Unboxed Display Caption */}
                  <div className="mt-3 text-center">
                    <div className={`text-xs font-medium ${isSelected ? 'text-amber-700 dark:text-amber-400' : 'text-[#111418] dark:text-[#E5E9F0]'}`}>
                      {d.name}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-[#667085] dark:text-[#7F889B] tabular-nums">
                      {sc.activeMode.logicalWidth}×{sc.activeMode.logicalHeight} {sc.activeMode.hidpi ? 'HiDPI' : '1×'} · {d.refreshRate} Hz
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Section 3: Selected Display Precision Inspector */}
      {selected && selectedOutput && selectedScaling && (
        <section className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-[#EBEEF3] dark:border-[#1C222D]">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#111418] dark:text-[#F3F5F8]">
                {selected.name}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#667085] dark:text-[#8E97A8] tabular-nums">
                <span>{selected.vendor}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{selected.modelCode}</span>
                <span aria-hidden="true">·</span>
                <span>{selected.connection}</span>
                <span aria-hidden="true">·</span>
                <span>{selected.panelType}</span>
                <span aria-hidden="true">·</span>
                <span>{selected.physicalMinNits}–{selected.physicalMaxNits} cd/m²</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onUpdateDisplay(selected.id, { linkedToMaster: !selected.linkedToMaster })}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                  selected.linkedToMaster
                    ? 'border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-300'
                    : 'border-[#DCE1E9] dark:border-[#262E3D] text-[#5A6475] dark:text-[#8E97A8]'
                }`}
              >
                {selected.linkedToMaster ? <Link2 className="w-3.5 h-3.5" /> : <Link2Off className="w-3.5 h-3.5" />}
                {selected.linkedToMaster ? 'Linked to Master' : 'Independent'}
              </button>

              <button
                type="button"
                onClick={() => onNavigateTab('mapping')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#111418] dark:text-[#E5E9F0] hover:border-amber-500 transition-colors whitespace-nowrap shrink-0"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                Edit Curve
              </button>

              <button
                type="button"
                onClick={() => onNavigateTab('scaling')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#111418] dark:text-[#E5E9F0] hover:border-amber-500 transition-colors whitespace-nowrap shrink-0"
              >
                <Scaling className="w-3.5 h-3.5" />
                Scaling
              </button>

              {!selected.isBuiltIn && (
                <button
                  type="button"
                  onClick={() => onRemoveDisplay(selected.id)}
                  aria-label="Remove display"
                  className="inline-flex items-center justify-center p-1.5 rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#667085] hover:text-red-600 dark:hover:text-red-400 hover:border-red-500/50 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Sliders & Live Readout Columns */}
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
            <div className="lg:col-span-7 space-y-6">
              {/* Per-Display Brightness Slider */}
              <div>
                <div className="flex items-baseline justify-between mb-2">
                  <label htmlFor="disp-brightness" className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5]">
                    Perceived Brightness Target
                  </label>
                  <span className="font-mono text-sm font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
                    {selected.brightness.toFixed(1)}%
                  </span>
                </div>
                <div className="relative flex items-center h-6">
                  <div className="w-full h-1.5 rounded-full bg-[#E3E7EE] dark:bg-[#1F2633] overflow-hidden">
                    <div
                      className="h-full bg-amber-500"
                      style={{ width: `${selected.brightness}%` }}
                    />
                  </div>
                  <input
                    id="disp-brightness"
                    type="range"
                    min={0}
                    max={100}
                    step={0.5}
                    value={selected.brightness}
                    onChange={(e) => onUpdateDisplay(selected.id, { brightness: Number(e.target.value) })}
                    className="luma-slider absolute inset-0 w-full"
                  />
                </div>
              </div>

              {/* Contrast Slider (VCP 0x12) */}
              {!selected.isBuiltIn && (
                <div>
                  <div className="flex items-baseline justify-between mb-2">
                    <label htmlFor="disp-contrast" className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5]">
                      Hardware Contrast (VCP 0x12)
                    </label>
                    <span className="font-mono text-sm font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
                      {selected.contrast}%
                    </span>
                  </div>
                  <div className="relative flex items-center h-6">
                    <div className="w-full h-1.5 rounded-full bg-[#E3E7EE] dark:bg-[#1F2633] overflow-hidden">
                      <div
                        className="h-full bg-[#525B6B] dark:bg-[#7A8599]"
                        style={{ width: `${selected.contrast}%` }}
                      />
                    </div>
                    <input
                      id="disp-contrast"
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={selected.contrast}
                      onChange={(e) => onUpdateDisplay(selected.id, { contrast: Number(e.target.value) })}
                      className="luma-slider absolute inset-0 w-full"
                    />
                  </div>
                </div>
              )}

              {/* Control Transport Mode (External Displays) */}
              {!selected.isBuiltIn && (
                <div>
                  <div className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5] mb-2">
                    Brightness Transport Driver
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {TRANSPORT_OPTIONS.map((opt) => {
                      const active = selected.transport === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => onUpdateDisplay(selected.id, { transport: opt.id })}
                          className={`p-3 rounded-lg border text-left transition-colors ${
                            active
                              ? 'border-amber-500 bg-amber-500/8 text-[#111418] dark:text-[#F3F5F8]'
                              : 'border-[#E2E6ED] dark:border-[#222936] text-[#5A6475] dark:text-[#8E97A8] hover:border-[#C7CFD9] dark:hover:border-[#323C4E]'
                          }`}
                        >
                          <div className="text-xs font-medium text-[#111418] dark:text-[#F3F5F8] whitespace-nowrap">
                            {opt.label}
                          </div>
                          <div className="mt-1 text-[11px] leading-snug text-[#667085] dark:text-[#7F889B]">
                            {opt.desc}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Right: Computed Optical & Hardware Telemetry Grid */}
            <div className="lg:col-span-5 lg:border-l lg:border-[#EBEEF3] dark:lg:border-[#1C222D] lg:pl-8 flex flex-col justify-between space-y-5">
              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                <div>
                  <div className="text-xs text-[#667085] dark:text-[#7F889B]">Estimated Luminance</div>
                  <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
                    {selectedOutput.estimatedNits}
                    <span className="ml-1 text-xs font-normal text-[#667085] dark:text-[#8E97A8]">cd/m²</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-[#667085] dark:text-[#7F889B]">CIE Perceptual L*</div>
                  <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
                    {selectedOutput.perceptualLStar}
                    <span className="ml-1 text-xs font-normal text-[#667085] dark:text-[#8E97A8]">/ 100</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-[#667085] dark:text-[#7F889B]">Hardware VCP 0x10</div>
                  <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
                    {selectedOutput.hardwareDdc}
                    <span className="ml-1 text-xs font-normal text-[#667085] dark:text-[#8E97A8]">/ 100</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-[#667085] dark:text-[#7F889B]">Software Gamma LUT</div>
                  <div className={`mt-1 font-mono text-lg font-semibold tabular-nums ${
                    selectedOutput.inSoftwareZone
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-[#111418] dark:text-[#F3F5F8]'
                  }`}>
                    ×{selectedOutput.softwareGamma.toFixed(3)}
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-[#EBEEF3] dark:border-[#1C222D]">
                <div className="text-xs text-[#667085] dark:text-[#7F889B] mb-1.5">
                  Active Hardware Wire Frame
                </div>
                <div className="font-mono text-xs text-[#111418] dark:text-[#D5DCE8] bg-[#F3F5F8] dark:bg-[#0C0F14] border border-[#E2E6ED] dark:border-[#1E2532] rounded-lg px-3 py-2 overflow-x-auto whitespace-nowrap">
                  {selectedOutput.vcpPacketHex}
                </div>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
};
