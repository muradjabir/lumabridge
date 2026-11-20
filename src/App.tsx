import { useCallback, useEffect, useRef, useState } from 'react';
import { AddDisplayModal } from './components/AddDisplayModal.tsx';
import { BrightnessMappingView } from './components/BrightnessMappingView.tsx';
import { DaemonView } from './components/DaemonView.tsx';
import { DisplaysView } from './components/DisplaysView.tsx';
import { InstallerView } from './components/InstallerView.tsx';
import { ScalingView } from './components/ScalingView.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import type { WorkspaceTab } from './components/Sidebar.tsx';
import { TopBar } from './components/TopBar.tsx';
import { computeBrightnessOutput } from './shared/brightnessEngine.ts';
import type { AppState, DaemonEvent, DaemonSettings, DisplayConfig } from './shared/types.ts';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('displays');
  const [selectedDisplayId, setSelectedDisplayId] = useState<string>('disp-dell-u2723qe');
  const [isDark, setIsDark] = useState<boolean>(true);
  const [mobileNavOpen, setMobileNavOpen] = useState<boolean>(false);
  const [addModalOpen, setAddModalOpen] = useState<boolean>(false);
  const [sseConnected, setSseConnected] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const masterPatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync Tailwind v4 dark class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [isDark]);

  // Initial state load + Server-Sent Events subscription to background daemon
  useEffect(() => {
    let active = true;

    fetch('/api/state')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<AppState>;
      })
      .then((data) => {
        if (!active) return;
        setState(data);
        setLoadError(null);
        const preferred = data.displays.find((d) => !d.isBuiltIn) ?? data.displays[0];
        if (preferred) setSelectedDisplayId(preferred.id);
      })
      .catch((err) => {
        if (!active) return;
        setLoadError(err instanceof Error ? err.message : 'Unable to reach daemon API');
      });

    const es = new EventSource('/api/daemon/events');
    es.onopen = () => {
      if (active) setSseConnected(true);
    };
    es.onerror = () => {
      if (active) setSseConnected(false);
    };
    es.onmessage = (evt) => {
      if (!active) return;
      try {
        const msg = JSON.parse(evt.data) as { type: 'state' | 'event'; payload: unknown };
        if (msg.type === 'state') {
          setState(msg.payload as AppState);
        } else if (msg.type === 'event') {
          const ev = msg.payload as DaemonEvent;
          setState((prev) => {
            if (!prev) return prev;
            if (prev.events.some((e) => e.id === ev.id)) return prev;
            return {
              ...prev,
              events: [ev, ...prev.events].slice(0, 120),
            };
          });
        }
      } catch {
        // Ignore malformed SSE frames
      }
    };

    return () => {
      active = false;
      es.close();
    };
  }, []);

  const runDaemonAction = useCallback(async (action: string, displayId?: string) => {
    if (action === 'sync-all') setIsSyncing(true);
    try {
      const res = await fetch('/api/daemon/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, displayId }),
      });
      if (res.ok) {
        const updated = (await res.json()) as AppState;
        setState(updated);
      }
    } finally {
      if (action === 'sync-all') {
        setTimeout(() => setIsSyncing(false), 350);
      }
    }
  }, []);

  // Keyboard shortcuts simulating macOS F1/F2 brightness keys ([ and ], Shift for quarter-steps)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '[' || e.key === '{') {
        e.preventDefault();
        runDaemonAction(e.shiftKey ? 'fine-down' : 'step-down');
      } else if (e.key === ']' || e.key === '}') {
        e.preventDefault();
        runDaemonAction(e.shiftKey ? 'fine-up' : 'step-up');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [runDaemonAction]);

  const handleChangeMasterBrightness = useCallback((value: number) => {
    // Immediate optimistic update for silky 60fps optical response
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        masterBrightness: value,
        displays: prev.displays.map((d) => (d.linkedToMaster ? { ...d, brightness: value } : d)),
      };
    });

    if (masterPatchTimer.current) clearTimeout(masterPatchTimer.current);
    masterPatchTimer.current = setTimeout(() => {
      fetch('/api/master', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ masterBrightness: value }),
      })
        .then((res) => (res.ok ? (res.json() as Promise<AppState>) : null))
        .then((updated) => {
          if (updated) setState(updated);
        })
        .catch(() => {});
    }, 25);
  }, []);

  const handleUpdateDisplay = useCallback((id: string, patch: Partial<DisplayConfig>) => {
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        displays: prev.displays.map((d) =>
          d.id === id
            ? {
                ...d,
                ...patch,
                mapping: patch.mapping ? { ...d.mapping, ...patch.mapping } : d.mapping,
              }
            : d,
        ),
      };
    });

    fetch(`/api/displays/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
      .then((res) => (res.ok ? (res.json() as Promise<AppState>) : null))
      .then((updated) => {
        if (updated) setState(updated);
      })
      .catch(() => {});
  }, []);

  const handleAddTemplate = useCallback(async (templateKey: string) => {
    const res = await fetch('/api/displays', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateKey }),
    });
    if (res.ok) {
      const updated = (await res.json()) as AppState;
      setState(updated);
      const newest = updated.displays[updated.displays.length - 1];
      if (newest) setSelectedDisplayId(newest.id);
    }
  }, []);

  const handleAddCustom = useCallback(
    async (custom: {
      name: string;
      vendor: string;
      diagonalInches: number;
      nativeWidth: number;
      nativeHeight: number;
      physicalMinNits: number;
      physicalMaxNits: number;
      connection: string;
    }) => {
      const res = await fetch('/api/displays', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ custom }),
      });
      if (res.ok) {
        const updated = (await res.json()) as AppState;
        setState(updated);
        const newest = updated.displays[updated.displays.length - 1];
        if (newest) setSelectedDisplayId(newest.id);
      }
    },
    [],
  );

  const handleRemoveDisplay = useCallback(async (id: string) => {
    const res = await fetch(`/api/displays/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) {
      const updated = (await res.json()) as AppState;
      setState(updated);
      const fallback = updated.displays.find((d) => !d.isBuiltIn) ?? updated.displays[0];
      if (fallback) setSelectedDisplayId(fallback.id);
    }
  }, []);

  const handleUpdateDaemonSettings = useCallback((patch: Partial<DaemonSettings>) => {
    setState((prev) => (prev ? { ...prev, daemon: { ...prev.daemon, ...patch } } : prev));
    fetch('/api/daemon/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
      .then((res) => (res.ok ? (res.json() as Promise<AppState>) : null))
      .then((updated) => {
        if (updated) setState(updated);
      })
      .catch(() => {});
  }, []);

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-[#F7F8FA] dark:bg-[#0B0D10]">
        <div className="max-w-md w-full rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-6">
          <h1 className="font-display text-base font-semibold text-[#111418] dark:text-[#F3F5F8]">
            Background Daemon Unavailable
          </h1>
          <p className="mt-2 text-sm text-[#5A6475] dark:text-[#8E97A8]">
            Could not connect to the LumaBridge local server ({loadError}).
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 text-xs font-medium rounded-lg bg-[#111418] dark:bg-amber-500 text-white dark:text-[#0B0D10]"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7F8FA] dark:bg-[#0B0D10]">
        <div className="space-y-2 text-center">
          <div className="font-display text-base font-semibold text-[#111418] dark:text-[#F3F5F8]">
            LumaBridge
          </div>
          <div className="text-xs text-[#667085] dark:text-[#8E97A8]">
            Connecting to display brightness daemon...
          </div>
        </div>
      </div>
    );
  }

  const refDisplay = state.displays.find((d) => d.id === state.referenceDisplayId) ?? state.displays[0];
  const referenceNits = refDisplay ? computeBrightnessOutput(refDisplay).estimatedNits : undefined;
  const selectedDisplay = state.displays.find((d) => d.id === selectedDisplayId) ?? state.displays[0];

  return (
    <div className="min-h-screen flex bg-[#F7F8FA] dark:bg-[#0B0D10] text-[#111418] dark:text-[#F3F5F8]">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        displays={state.displays}
        selectedDisplayId={selectedDisplay?.id ?? ''}
        referenceNits={referenceNits}
        onSelectDisplay={setSelectedDisplayId}
        onOpenAddDisplay={() => setAddModalOpen(true)}
        daemonRunning={state.daemon.running}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          activeTab={activeTab}
          selectedDisplayName={selectedDisplay?.name ?? ''}
          isDark={isDark}
          onToggleTheme={() => setIsDark((prev) => !prev)}
          onSyncAll={() => runDaemonAction('sync-all')}
          isSyncing={isSyncing}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />

        <main className="flex-1 w-full max-w-[1220px] mx-auto px-4 sm:px-6 lg:px-8 py-7">
          {activeTab === 'displays' && (
            <DisplaysView
              displays={state.displays}
              selectedDisplayId={selectedDisplay?.id ?? ''}
              masterBrightness={state.masterBrightness}
              referenceDisplayId={state.referenceDisplayId}
              onSelectDisplay={setSelectedDisplayId}
              onChangeMasterBrightness={handleChangeMasterBrightness}
              onStepHotkey={(action, displayId) => runDaemonAction(action, displayId)}
              onUpdateDisplay={handleUpdateDisplay}
              onRemoveDisplay={handleRemoveDisplay}
              onNavigateTab={setActiveTab}
            />
          )}

          {activeTab === 'mapping' && (
            <BrightnessMappingView
              displays={state.displays}
              selectedDisplayId={selectedDisplay?.id ?? ''}
              referenceDisplayId={state.referenceDisplayId}
              onSelectDisplay={setSelectedDisplayId}
              onUpdateDisplay={handleUpdateDisplay}
            />
          )}

          {activeTab === 'scaling' && (
            <ScalingView
              displays={state.displays}
              selectedDisplayId={selectedDisplay?.id ?? ''}
              onSelectDisplay={setSelectedDisplayId}
              onUpdateDisplay={handleUpdateDisplay}
            />
          )}

          {activeTab === 'daemon' && (
            <DaemonView
              settings={state.daemon}
              metrics={state.metrics}
              events={state.events}
              sseConnected={sseConnected}
              onUpdateSettings={handleUpdateDaemonSettings}
              onRunAction={(action) => runDaemonAction(action)}
            />
          )}

          {activeTab === 'installer' && <InstallerView state={state} />}
        </main>
      </div>

      <AddDisplayModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onAddTemplate={handleAddTemplate}
        onAddCustom={handleAddCustom}
      />
    </div>
  );
}
