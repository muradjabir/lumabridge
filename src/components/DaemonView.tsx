import React, { useMemo, useState } from 'react';
import { Pause, Play, Radio, RefreshCw, RotateCw, Trash2 } from 'lucide-react';
import type { DaemonEvent, DaemonEventCategory, DaemonMetrics, DaemonSettings } from '../shared/types.ts';

interface DaemonViewProps {
  settings: DaemonSettings;
  metrics: DaemonMetrics;
  events: DaemonEvent[];
  sseConnected: boolean;
  onUpdateSettings: (patch: Partial<DaemonSettings>) => void;
  onRunAction: (action: string) => void;
}

const FILTER_CATEGORIES: { id: 'all' | DaemonEventCategory; label: string }[] = [
  { id: 'all', label: 'All Events' },
  { id: 'ddc-write', label: 'DDC/CI' },
  { id: 'gamma-lut', label: 'Gamma LUT' },
  { id: 'scaling', label: 'Scaling' },
  { id: 'sync', label: 'Ambient Sync' },
  { id: 'bus-probe', label: 'I2C Bus' },
];

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
    '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export const DaemonView: React.FC<DaemonViewProps> = ({
  settings,
  metrics,
  events,
  sseConnected,
  onUpdateSettings,
  onRunAction,
}) => {
  const [filter, setFilter] = useState<'all' | DaemonEventCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return events.filter((ev) => {
      if (filter !== 'all' && ev.category !== filter) return false;
      if (!q) return true;
      return (
        ev.displayName.toLowerCase().includes(q) ||
        ev.operation.toLowerCase().includes(q) ||
        ev.payload.toLowerCase().includes(q)
      );
    });
  }, [events, filter, searchQuery]);

  return (
    <div className="space-y-8">
      {/* Header & Lifecycle Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-[#111418] dark:text-[#F3F5F8] tracking-tight">
            Background Process & I2C Dispatch Queue
          </h1>
          <p className="mt-1 text-sm text-[#5A6475] dark:text-[#8E97A8]">
            Configure the live background worker that debounces DDC/CI packets, polls built-in ambient luminance, and re-asserts display state on wake.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {settings.running ? (
            <button
              type="button"
              onClick={() => onRunAction('pause')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#111418] dark:text-[#F3F5F8] hover:border-amber-500 transition-colors whitespace-nowrap shrink-0"
            >
              <Pause className="w-3.5 h-3.5" />
              Pause Daemon
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onRunAction('start')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors whitespace-nowrap shrink-0"
            >
              <Play className="w-3.5 h-3.5" />
              Start Daemon
            </button>
          )}

          <button
            type="button"
            onClick={() => onRunAction('restart')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#111418] dark:text-[#F3F5F8] hover:border-amber-500 transition-colors whitespace-nowrap shrink-0"
          >
            <RotateCw className="w-3.5 h-3.5" />
            Restart Worker
          </button>

          <button
            type="button"
            onClick={() => onRunAction('probe-bus')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#111418] dark:text-[#F3F5F8] hover:border-amber-500 transition-colors whitespace-nowrap shrink-0"
          >
            <Radio className="w-3.5 h-3.5" />
            Probe I2C Bus
          </button>
        </div>
      </div>

      {/* Live Daemon Process Telemetry Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-5">
          <div className="text-xs text-[#667085] dark:text-[#8E97A8]">Worker State</div>
          <div className={`mt-1.5 text-lg font-semibold ${
            settings.running ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'
          }`}>
            {settings.running ? 'Running' : 'Paused'}
          </div>
          <div className="mt-1 font-mono text-xs text-[#667085] dark:text-[#7F889B] tabular-nums">
            PID {metrics.pid} · {sseConnected ? 'Stream Connected' : 'Reconnecting'}
          </div>
        </div>

        <div className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-5">
          <div className="text-xs text-[#667085] dark:text-[#8E97A8]">Commands Dispatched</div>
          <div className="mt-1.5 font-mono text-lg font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
            {metrics.commandsDispatched}
          </div>
          <div className="mt-1 font-mono text-xs text-[#667085] dark:text-[#7F889B] tabular-nums">
            {metrics.commandsCoalesced} coalesced via debounce
          </div>
        </div>

        <div className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-5">
          <div className="text-xs text-[#667085] dark:text-[#8E97A8]">DDC Write Timing</div>
          <div className="mt-1.5 font-mono text-lg font-semibold tabular-nums text-[#111418] dark:text-[#F3F5F8]">
            {settings.ddcDebounceMs} ms
          </div>
          <div className="mt-1 font-mono text-xs text-[#667085] dark:text-[#7F889B] tabular-nums">
            Inter-packet {settings.interPacketDelayMs}ms · {settings.retryCount}× retries
          </div>
        </div>

        <div className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-5">
          <div className="text-xs text-[#667085] dark:text-[#8E97A8]">Host Runtime</div>
          <div className="mt-1.5 text-sm font-semibold text-[#111418] dark:text-[#F3F5F8] truncate">
            {metrics.platform}
          </div>
          <div className="mt-1.5 font-mono text-xs text-[#667085] dark:text-[#7F889B] tabular-nums">
            Arch {metrics.arch} · Queue {metrics.activeQueueDepth}
          </div>
        </div>
      </section>

      {/* Configuration Form & Live Event Stream Split */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Daemon Timing & OS Hook Parameters */}
        <section className="xl:col-span-4 rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-6 space-y-5">
          <h2 className="font-display text-base font-semibold text-[#111418] dark:text-[#F3F5F8]">
            Daemon Parameters
          </h2>

          <div className="space-y-4">
            <label className="flex items-start justify-between gap-3 cursor-pointer">
              <div>
                <div className="text-xs font-medium text-[#111418] dark:text-[#F3F5F8]">
                  Ambient & Built-in Sync Loop
                </div>
                <div className="text-[11px] text-[#667085] dark:text-[#8E97A8]">
                  Periodically mirrors built-in MacBook display ALS changes to external monitors.
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.ambientSyncEnabled}
                onChange={(e) => onUpdateSettings({ ambientSyncEnabled: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-amber-500 rounded"
              />
            </label>

            <label className="flex items-start justify-between gap-3 cursor-pointer">
              <div>
                <div className="text-xs font-medium text-[#111418] dark:text-[#F3F5F8]">
                  Intercept F1 / F2 Brightness Keys
                </div>
                <div className="text-[11px] text-[#667085] dark:text-[#8E97A8]">
                  Attaches macOS CGEventTap to route hardware media keys to external DDC displays.
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.interceptMediaKeys}
                onChange={(e) => onUpdateSettings({ interceptMediaKeys: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-amber-500 rounded"
              />
            </label>

            <label className="flex items-start justify-between gap-3 cursor-pointer">
              <div>
                <div className="text-xs font-medium text-[#111418] dark:text-[#F3F5F8]">
                  Re-apply on Display Wake
                </div>
                <div className="text-[11px] text-[#667085] dark:text-[#8E97A8]">
                  Restores brightness, gamma tables, and HiDPI modes after sleep or dock reconnect.
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.reapplyOnWake}
                onChange={(e) => onUpdateSettings({ reapplyOnWake: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-amber-500 rounded"
              />
            </label>
          </div>

          <div className="pt-4 border-t border-[#EBEEF3] dark:border-[#1C222D] space-y-4">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-[#5A6475] dark:text-[#9AA3B5]">DDC Write Debounce</span>
                <span className="font-mono tabular-nums text-[#111418] dark:text-[#F3F5F8]">{settings.ddcDebounceMs} ms</span>
              </div>
              <input
                type="range"
                min={15}
                max={150}
                step={5}
                value={settings.ddcDebounceMs}
                onChange={(e) => onUpdateSettings({ ddcDebounceMs: Number(e.target.value) })}
                className="w-full accent-amber-500"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-[#5A6475] dark:text-[#9AA3B5]">I2C Inter-Packet Delay</span>
                <span className="font-mono tabular-nums text-[#111418] dark:text-[#F3F5F8]">{settings.interPacketDelayMs} ms</span>
              </div>
              <input
                type="range"
                min={20}
                max={100}
                step={5}
                value={settings.interPacketDelayMs}
                onChange={(e) => onUpdateSettings({ interPacketDelayMs: Number(e.target.value) })}
                className="w-full accent-amber-500"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-[#5A6475] dark:text-[#9AA3B5]">Ambient Poll Interval</span>
                <span className="font-mono tabular-nums text-[#111418] dark:text-[#F3F5F8]">{(settings.pollIntervalMs / 1000).toFixed(2)} s</span>
              </div>
              <input
                type="range"
                min={500}
                max={5000}
                step={250}
                value={settings.pollIntervalMs}
                onChange={(e) => onUpdateSettings({ pollIntervalMs: Number(e.target.value) })}
                className="w-full accent-amber-500"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-[#5A6475] dark:text-[#9AA3B5]">Smooth Luminance Easing</span>
                <span className="font-mono tabular-nums text-[#111418] dark:text-[#F3F5F8]">{settings.smoothTransitionMs} ms</span>
              </div>
              <input
                type="range"
                min={0}
                max={600}
                step={20}
                value={settings.smoothTransitionMs}
                onChange={(e) => onUpdateSettings({ smoothTransitionMs: Number(e.target.value) })}
                className="w-full accent-amber-500"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-[#5A6475] dark:text-[#9AA3B5]">I2C Write Retry Count</span>
                <span className="font-mono tabular-nums text-[#111418] dark:text-[#F3F5F8]">{settings.retryCount}×</span>
              </div>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={settings.retryCount}
                onChange={(e) => onUpdateSettings({ retryCount: Number(e.target.value) })}
                className="w-full accent-amber-500"
              />
            </div>
          </div>
        </section>

        {/* Right: Real-Time SSE Daemon Dispatch Log */}
        <section className="xl:col-span-8 rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] overflow-hidden">
          <div className="px-6 py-4 border-b border-[#EBEEF3] dark:border-[#1C222D] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-semibold text-[#111418] dark:text-[#F3F5F8]">
                Live Dispatch Log
              </h2>
              <p className="text-xs text-[#667085] dark:text-[#8E97A8]">
                Streamed directly from the Express background worker over Server-Sent Events.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onRunAction('sync-all')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#111418] dark:text-[#E5E9F0] hover:border-amber-500 whitespace-nowrap shrink-0"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Dispatch Sync
              </button>
              <button
                type="button"
                onClick={() => onRunAction('clear-events')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#5A6475] dark:text-[#9AA3B5] hover:text-red-600 dark:hover:text-red-400 whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </button>
            </div>
          </div>

          {/* Filter & Search Bar */}
          <div className="px-6 py-3 border-b border-[#EBEEF3] dark:border-[#1C222D] bg-[#FAFBFD] dark:bg-[#141922] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-1 overflow-x-auto">
              {FILTER_CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setFilter(c.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    filter === c.id
                      ? 'bg-[#111418] dark:bg-amber-500 text-white dark:text-[#0B0D10]'
                      : 'text-[#5A6475] dark:text-[#8E97A8] hover:text-[#111418] dark:hover:text-white'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <input
              type="search"
              aria-label="Filter events"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="px-3 py-1.5 text-xs rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-white dark:bg-[#0D1016] text-[#111418] dark:text-[#F3F5F8] focus:outline-none focus:ring-2 focus:ring-amber-500/40 sm:w-56"
            />
          </div>

          {/* Event Table */}
          <div className="max-h-[480px] overflow-y-auto overflow-x-auto">
            {filteredEvents.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <p className="text-sm font-medium text-[#111418] dark:text-[#F3F5F8]">No daemon events match this filter</p>
                <p className="mt-1 text-xs text-[#667085] dark:text-[#8E97A8]">
                  Adjust a brightness slider or trigger a bus probe to inspect live DDC/CI dispatches.
                </p>
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-[#FAFBFD] dark:bg-[#141922] border-b border-[#E2E6ED] dark:border-[#1E2430] text-[11px] font-medium text-[#667085] dark:text-[#8E97A8]">
                  <tr>
                    <th className="py-2.5 px-5">Time</th>
                    <th className="py-2.5 px-3">Display</th>
                    <th className="py-2.5 px-3">Operation</th>
                    <th className="py-2.5 px-3">Payload</th>
                    <th className="py-2.5 px-5 text-right">Latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EBEEF3] dark:divide-[#1A202B] font-mono text-xs tabular-nums">
                  {filteredEvents.map((ev) => (
                    <tr key={ev.id} className="hover:bg-[#F8FAFC] dark:hover:bg-[#161B24]">
                      <td className="py-2.5 px-5 text-[#667085] dark:text-[#7F889B] whitespace-nowrap">
                        {formatTime(ev.timestamp)}
                      </td>
                      <td className="py-2.5 px-3 font-sans text-[#111418] dark:text-[#E5E9F0] whitespace-nowrap max-w-[160px] truncate">
                        {ev.displayName}
                      </td>
                      <td className="py-2.5 px-3 text-[#111418] dark:text-[#F3F5F8] whitespace-nowrap">
                        {ev.operation}
                      </td>
                      <td className="py-2.5 px-3 text-[11px] text-[#5A6475] dark:text-[#9AA3B5] max-w-[300px] truncate" title={ev.payload}>
                        {ev.payload}
                      </td>
                      <td className="py-2.5 px-5 text-right whitespace-nowrap">
                        <span
                          className={
                            ev.status === 'applied'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : ev.status === 'skipped'
                                ? 'text-amber-700 dark:text-amber-400'
                                : 'text-[#667085]'
                          }
                        >
                          {ev.status === 'skipped' ? 'Paused' : `${ev.latencyMs} ms`}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
