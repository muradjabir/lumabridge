import React from 'react';
import { Menu, Moon, RefreshCw, Sun } from 'lucide-react';
import type { WorkspaceTab } from './Sidebar.tsx';

interface TopBarProps {
  activeTab: WorkspaceTab;
  selectedDisplayName: string;
  isDark: boolean;
  onToggleTheme: () => void;
  onSyncAll: () => void;
  isSyncing: boolean;
  onOpenMobileNav: () => void;
}

const TAB_TITLES: Record<WorkspaceTab, string> = {
  displays: 'Displays',
  mapping: 'Brightness Mapping',
  scaling: 'Scaling & Modes',
  daemon: 'Background Process',
  installer: 'macOS Installer',
};

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  selectedDisplayName,
  isDark,
  onToggleTheme,
  onSyncAll,
  isSyncing,
  onOpenMobileNav,
}) => {
  const showDisplayCrumb = activeTab === 'mapping' || activeTab === 'scaling';

  return (
    <header className="sticky top-0 z-30 h-14 px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4 bg-[#F7F8FA]/90 dark:bg-[#0B0D10]/90 backdrop-blur-md border-b border-[#E2E6ED] dark:border-[#1E2430]">
      {/* Left: Mobile Menu Trigger + Breadcrumb */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Open navigation"
          className="lg:hidden p-2 -ml-2 rounded-lg text-[#5A6475] dark:text-[#8E97A8] hover:text-[#111418] dark:hover:text-white"
        >
          <Menu className="w-5 h-5" />
        </button>

        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-[#667085] dark:text-[#7F889B] whitespace-nowrap shrink-0">
            LumaBridge
          </span>
          <span className="text-[#B8C0CC] dark:text-[#3B4354]" aria-hidden="true">/</span>
          <span className="font-medium text-[#111418] dark:text-[#F3F5F8] whitespace-nowrap shrink-0">
            {TAB_TITLES[activeTab]}
          </span>
          {showDisplayCrumb && (
            <>
              <span className="hidden sm:inline text-[#B8C0CC] dark:text-[#3B4354]" aria-hidden="true">/</span>
              <span className="hidden sm:inline text-[#5A6475] dark:text-[#9AA3B5] truncate max-w-[220px]">
                {selectedDisplayName}
              </span>
            </>
          )}
        </nav>
      </div>

      {/* Right: Theme Switch + Primary Action */}
      <div className="flex items-center gap-2.5 shrink-0">
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[#DCE1E9] dark:border-[#242B38] bg-white dark:bg-[#141820] text-[#525B6B] dark:text-[#9AA3B5] hover:text-[#111418] dark:hover:text-[#F3F5F8] transition-colors shrink-0"
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        <button
          type="button"
          onClick={onSyncAll}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-[#111418] dark:bg-amber-500 text-white dark:text-[#0B0D10] hover:bg-[#232933] dark:hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
          Sync Displays
        </button>
      </div>
    </header>
  );
};
