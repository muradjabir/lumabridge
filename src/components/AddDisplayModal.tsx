import React, { useState } from 'react';
import { X } from 'lucide-react';
import { DISPLAY_CATALOG } from '../shared/brightnessEngine.ts';

interface AddDisplayModalProps {
  open: boolean;
  onClose: () => void;
  onAddTemplate: (templateKey: string) => void;
  onAddCustom: (custom: {
    name: string;
    vendor: string;
    diagonalInches: number;
    nativeWidth: number;
    nativeHeight: number;
    physicalMinNits: number;
    physicalMaxNits: number;
    connection: string;
  }) => void;
}

export const AddDisplayModal: React.FC<AddDisplayModalProps> = ({
  open,
  onClose,
  onAddTemplate,
  onAddCustom,
}) => {
  const [mode, setMode] = useState<'catalog' | 'custom'>('catalog');
  const [name, setName] = useState('External 4K Reference');
  const [vendor, setVendor] = useState('LG Electronics');
  const [diagonalInches, setDiagonalInches] = useState(27);
  const [nativeWidth, setNativeWidth] = useState(3840);
  const [nativeHeight, setNativeHeight] = useState(2160);
  const [physicalMinNits, setPhysicalMinNits] = useState(40);
  const [physicalMaxNits, setPhysicalMaxNits] = useState(350);
  const [connection, setConnection] = useState('USB-C DP Alt');

  if (!open) return null;

  const handleSubmitCustom = (e: React.FormEvent) => {
    e.preventDefault();
    onAddCustom({
      name,
      vendor,
      diagonalInches,
      nativeWidth,
      nativeHeight,
      physicalMinNits,
      physicalMaxNits,
      connection,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-display-title"
        className="w-full max-w-2xl rounded-xl bg-white dark:bg-[#12161D] border border-[#DCE1E9] dark:border-[#242C3A] shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2E6ED] dark:border-[#1E2430]">
          <h2 id="add-display-title" className="font-display text-base font-semibold text-[#111418] dark:text-[#F3F5F8]">
            Add External Display
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="p-1.5 rounded-lg text-[#5A6475] dark:text-[#8E97A8] hover:text-[#111418] dark:hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6">
          <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#EFF2F6] dark:bg-[#1A202B] mb-5">
            <button
              type="button"
              onClick={() => setMode('catalog')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                mode === 'catalog'
                  ? 'bg-white dark:bg-[#262E3D] text-[#111418] dark:text-white shadow-xs'
                  : 'text-[#5A6475] dark:text-[#8E97A8] hover:text-[#111418] dark:hover:text-white'
              }`}
            >
              Hardware Profiles
            </button>
            <button
              type="button"
              onClick={() => setMode('custom')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                mode === 'custom'
                  ? 'bg-white dark:bg-[#262E3D] text-[#111418] dark:text-white shadow-xs'
                  : 'text-[#5A6475] dark:text-[#8E97A8] hover:text-[#111418] dark:hover:text-white'
              }`}
            >
              Custom EDID / Panel
            </button>
          </div>

          {mode === 'catalog' ? (
            <div className="divide-y divide-[#E7EBF1] dark:divide-[#1E2430] border border-[#E2E6ED] dark:border-[#222936] rounded-lg max-h-[380px] overflow-y-auto">
              {DISPLAY_CATALOG.map((item) => (
                <div
                  key={item.key}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3.5 hover:bg-[#F7F9FB] dark:hover:bg-[#171C25] transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#111418] dark:text-[#F3F5F8] truncate">
                      {item.name}
                    </div>
                    <div className="mt-0.5 text-xs text-[#667085] dark:text-[#8E97A8] tabular-nums">
                      {item.diagonalInches}&quot; · {item.nativeWidth}×{item.nativeHeight} · {item.physicalMinNits}–{item.physicalMaxNits} nits · {item.connection}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onAddTemplate(item.key);
                      onClose();
                    }}
                    className="px-3.5 py-1.5 text-xs font-medium rounded-lg border border-[#D4DAE4] dark:border-[#2C3546] text-[#111418] dark:text-[#F3F5F8] hover:border-amber-500 hover:text-amber-700 dark:hover:text-amber-400 transition-colors whitespace-nowrap shrink-0 self-start sm:self-center"
                  >
                    Attach Display
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <form onSubmit={handleSubmitCustom} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5]">Display Name</span>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-white dark:bg-[#0E1117] text-[#111418] dark:text-[#F3F5F8] focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5]">Manufacturer</span>
                  <input
                    type="text"
                    value={vendor}
                    onChange={(e) => setVendor(e.target.value)}
                    className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-white dark:bg-[#0E1117] text-[#111418] dark:text-[#F3F5F8] focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5]">Native Width (px)</span>
                  <input
                    type="number"
                    min={1280}
                    max={7680}
                    value={nativeWidth}
                    onChange={(e) => setNativeWidth(Number(e.target.value))}
                    className="mt-1.5 w-full px-3 py-2 font-mono text-sm tabular-nums rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-white dark:bg-[#0E1117] text-[#111418] dark:text-[#F3F5F8] focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5]">Native Height (px)</span>
                  <input
                    type="number"
                    min={720}
                    max={4320}
                    value={nativeHeight}
                    onChange={(e) => setNativeHeight(Number(e.target.value))}
                    className="mt-1.5 w-full px-3 py-2 font-mono text-sm tabular-nums rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-white dark:bg-[#0E1117] text-[#111418] dark:text-[#F3F5F8] focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5]">Diagonal (inches)</span>
                  <input
                    type="number"
                    step="0.5"
                    min={13}
                    max={49}
                    value={diagonalInches}
                    onChange={(e) => setDiagonalInches(Number(e.target.value))}
                    className="mt-1.5 w-full px-3 py-2 font-mono text-sm tabular-nums rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-white dark:bg-[#0E1117] text-[#111418] dark:text-[#F3F5F8] focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5]">Connection Bus</span>
                  <input
                    type="text"
                    value={connection}
                    onChange={(e) => setConnection(e.target.value)}
                    className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-white dark:bg-[#0E1117] text-[#111418] dark:text-[#F3F5F8] focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5]">Measured Min Nits (DDC 0)</span>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={physicalMinNits}
                    onChange={(e) => setPhysicalMinNits(Number(e.target.value))}
                    className="mt-1.5 w-full px-3 py-2 font-mono text-sm tabular-nums rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-white dark:bg-[#0E1117] text-[#111418] dark:text-[#F3F5F8] focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-[#5A6475] dark:text-[#9AA3B5]">Measured Max Nits (DDC 100)</span>
                  <input
                    type="number"
                    min={100}
                    max={1600}
                    value={physicalMaxNits}
                    onChange={(e) => setPhysicalMaxNits(Number(e.target.value))}
                    className="mt-1.5 w-full px-3 py-2 font-mono text-sm tabular-nums rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] bg-white dark:bg-[#0E1117] text-[#111418] dark:text-[#F3F5F8] focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </label>
              </div>
              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-medium rounded-lg border border-[#DCE1E9] dark:border-[#262E3D] text-[#525B6B] dark:text-[#9AA3B5] hover:text-[#111418] dark:hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-[#111418] dark:bg-amber-500 text-white dark:text-[#0B0D10] hover:bg-[#232933] dark:hover:bg-amber-400"
                >
                  Create Display Profile
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
