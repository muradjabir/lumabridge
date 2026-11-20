import React from 'react';
import {
  Activity,
  Cpu,
  Download,
  Monitor,
  Plus,
  SlidersHorizontal,
  Scaling,
  X,
} from 'lucide-react';
import { computeBrightnessOutput } from '../shared/brightnessEngine.ts';
import type { DisplayConfig } from '../shared/types.ts';

export type WorkspaceTab = 'displays' | 'mapping' | 'scaling' | 'daemon' | 'installer';

interface SidebarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  displays: DisplayConfig[];
  selectedDisplayId: string;
  referenceNits: number | undefined;
  onSelectDisplay: (id: string) => void;
  onOpenAddDisplay: () => void;
  daemonRunning: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: { id: WorkspaceTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'displays', label: 'Displays', icon: Monitor },
  { id: 'mapping', label: 'Brightness Mapping', icon: SlidersHorizontal },
  { id: 'scaling', label: 'Scaling & Modes', icon: Scaling },
  { id: 'daemon', label: 'Background Process', icon: Cpu },
  { id: 'installer', label: 'macOS Installer', icon: Download },
];

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onSelectTab,
  displays,
  selectedDisplayId,
  referenceNits,
  onSelectDisplay,
  onOpenAddDisplay,
  daemonRunning,
  mobileOpen,
  onCloseMobile,
}) => {
  const content = (
    <div className="flex h-full flex-col bg-[#F1F3F6] dark:bg-[#101318] border-r border-[#E2E6ED] dark:border-[#1E2430] select-none">
      {/* Brand Header */}
      <div className="flex items-center justify-between px-5 h-14 border-b border-[#E2E6ED] dark:border-[#1E2430] shrink-0">
        <span className="font-display text-base font-semibold tracking-tight text-[#111418] dark:text-[#F3F5F8] whitespace-nowrap shrink-0">
          LumaBridge
        </span>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation"
          className="lg:hidden p-1.5 rounded-md text-[#5A6475] dark:text-[#8E97A8] hover:text-[#111418] dark:hover:text-white"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Primary Workspace Navigation */}
      <nav className="px-3 py-4 space-y-0.5" aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectTab(item.id);
                onCloseMobile();
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                isActive
                  ? 'bg-white dark:bg-[#191E28] text-[#111418] dark:text-[#F3F5F8] shadow-xs ring-1 ring-[#E2E6ED] dark:ring-[#262E3D]'
                  : 'text-[#525B6B] dark:text-[#8E97A8] hover:text-[#111418] dark:hover:text-[#F3F5F8] hover:bg-black/4 dark:hover:bg-white/4'
              }`}
            >
              <Icon
                className={`w-4 h-4 shrink-0 ${
                  isActive ? 'text-amber-600 dark:text-amber-400' : 'text-[#717B8E] dark:text-[#6B7487]'
                }`}
              />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Connected Displays Quick Selector */}
      <div className="mt-2 px-4 pt-4 border-t border-[#E2E6ED] dark:border-[#1E2430] flex-1 overflow-y-auto">
        <div className="flex items-center justify-between mb-2.5 px-1">
          <span className="text-xs font-medium text-[#5A6475] dark:text-[#8E97A8]">
            Connected Displays
          </span>
          <button
            type="button"
            onClick={onOpenAddDisplay}
            className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-300 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>

        <div className="space-y-1.5">
          {displays.map((d) => {
            const out = computeBrightnessOutput(d, d.brightness, referenceNits);
            const isSelected = d.id === selectedDisplayId;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => {
                  onSelectDisplay(d.id);
                  onCloseMobile();
                }}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                  isSelected
                    ? 'bg-white dark:bg-[#191E28] ring-1 ring-[#D5DBE5] dark:ring-[#2A3344]'
                    : 'hover:bg-black/4 dark:hover:bg-white/4'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[#111418] dark:text-[#F3F5F8] truncate">
                    {d.name}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-[#5A6475] dark:text-[#9AA3B5] shrink-0">
                    {Math.round(d.brightness)}%
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-[#667085] dark:text-[#7F889B] tabular-nums">
                  <span className="truncate">
                    {d.isBuiltIn ? 'Built-in' : d.transport === 'software-gamma' ? 'Gamma LUT' : 'DDC/CI'}
                    {' · '}
                    {out.estimatedNits} nits
                  </span>
                  {out.inSoftwareZone && (
                    <span className="font-mono text-[10px] text-amber-700 dark:text-amber-400 shrink-0">
                      Soft {Math.round(out.softwareGamma * 100)}%
                    </span>
                  )}
                </div>
                {/* Thin live luminance bar */}
                <div className="mt-2 h-1 w-full rounded-full bg-[#DCE1E9] dark:bg-[#232A37] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-amber-500 transition-all duration-150"
                    style={{ width: `${Math.max(3, Math.min(100, d.brightness))}%` }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Quiet Daemon Runtime Summary */}
      <div className="px-5 py-3.5 border-t border-[#E2E6ED] dark:border-[#1E2430] shrink-0">
        <button
          type="button"
          onClick={() => {
            onSelectTab('daemon');
            onCloseMobile();
          }}
          className="w-full flex items-center justify-between text-xs text-[#5A6475] dark:text-[#8E97A8] hover:text-[#111418] dark:hover:text-[#F3F5F8] transition-colors"
        >
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0">
            <Activity className="w-3.5 h-3.5" />
            Background Daemon
          </span>
          <span
            className={`font-medium whitespace-nowrap shrink-0 ${
              daemonRunning
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-amber-700 dark:text-amber-400'
            }`}
          >
            {daemonRunning ? 'Running' : 'Paused'}
          </span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Fixed Sidebar */}
      <aside className="hidden lg:block w-[264px] shrink-0 h-screen sticky top-0">
        {content}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-xs"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative z-10 w-[280px] max-w-[85vw] h-full">
            {content}
          </aside>
        </div>
      )}
    </>
  );
};
