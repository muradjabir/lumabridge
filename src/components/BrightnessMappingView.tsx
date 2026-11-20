import React, { useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { clamp, computeBrightnessOutput } from '../shared/brightnessEngine.ts';
import type { BrightnessMappingConfig, CurveMode, CurvePoint, DisplayConfig } from '../shared/types.ts';

interface BrightnessMappingViewProps {
  displays: DisplayConfig[];
  selectedDisplayId: string;
  referenceDisplayId: string;
  onSelectDisplay: (id: string) => void;
  onUpdateDisplay: (id: string, patch: Partial<DisplayConfig>) => void;
}

const CURVE_MODES: { id: CurveMode; label: string; description: string }[] = [
  { id: 'dual-stage', label: 'Dual-Stage', description: 'Sub-zero software gamma below knee, hardware DDC above' },
  { id: 'perceptual', label: 'Perceptual CIE L*', description: 'Logarithmic response matching human eye sensitivity' },
  { id: 'gamma', label: 'Power Gamma', description: 'Parametric x^γ response curve across hardware range' },
  { id: 'custom-spline', label: 'Custom Spline', description: 'Drag 5 interactive control nodes directly on the graph' },
];

const SVG_W = 680;
const SVG_H = 340;
const PAD_L = 52;
const PAD_R = 24;
const PAD_T = 22;
const PAD_B = 42;
const PLOT_W = SVG_W - PAD_L - PAD_R;
const PLOT_H = SVG_H - PAD_T - PAD_B;

function xToSvg(pct: number): number {
  return PAD_L + (clamp(pct, 0, 100) / 100) * PLOT_W;
}

function yToSvg(pct: number): number {
  return PAD_T + (1 - clamp(pct, 0, 100) / 100) * PLOT_H;
}

export const BrightnessMappingView: React.FC<BrightnessMappingViewProps> = ({
  displays,
  selectedDisplayId,
  referenceDisplayId,
  onSelectDisplay,
  onUpdateDisplay,
}) => {
  const display = displays.find((d) => d.id === selectedDisplayId) ?? displays[0];
  const refDisplay = displays.find((d) => d.id === referenceDisplayId) ?? displays[0];
  const refNits = refDisplay ? computeBrightnessOutput(refDisplay).estimatedNits : undefined;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverInput, setHoverInput] = useState<number | null>(null);
  const [draggingNodeIdx, setDraggingNodeIdx] = useState<number | null>(null);

  const inspectInput = hoverInput ?? display.brightness;
  const inspectedOut = computeBrightnessOutput(display, inspectInput, refNits);

  const updateMapping = (patch: Partial<BrightnessMappingConfig>) => {
    onUpdateDisplay(display.id, {
      mapping: {
        ...display.mapping,
        ...patch,
      },
    });
  };

  // Sample 101 points along the curve for crisp SVG polylines
  const curveSamples = useMemo(() => {
    const samples: { x: number; ddc: number; gammaPct: number; nitsPct: number; nits: number }[] = [];
    for (let x = 0; x <= 100; x += 1) {
      const out = computeBrightnessOutput(display, x, refNits);
      const nitsPct = clamp((out.estimatedNits / Math.max(display.physicalMaxNits, 1)) * 100, 0, 100);
      samples.push({
        x,
        ddc: out.hardwareDdc,
        gammaPct: out.softwareGamma * 100,
        nitsPct,
        nits: out.estimatedNits,
      });
    }
    return samples;
  }, [display, refNits]);

  const ddcPath = useMemo(
    () => curveSamples.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xToSvg(p.x).toFixed(1)} ${yToSvg(p.ddc).toFixed(1)}`).join(' '),
    [curveSamples],
  );

  const gammaPath = useMemo(
    () => curveSamples.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xToSvg(p.x).toFixed(1)} ${yToSvg(p.gammaPct).toFixed(1)}`).join(' '),
    [curveSamples],
  );

  const nitsPath = useMemo(
    () => curveSamples.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xToSvg(p.x).toFixed(1)} ${yToSvg(p.nitsPct).toFixed(1)}`).join(' '),
    [curveSamples],
  );

  // 16-Step macOS OSD Lookup Table
  const osdSteps = useMemo(() => {
    return Array.from({ length: 17 }).map((_, step) => {
      const inputPct = Number(((step / 16) * 100).toFixed(1));
      return {
        step,
        ...computeBrightnessOutput(display, inputPct, refNits),
      };
    });
  }, [display, refNits]);

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * SVG_W;
    const relY = ((e.clientY - rect.top) / rect.height) * SVG_H;
    const pctX = clamp(((relX - PAD_L) / PLOT_W) * 100, 0, 100);
    const pctY = clamp((1 - (relY - PAD_T) / PLOT_H) * 100, 0, 100);

    setHoverInput(Number(pctX.toFixed(1)));

    if (draggingNodeIdx !== null && display.mapping.mode === 'custom-spline') {
      const nextPoints: CurvePoint[] = display.mapping.customPoints.map((pt, idx) => {
        if (idx !== draggingNodeIdx) return pt;
        // Keep endpoints pinned horizontally at 0 and 100
        const minX = idx === 0 ? 0 : display.mapping.customPoints[idx - 1].x + 5;
        const maxX =
          idx === display.mapping.customPoints.length - 1
            ? 100
            : display.mapping.customPoints[idx + 1].x - 5;
        const clampedX = idx === 0 ? 0 : idx === display.mapping.customPoints.length - 1 ? 100 : Math.round(clamp(pctX, minX, maxX));
        return { x: clampedX, y: Math.round(pctY) };
      });
      updateMapping({ customPoints: nextPoints });
    }
  };

  const handleResetCurve = () => {
    updateMapping({
      mode: 'dual-stage',
      gammaExponent: 1.7,
      softwareKnee: 24,
      softwareMinFactor: 0.18,
      hardwareMinClamp: 0,
      hardwareMaxClamp: 100,
      linkContrastBelowKnee: true,
      contrastMinClamp: 55,
      matchReferenceNits: false,
      customPoints: [
        { x: 0, y: 0 },
        { x: 25, y: 14 },
        { x: 50, y: 38 },
        { x: 75, y: 69 },
        { x: 100, y: 100 },
      ],
    });
  };

  const showSoftZone = display.transport === 'combined' && display.mapping.softwareKnee > 0 && !display.mapping.matchReferenceNits;

  return (
    <div className="space-y-8">
      {/* Header & Display Switcher */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-[#111418] dark:text-[#F3F5F8] tracking-tight">
            Brightness Mapping & Luminance Curves
          </h1>
          <p className="mt-1 text-sm text-[#5A6475] dark:text-[#8E97A8]">
            Shape how macOS brightness steps translate to DDC/CI backlight hardware, sub-zero software gamma tables, and physical nits.
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

      {/* Main Split: Interactive Curve Plotter + Parameter Controls */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Interactive SVG Transfer Curve Studio */}
        <section className="xl:col-span-8 rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <span className="inline-flex items-center gap-1.5 text-[#111418] dark:text-[#E5E9F0] font-medium">
                <span className="w-3 h-0.5 bg-amber-500 inline-block" />
                Hardware DDC (VCP 0x10)
              </span>
              <span className="inline-flex items-center gap-1.5 text-[#5A6475] dark:text-[#9AA3B5]">
                <span className="w-3 h-0.5 bg-sky-500 inline-block" />
                Software Gamma LUT
              </span>
              <span className="inline-flex items-center gap-1.5 text-[#5A6475] dark:text-[#9AA3B5]">
                <span className="w-3 h-0.5 bg-emerald-500/80 border-t border-dashed inline-block" />
                Output Nits (% Max)
              </span>
            </div>

            <button
              type="button"
              onClick={handleResetCurve}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#5A6475] dark:text-[#8E97A8] hover:text-[#111418] dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Curve
            </button>
          </div>

          {/* Interactive SVG Graph */}
          <div className="rounded-lg bg-[#F8FAFC] dark:bg-[#0A0D12] border border-[#E2E6ED] dark:border-[#1B222E] p-2">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${SVG_W} ${SVG_H}`}
              className="w-full h-auto select-none touch-none cursor-crosshair"
              onPointerMove={handleSvgPointerMove}
              onPointerLeave={() => {
                if (draggingNodeIdx === null) setHoverInput(null);
              }}
              onPointerUp={() => setDraggingNodeIdx(null)}
            >
              {/* Sub-zero Software Dimming Zone Shading */}
              {showSoftZone && (
                <rect
                  x={PAD_L}
                  y={PAD_T}
                  width={xToSvg(display.mapping.softwareKnee) - PAD_L}
                  height={PLOT_H}
                  className="fill-sky-500/8 dark:fill-sky-400/10"
                />
              )}

              {/* Gridlines & Axis Ticks */}
              {[0, 25, 50, 75, 100].map((val) => (
                <g key={val}>
                  <line
                    x1={PAD_L}
                    y1={yToSvg(val)}
                    x2={SVG_W - PAD_R}
                    y2={yToSvg(val)}
                    className="stroke-[#E2E6ED] dark:stroke-[#1C2330]"
                    strokeWidth="1"
                  />
                  <line
                    x1={xToSvg(val)}
                    y1={PAD_T}
                    x2={xToSvg(val)}
                    y2={SVG_H - PAD_B}
                    className="stroke-[#E2E6ED] dark:stroke-[#1C2330]"
                    strokeWidth="1"
                  />
                  <text
                    x={PAD_L - 10}
                    y={yToSvg(val) + 4}
                    textAnchor="end"
                    className="fill-[#667085] dark:fill-[#7F889B] font-mono text-[10px]"
                  >
                    {val}%
                  </text>
                  <text
                    x={xToSvg(val)}
                    y={SVG_H - PAD_B + 18}
                    textAnchor="middle"
                    className="fill-[#667085] dark:fill-[#7F889B] font-mono text-[10px]"
                  >
                    {val}%
                  </text>
                </g>
              ))}

              {/* Reference Linear 1:1 Diagonal */}
              <line
                x1={xToSvg(0)}
                y1={yToSvg(0)}
                x2={xToSvg(100)}
                y2={yToSvg(100)}
                className="stroke-[#CBD2DF] dark:stroke-[#2A3344]"
                strokeWidth="1"
                strokeDasharray="4 4"
              />

              {/* Software Knee Divider Line */}
              {showSoftZone && (
                <g>
                  <line
                    x1={xToSvg(display.mapping.softwareKnee)}
                    y1={PAD_T}
                    x2={xToSvg(display.mapping.softwareKnee)}
                    y2={SVG_H - PAD_B}
                    className="stroke-sky-500/70"
                    strokeWidth="1.25"
                    strokeDasharray="3 3"
                  />
                  <text
                    x={xToSvg(display.mapping.softwareKnee) + 6}
                    y={PAD_T + 14}
                    className="fill-sky-600 dark:fill-sky-400 font-mono text-[10px]"
                  >
                    Knee {display.mapping.softwareKnee}%
                  </text>
                </g>
              )}

              {/* Curves */}
              <path d={nitsPath} fill="none" className="stroke-emerald-500/75" strokeWidth="1.5" strokeDasharray="5 3" />
              <path d={gammaPath} fill="none" className="stroke-sky-500" strokeWidth="2" />
              <path d={ddcPath} fill="none" className="stroke-amber-500" strokeWidth="2.5" />

              {/* Custom Spline Draggable Control Nodes */}
              {display.mapping.mode === 'custom-spline' &&
                !display.mapping.matchReferenceNits &&
                display.mapping.customPoints.map((pt, idx) => (
                  <g
                    key={idx}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      (e.currentTarget as SVGGElement).setPointerCapture(e.pointerId);
                      setDraggingNodeIdx(idx);
                    }}
                    className="cursor-grab active:cursor-grabbing"
                  >
                    <circle
                      cx={xToSvg(pt.x)}
                      cy={yToSvg(pt.y)}
                      r="11"
                      className="fill-amber-500/15"
                    />
                    <circle
                      cx={xToSvg(pt.x)}
                      cy={yToSvg(pt.y)}
                      r="5.5"
                      className="fill-white dark:fill-[#0B0D10] stroke-amber-500"
                      strokeWidth="2.5"
                    />
                  </g>
                ))}

              {/* Active / Hover Crosshair */}
              <line
                x1={xToSvg(inspectInput)}
                y1={PAD_T}
                x2={xToSvg(inspectInput)}
                y2={SVG_H - PAD_B}
                className="stroke-[#111418]/40 dark:stroke-white/35"
                strokeWidth="1"
              />
              <circle
                cx={xToSvg(inspectInput)}
                cy={yToSvg(inspectedOut.hardwareDdc)}
                r="4.5"
                className="fill-amber-500 stroke-white dark:stroke-[#0A0D12]"
                strokeWidth="2"
              />
              <circle
                cx={xToSvg(inspectInput)}
                cy={yToSvg(inspectedOut.softwareGamma * 100)}
                r="3.5"
                className="fill-sky-500 stroke-white dark:stroke-[#0A0D12]"
                strokeWidth="1.5"
              />

              {/* Axis Titles */}
              <text
                x={PAD_L + PLOT_W / 2}
                y={SVG_H - 8}
                textAnchor="middle"
                className="fill-[#5A6475] dark:fill-[#8E97A8] text-[11px]"
              >
                macOS Brightness Command Input (0–100%)
              </text>
            </svg>
          </div>

          {/* Live Scrub Telemetry Strip */}
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-[#EBEEF3] dark:border-[#1C222D]">
            <div>
              <div className="text-[11px] text-[#667085] dark:text-[#7F889B]">Input Command</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
                {inspectedOut.inputPercent.toFixed(1)}%
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[#667085] dark:text-[#7F889B]">Hardware VCP 0x10</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                {inspectedOut.hardwareDdc} / 100
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[#667085] dark:text-[#7F889B]">Software Gamma LUT</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-sky-700 dark:text-sky-400">
                ×{inspectedOut.softwareGamma.toFixed(3)}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[#667085] dark:text-[#7F889B]">Estimated Output</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
                {inspectedOut.estimatedNits} cd/m²
              </div>
            </div>
          </div>
        </section>

        {/* Right: Mapping Curve & Hardware Calibration Controls */}
        <section className="xl:col-span-4 rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-6 space-y-6">
          {/* Reference Nits Auto-Match Toggle */}
          {!display.isBuiltIn && (
            <div className="pb-5 border-b border-[#EBEEF3] dark:border-[#1C222D]">
              <label className="flex items-start justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-[#111418] dark:text-[#F3F5F8]">
                    Match Built-in Reference Nits
                  </div>
                  <div className="mt-0.5 text-xs text-[#667085] dark:text-[#8E97A8]">
                    Auto-calculates VCP 0x10 and gamma to equal {refDisplay?.name} ({refNits?.toFixed(1)} cd/m²).
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={display.mapping.matchReferenceNits}
                  onChange={(e) => updateMapping({ matchReferenceNits: e.target.checked })}
                  className="mt-1 h-4 w-4 accent-amber-500 rounded"
                />
              </label>
            </div>
          )}

          {/* Curve Algorithm Selector */}
          <div>
            <div className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5] mb-2">
              Transfer Curve Function
            </div>
            <div className="grid grid-cols-2 gap-2">
              {CURVE_MODES.map((m) => {
                const active = display.mapping.mode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={display.mapping.matchReferenceNits}
                    onClick={() => updateMapping({ mode: m.id })}
                    className={`px-3 py-2 text-left rounded-lg border transition-colors disabled:opacity-45 ${
                      active
                        ? 'border-amber-500 bg-amber-500/10 text-[#111418] dark:text-white'
                        : 'border-[#E2E6ED] dark:border-[#222936] text-[#5A6475] dark:text-[#8E97A8] hover:border-[#C5CDD9] dark:hover:border-[#343F52]'
                    }`}
                  >
                    <div className="text-xs font-medium whitespace-nowrap">{m.label}</div>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-[#667085] dark:text-[#7F889B]">
              {CURVE_MODES.find((m) => m.id === display.mapping.mode)?.description}
            </p>
          </div>

          {/* Numeric Parameters */}
          <div className="space-y-4">
            {/* Gamma Exponent */}
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-[#5A6475] dark:text-[#9AA3B5]">Gamma Exponent (γ)</span>
                <span className="font-mono tabular-nums text-[#111418] dark:text-[#F3F5F8]">
                  {display.mapping.gammaExponent.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0.6}
                max={3.0}
                step={0.05}
                value={display.mapping.gammaExponent}
                onChange={(e) => updateMapping({ gammaExponent: Number(e.target.value) })}
                className="w-full accent-amber-500"
              />
            </div>

            {/* Software Dimming Knee */}
            {!display.isBuiltIn && (
              <>
                <div>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-[#5A6475] dark:text-[#9AA3B5]">Sub-Zero Gamma Knee</span>
                    <span className="font-mono tabular-nums text-[#111418] dark:text-[#F3F5F8]">
                      {display.mapping.softwareKnee}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={50}
                    step={1}
                    value={display.mapping.softwareKnee}
                    onChange={(e) => updateMapping({ softwareKnee: Number(e.target.value) })}
                    className="w-full accent-sky-500"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-[#5A6475] dark:text-[#9AA3B5]">Minimum Software Gamma Floor</span>
                    <span className="font-mono tabular-nums text-[#111418] dark:text-[#F3F5F8]">
                      ×{display.mapping.softwareMinFactor.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.12}
                    max={0.85}
                    step={0.01}
                    value={display.mapping.softwareMinFactor}
                    onChange={(e) => updateMapping({ softwareMinFactor: Number(e.target.value) })}
                    className="w-full accent-sky-500"
                  />
                </div>

                {/* Hardware DDC Clamps */}
                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[#EBEEF3] dark:border-[#1C222D]">
                  <label className="block">
                    <span className="text-[11px] text-[#5A6475] dark:text-[#9AA3B5]">DDC Min Clamp</span>
                    <input
                      type="number"
                      min={0}
                      max={40}
                      value={display.mapping.hardwareMinClamp}
                      onChange={(e) => updateMapping({ hardwareMinClamp: clamp(Number(e.target.value), 0, 40) })}
                      className="mt-1 w-full px-2.5 py-1.5 font-mono text-xs tabular-nums rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-[#F8FAFC] dark:bg-[#0D1016] text-[#111418] dark:text-[#F3F5F8]"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-[#5A6475] dark:text-[#9AA3B5]">DDC Max Clamp</span>
                    <input
                      type="number"
                      min={50}
                      max={100}
                      value={display.mapping.hardwareMaxClamp}
                      onChange={(e) => updateMapping({ hardwareMaxClamp: clamp(Number(e.target.value), 50, 100) })}
                      className="mt-1 w-full px-2.5 py-1.5 font-mono text-xs tabular-nums rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-[#F8FAFC] dark:bg-[#0D1016] text-[#111418] dark:text-[#F3F5F8]"
                    />
                  </label>
                </div>

                {/* Panel Physical Nits Calibration */}
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[11px] text-[#5A6475] dark:text-[#9AA3B5]">Panel Min (cd/m²)</span>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={display.physicalMinNits}
                      onChange={(e) => onUpdateDisplay(display.id, { physicalMinNits: clamp(Number(e.target.value), 1, 200) })}
                      className="mt-1 w-full px-2.5 py-1.5 font-mono text-xs tabular-nums rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-[#F8FAFC] dark:bg-[#0D1016] text-[#111418] dark:text-[#F3F5F8]"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-[#5A6475] dark:text-[#9AA3B5]">Panel Max (cd/m²)</span>
                    <input
                      type="number"
                      min={100}
                      max={1600}
                      value={display.physicalMaxNits}
                      onChange={(e) => onUpdateDisplay(display.id, { physicalMaxNits: clamp(Number(e.target.value), 100, 1600) })}
                      className="mt-1 w-full px-2.5 py-1.5 font-mono text-xs tabular-nums rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-[#F8FAFC] dark:bg-[#0D1016] text-[#111418] dark:text-[#F3F5F8]"
                    />
                  </label>
                </div>

                {/* Contrast attenuation below knee */}
                <label className="flex items-center justify-between gap-3 pt-2 border-t border-[#EBEEF3] dark:border-[#1C222D] cursor-pointer">
                  <span className="text-xs text-[#5A6475] dark:text-[#9AA3B5]">
                    Attenuate Contrast (VCP 0x12) below knee
                  </span>
                  <input
                    type="checkbox"
                    checked={display.mapping.linkContrastBelowKnee}
                    onChange={(e) => updateMapping({ linkContrastBelowKnee: e.target.checked })}
                    className="h-4 w-4 accent-amber-500 rounded"
                  />
                </label>
              </>
            )}
          </div>
        </section>
      </div>

      {/* 16-Step macOS OSD Brightness Lookup Table */}
      <section className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] overflow-hidden">
        <div className="px-6 py-4 border-b border-[#EBEEF3] dark:border-[#1C222D] flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-semibold text-[#111418] dark:text-[#F3F5F8]">
              16-Step macOS Key Mapping Table
            </h2>
            <p className="text-xs text-[#667085] dark:text-[#8E97A8] mt-0.5">
              Click any step row to immediately test that luminance level on {display.name}.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#E2E6ED] dark:border-[#1E2430] bg-[#FAFBFD] dark:bg-[#151A23] text-[11px] font-medium text-[#667085] dark:text-[#8E97A8]">
                <th className="py-2.5 px-6">OSD Notch</th>
                <th className="py-2.5 px-4 text-right">Input %</th>
                <th className="py-2.5 px-4 text-right">VCP 0x10</th>
                <th className="py-2.5 px-4 text-right">Gamma LUT</th>
                <th className="py-2.5 px-4 text-right">Output Nits</th>
                <th className="py-2.5 px-4 text-right">CIE L*</th>
                <th className="py-2.5 px-6">DDC/CI I2C Frame</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EBEEF3] dark:divide-[#1A202B] font-mono text-xs tabular-nums">
              {osdSteps.map((row) => {
                const isNearest = Math.abs(row.inputPercent - display.brightness) < 3.2;
                return (
                  <tr
                    key={row.step}
                    onClick={() => onUpdateDisplay(display.id, { brightness: row.inputPercent })}
                    className={`cursor-pointer transition-colors ${
                      isNearest
                        ? 'bg-amber-500/8 dark:bg-amber-500/12 text-[#111418] dark:text-white'
                        : 'hover:bg-[#F7F9FB] dark:hover:bg-[#161B24] text-[#3B4252] dark:text-[#C5CDD9]'
                    }`}
                  >
                    <td className="py-2.5 px-6 font-medium">Step {row.step.toString().padStart(2, '0')} / 16</td>
                    <td className="py-2.5 px-4 text-right">{row.inputPercent.toFixed(1)}%</td>
                    <td className="py-2.5 px-4 text-right text-amber-700 dark:text-amber-400">{row.hardwareDdc}</td>
                    <td className="py-2.5 px-4 text-right text-sky-700 dark:text-sky-400">×{row.softwareGamma.toFixed(3)}</td>
                    <td className="py-2.5 px-4 text-right">{row.estimatedNits.toFixed(1)} cd/m²</td>
                    <td className="py-2.5 px-4 text-right">{row.perceptualLStar.toFixed(1)}</td>
                    <td className="py-2.5 px-6 text-[11px] text-[#667085] dark:text-[#8E97A8] whitespace-nowrap">
                      {row.vcpPacketHex}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
