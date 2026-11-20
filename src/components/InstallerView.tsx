import React, { useMemo, useState } from 'react';
import { Check, Copy, Download, Terminal } from 'lucide-react';
import { generateMacOsBundle } from '../shared/macosGenerator.ts';
import type { AppState } from '../shared/types.ts';

interface InstallerViewProps {
  state: AppState;
}

type ArtifactTab = 'installScript' | 'swiftDaemonSource' | 'launchAgentPlist' | 'configJson';

const ARTIFACT_TABS: {
  id: ArtifactTab;
  filename: string;
  label: string;
  description: string;
}[] = [
  {
    id: 'installScript',
    filename: 'install-lumabridge.sh',
    label: 'Installer Script',
    description: 'Compiles the native Swift daemon, writes your live calibrated config.json, and registers the macOS LaunchAgent.',
  },
  {
    id: 'swiftDaemonSource',
    filename: 'LumaBridgeDaemon.swift',
    label: 'Swift Daemon',
    description: 'Native macOS background process using Apple Silicon IOAVService DDC/CI, CoreGraphics gamma tables, and HiDPI display modes.',
  },
  {
    id: 'launchAgentPlist',
    filename: 'com.lumabridge.daemon.plist',
    label: 'LaunchAgent Plist',
    description: 'Standard launchd configuration keeping lumabridged alive across logins and display wakes.',
  },
  {
    id: 'configJson',
    filename: 'config.json',
    label: 'Live Config JSON',
    description: 'Serialized display topology, perceptual brightness curves, software gamma knees, and HiDPI scaling profiles.',
  },
];

function triggerFileDownload(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const InstallerView: React.FC<InstallerViewProps> = ({ state }) => {
  const [activeTab, setActiveTab] = useState<ArtifactTab>('installScript');
  const [copied, setCopied] = useState(false);

  const bundle = useMemo(() => generateMacOsBundle(state), [state]);
  const currentMeta = ARTIFACT_TABS.find((t) => t.id === activeTab) ?? ARTIFACT_TABS[0];
  const currentContent = bundle[activeTab];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(currentContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard fallback ignored
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-[#111418] dark:text-[#F3F5F8] tracking-tight">
            Native macOS Background Daemon Installer
          </h1>
          <p className="mt-1 text-sm text-[#5A6475] dark:text-[#8E97A8]">
            Every file below is dynamically generated from your active display calibration, brightness mapping curves, and scaling modes.
          </p>
        </div>

        <button
          type="button"
          onClick={() => triggerFileDownload('install-lumabridge.sh', bundle.installScript)}
          className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium rounded-lg bg-[#111418] dark:bg-amber-500 text-white dark:text-[#0B0D10] hover:bg-[#232933] dark:hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 self-start lg:self-auto"
        >
          <Download className="w-3.5 h-3.5" />
          Download One-Step Installer (.sh)
        </button>
      </div>

      {/* Quick Deployment Steps */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-5">
          <div className="text-xs font-medium text-amber-700 dark:text-amber-400">01. Download Script</div>
          <p className="mt-1.5 text-xs leading-relaxed text-[#5A6475] dark:text-[#9AA3B5]">
            Save <span className="font-mono text-[#111418] dark:text-[#F3F5F8]">install-lumabridge.sh</span> containing your {state.displays.length} configured displays and curve settings.
          </p>
        </div>

        <div className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-5">
          <div className="text-xs font-medium text-amber-700 dark:text-amber-400">02. Compile & Bootstrap</div>
          <p className="mt-1.5 text-xs leading-relaxed text-[#5A6475] dark:text-[#9AA3B5]">
            Run <span className="font-mono text-[#111418] dark:text-[#F3F5F8]">chmod +x install-lumabridge.sh && ./install-lumabridge.sh</span> in macOS Terminal (requires Xcode Command Line Tools).
          </p>
        </div>

        <div className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] p-5">
          <div className="text-xs font-medium text-amber-700 dark:text-amber-400">03. Live Reload Daemon</div>
          <p className="mt-1.5 text-xs leading-relaxed text-[#5A6475] dark:text-[#9AA3B5]">
            The <span className="font-mono text-[#111418] dark:text-[#F3F5F8]">launchd</span> service watches <span className="font-mono">~/.config/lumabridge/config.json</span> and re-applies DDC/CI and HiDPI scaling automatically.
          </p>
        </div>
      </section>

      {/* Artifact Code Inspector */}
      <section className="rounded-xl bg-white dark:bg-[#12161D] border border-[#E2E6ED] dark:border-[#1E2430] overflow-hidden">
        <div className="px-6 py-3.5 border-b border-[#EBEEF3] dark:border-[#1C222D] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-1 overflow-x-auto">
            {ARTIFACT_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id);
                  setCopied(false);
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === tab.id
                    ? 'bg-[#111418] dark:bg-amber-500 text-white dark:text-[#0B0D10]'
                    : 'text-[#5A6475] dark:text-[#8E97A8] hover:text-[#111418] dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#111418] dark:text-[#E5E9F0] hover:border-amber-500 whitespace-nowrap shrink-0"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={() => triggerFileDownload(currentMeta.filename, currentContent)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#111418] dark:text-[#E5E9F0] hover:border-amber-500 whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Save {currentMeta.filename}
            </button>
          </div>
        </div>

        <div className="px-6 py-3 bg-[#FAFBFD] dark:bg-[#151A24] border-b border-[#EBEEF3] dark:border-[#1C222D] flex items-center gap-2 text-xs text-[#5A6475] dark:text-[#9AA3B5]">
          <Terminal className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="font-mono text-[#111418] dark:text-[#E5E9F0]">{currentMeta.filename}</span>
          <span aria-hidden="true">·</span>
          <span>{currentMeta.description}</span>
        </div>

        <pre className="p-6 bg-[#F8FAFC] dark:bg-[#090C10] text-[#1E2532] dark:text-[#D5DCE8] font-mono text-xs leading-relaxed overflow-x-auto max-h-[520px] overflow-y-auto">
          <code>{currentContent}</code>
        </pre>
      </section>
    </div>
  );
};
