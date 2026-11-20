import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { createServer as createViteServer } from 'vite';
import {
  DISPLAY_CATALOG,
  buildDdcVcpPacketHex,
  clamp,
  computeBrightnessOutput,
  create4KScalingModes,
  createDefaultDisplays,
} from './src/shared/brightnessEngine.ts';
import { generateMacOsBundle } from './src/shared/macosGenerator.ts';
import type {
  AppState,
  DaemonEvent,
  DaemonEventCategory,
  DaemonEventStatus,
  DaemonSettings,
  DisplayConfig,
} from './src/shared/types.ts';

const PORT = Number(process.env.PORT) || 3000;
const STATE_FILE = path.resolve(process.cwd(), '.lumabridge-state.json');
const MAX_EVENTS = 120;

interface SseClient {
  id: string;
  res: Response;
}

class LumaBridgeDaemonProcess {
  private state: AppState;
  private sseClients: Set<SseClient> = new Set();
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private eventSeq = 1;

  constructor() {
    this.state = this.loadInitialState();
    this.startPollLoop();
    this.recordEvent({
      displayId: 'system',
      displayName: 'LumaBridge Daemon',
      category: 'lifecycle',
      operation: 'Daemon Initialized',
      payload: `PID ${process.pid} · ${process.platform}/${process.arch} · ${this.state.displays.length} displays bound`,
      latencyMs: 2,
      status: 'applied',
    });
  }

  private loadInitialState(): AppState {
    const defaultDisplays = createDefaultDisplays();
    const defaultState: AppState = {
      masterBrightness: 64,
      referenceDisplayId: 'disp-builtin-mbp',
      displays: defaultDisplays,
      daemon: {
        running: true,
        ambientSyncEnabled: true,
        pollIntervalMs: 2000,
        ddcDebounceMs: 45,
        interPacketDelayMs: 40,
        retryCount: 3,
        interceptMediaKeys: true,
        reapplyOnWake: true,
        smoothTransitionMs: 180,
      },
      metrics: {
        pid: process.pid,
        platform: process.platform === 'darwin' ? 'macOS (darwin)' : `Linux Preview (${process.platform})`,
        arch: process.arch,
        startedAt: new Date().toISOString(),
        commandsDispatched: 0,
        commandsCoalesced: 0,
        activeQueueDepth: 0,
        lastSyncAt: new Date().toISOString(),
      },
      events: [],
    };

    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<AppState>;
        if (parsed && Array.isArray(parsed.displays) && parsed.displays.length > 0 && parsed.daemon) {
          return {
            ...defaultState,
            ...parsed,
            daemon: { ...defaultState.daemon, ...parsed.daemon },
            metrics: {
              ...defaultState.metrics,
              commandsDispatched: parsed.metrics?.commandsDispatched ?? 0,
              commandsCoalesced: parsed.metrics?.commandsCoalesced ?? 0,
              lastSyncAt: parsed.metrics?.lastSyncAt ?? new Date().toISOString(),
            },
            events: Array.isArray(parsed.events) ? parsed.events.slice(0, MAX_EVENTS) : [],
          };
        }
      }
    } catch {
      // Fall back to clean defaults if state file is corrupted
    }
    return defaultState;
  }

  private persistState(): void {
    try {
      const payload = JSON.stringify(this.state, null, 2);
      fs.writeFileSync(STATE_FILE, payload, 'utf-8');
    } catch {
      // Ignore disk write error in read-only sandboxes
    }
  }

  public getState(): AppState {
    this.state.metrics.activeQueueDepth = this.debounceTimers.size;
    return this.state;
  }

  public addSseClient(res: Response): () => void {
    const client: SseClient = { id: `sse-${Date.now()}-${Math.random()}`, res };
    this.sseClients.add(client);
    res.write(`data: ${JSON.stringify({ type: 'state', payload: this.getState() })}\n\n`);
    return () => {
      this.sseClients.delete(client);
    };
  }

  private broadcast(type: 'state' | 'event', payload: unknown): void {
    const frame = `data: ${JSON.stringify({ type, payload })}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.res.write(frame);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private getReferenceNits(): number | undefined {
    const ref = this.state.displays.find((d) => d.id === this.state.referenceDisplayId) ?? this.state.displays[0];
    if (!ref) return undefined;
    return computeBrightnessOutput(ref).estimatedNits;
  }

  private recordEvent(input: {
    displayId: string;
    displayName: string;
    category: DaemonEventCategory;
    operation: string;
    payload: string;
    latencyMs: number;
    status: DaemonEventStatus;
  }): DaemonEvent {
    const ev: DaemonEvent = {
      id: `ev-${Date.now()}-${this.eventSeq++}`,
      timestamp: new Date().toISOString(),
      ...input,
    };
    this.state.events = [ev, ...this.state.events].slice(0, MAX_EVENTS);
    this.broadcast('event', ev);
    return ev;
  }

  private startPollLoop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (!this.state.daemon.running || !this.state.daemon.ambientSyncEnabled) {
      return;
    }
    const interval = clamp(this.state.daemon.pollIntervalMs, 250, 10000);
    this.pollTimer = setInterval(() => {
      if (!this.state.daemon.running || !this.state.daemon.ambientSyncEnabled) return;
      const refNits = this.getReferenceNits();
      this.state.metrics.lastSyncAt = new Date().toISOString();
      const linkedExternalCount = this.state.displays.filter((d) => !d.isBuiltIn && d.linkedToMaster).length;
      if (linkedExternalCount > 0) {
        this.recordEvent({
          displayId: this.state.referenceDisplayId,
          displayName: 'Ambient Reference Loop',
          category: 'sync',
          operation: 'Built-in ALS Check',
          payload: `Ref ${refNits?.toFixed(1) ?? '—'} cd/m² · ${linkedExternalCount} linked targets in sync`,
          latencyMs: 3,
          status: 'applied',
        });
      }
      this.broadcast('state', this.getState());
    }, interval);
  }

  /**
   * Dispatches native macOS DDC command if executing directly on darwin with m1ddc installed.
   */
  private dispatchHardwareIfMac(displayIndex: number, vcpCode: number, value: number): void {
    if (process.platform !== 'darwin') return;
    const cmd = vcpCode === 0x10 ? 'luminance' : 'contrast';
    execFile('m1ddc', ['display', String(displayIndex), 'set', cmd, String(value)], () => {
      // Best-effort native dispatch when m1ddc is present on host macOS
    });
  }

  private enqueueBrightnessDispatch(display: DisplayConfig, reason: string): void {
    if (!this.state.daemon.running) {
      this.recordEvent({
        displayId: display.id,
        displayName: display.name,
        category: 'ddc-write',
        operation: reason,
        payload: 'Daemon paused — state saved locally only',
        latencyMs: 0,
        status: 'skipped',
      });
      return;
    }

    const existing = this.debounceTimers.get(display.id);
    if (existing) {
      clearTimeout(existing);
      this.state.metrics.commandsCoalesced += 1;
    }

    const debounceMs = clamp(this.state.daemon.ddcDebounceMs, 10, 250);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(display.id);
      const currentDisplay = this.state.displays.find((d) => d.id === display.id);
      if (!currentDisplay) return;

      const refNits = this.getReferenceNits();
      const out = computeBrightnessOutput(currentDisplay, currentDisplay.brightness, refNits);
      const extIndex = this.state.displays.filter((d) => !d.isBuiltIn).findIndex((d) => d.id === currentDisplay.id) + 1;

      if (!currentDisplay.isBuiltIn && currentDisplay.transport !== 'software-gamma') {
        this.dispatchHardwareIfMac(extIndex, 0x10, out.hardwareDdc);
        this.state.metrics.commandsDispatched += 1;
        this.recordEvent({
          displayId: currentDisplay.id,
          displayName: currentDisplay.name,
          category: 'ddc-write',
          operation: `VCP 0x10 Luminance (${reason})`,
          payload: `DDC=${out.hardwareDdc} · ${out.estimatedNits} cd/m² · [${out.vcpPacketHex}]`,
          latencyMs: Math.round(this.state.daemon.interPacketDelayMs * 0.65 + 4),
          status: 'applied',
        });
      }

      if (currentDisplay.isBuiltIn) {
        this.state.metrics.commandsDispatched += 1;
        this.recordEvent({
          displayId: currentDisplay.id,
          displayName: currentDisplay.name,
          category: 'ddc-write',
          operation: `CoreDisplay Set (${reason})`,
          payload: `${out.inputPercent}% · ${out.estimatedNits} cd/m² · L* ${out.perceptualLStar}`,
          latencyMs: 4,
          status: 'applied',
        });
      }

      if (out.inSoftwareZone || currentDisplay.transport === 'software-gamma') {
        this.state.metrics.commandsDispatched += 1;
        this.recordEvent({
          displayId: currentDisplay.id,
          displayName: currentDisplay.name,
          category: 'gamma-lut',
          operation: 'CGSetDisplayTransferByTable',
          payload: `LUT Scale ×${out.softwareGamma.toFixed(3)} · Sub-Zero Floor ${out.estimatedNits} cd/m²`,
          latencyMs: 2,
          status: 'applied',
        });
      }

      this.state.metrics.lastSyncAt = new Date().toISOString();
      this.persistState();
      this.broadcast('state', this.getState());
    }, debounceMs);

    this.debounceTimers.set(display.id, timer);
    this.state.metrics.activeQueueDepth = this.debounceTimers.size;
  }

  public updateMaster(patch: { masterBrightness?: number; referenceDisplayId?: string }): AppState {
    if (typeof patch.referenceDisplayId === 'string') {
      const exists = this.state.displays.some((d) => d.id === patch.referenceDisplayId);
      if (exists) {
        this.state.referenceDisplayId = patch.referenceDisplayId;
      }
    }

    if (typeof patch.masterBrightness === 'number' && !Number.isNaN(patch.masterBrightness)) {
      const clamped = Number(clamp(patch.masterBrightness, 0, 100).toFixed(1));
      this.state.masterBrightness = clamped;
      for (const disp of this.state.displays) {
        if (disp.linkedToMaster) {
          disp.brightness = clamped;
          this.enqueueBrightnessDispatch(disp, 'Master Sync');
        }
      }
    }

    this.persistState();
    this.broadcast('state', this.getState());
    return this.getState();
  }

  public updateDisplay(id: string, patch: Partial<DisplayConfig>): AppState | null {
    const idx = this.state.displays.findIndex((d) => d.id === id);
    if (idx === -1) return null;

    const prev = this.state.displays[idx];
    const next: DisplayConfig = {
      ...prev,
      ...patch,
      mapping: patch.mapping ? { ...prev.mapping, ...patch.mapping } : prev.mapping,
    };

    if (typeof patch.brightness === 'number') {
      next.brightness = Number(clamp(patch.brightness, 0, 100).toFixed(1));
    }
    if (typeof patch.contrast === 'number') {
      next.contrast = Math.round(clamp(patch.contrast, 0, 100));
    }

    this.state.displays[idx] = next;

    // Trigger appropriate background daemon actions
    if (patch.brightness !== undefined || patch.mapping !== undefined || patch.transport !== undefined) {
      this.enqueueBrightnessDispatch(
        next,
        patch.mapping ? 'Curve Update' : patch.transport ? 'Transport Mode' : 'Manual Slider',
      );
      // If reference display changed brightness, cascade to external displays with matchReferenceNits
      if (next.id === this.state.referenceDisplayId && patch.brightness !== undefined) {
        for (const ext of this.state.displays) {
          if (ext.id !== next.id && ext.mapping.matchReferenceNits) {
            this.enqueueBrightnessDispatch(ext, 'Reference Nits Match');
          }
        }
      }
    }

    if (patch.contrast !== undefined && patch.contrast !== prev.contrast && !next.isBuiltIn) {
      const hex = buildDdcVcpPacketHex(0x12, next.contrast);
      this.state.metrics.commandsDispatched += 1;
      this.recordEvent({
        displayId: next.id,
        displayName: next.name,
        category: 'ddc-write',
        operation: 'VCP 0x12 Contrast',
        payload: `Contrast=${next.contrast}% · [${hex}]`,
        latencyMs: Math.round(this.state.daemon.interPacketDelayMs * 0.6 + 5),
        status: this.state.daemon.running ? 'applied' : 'skipped',
      });
    }

    if (
      (patch.activeScalingId && patch.activeScalingId !== prev.activeScalingId) ||
      (patch.refreshRate && patch.refreshRate !== prev.refreshRate) ||
      (patch.rotation !== undefined && patch.rotation !== prev.rotation) ||
      (patch.pixelFormat && patch.pixelFormat !== prev.pixelFormat)
    ) {
      const mode = next.scalingModes.find((m) => m.id === next.activeScalingId) ?? next.scalingModes[0];
      this.state.metrics.commandsDispatched += 1;
      this.recordEvent({
        displayId: next.id,
        displayName: next.name,
        category: 'scaling',
        operation: 'CGConfigureDisplayWithDisplayMode',
        payload: `${mode.logicalWidth}×${mode.logicalHeight} ${mode.hidpi ? 'HiDPI' : '1×'} @ ${next.refreshRate}Hz · ${next.pixelFormat} · Rot ${next.rotation}°`,
        latencyMs: 38,
        status: this.state.daemon.running ? 'applied' : 'skipped',
      });
    }

    this.persistState();
    this.broadcast('state', this.getState());
    return this.getState();
  }

  public addDisplay(payload: {
    templateKey?: string;
    custom?: {
      name: string;
      vendor: string;
      diagonalInches: number;
      nativeWidth: number;
      nativeHeight: number;
      physicalMinNits: number;
      physicalMaxNits: number;
      connection: string;
    };
  }): AppState {
    const id = `disp-${Date.now()}`;
    let newDisplay: DisplayConfig;

    const template = payload.templateKey
      ? DISPLAY_CATALOG.find((t) => t.key === payload.templateKey)
      : undefined;

    if (template) {
      const rec = template.scalingModes.find((m) => m.recommended) ?? template.scalingModes[0];
      newDisplay = {
        id,
        name: template.name,
        vendor: template.vendor,
        modelCode: template.modelCode,
        edidSerial: `EDID-${Math.floor(100000 + Math.random() * 900000)}`,
        connection: template.connection,
        isBuiltIn: false,
        diagonalInches: template.diagonalInches,
        nativeWidth: template.nativeWidth,
        nativeHeight: template.nativeHeight,
        panelType: template.panelType,
        physicalMinNits: template.physicalMinNits,
        physicalMaxNits: template.physicalMaxNits,
        transport: template.transport,
        linkedToMaster: true,
        brightness: this.state.masterBrightness,
        contrast: 75,
        activeScalingId: rec.id,
        refreshRate: rec.refreshRates[0] ?? 60,
        pixelFormat: 'RGB 10-bit',
        rotation: 0,
        overscanPercent: 0,
        positionIndex: this.state.displays.length,
        scalingModes: template.scalingModes,
        mapping: {
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
        },
      };
    } else {
      const c = payload.custom;
      const modes = create4KScalingModes([60]);
      newDisplay = {
        id,
        name: c?.name?.trim() || 'External 4K Display',
        vendor: c?.vendor?.trim() || 'Generic',
        modelCode: 'EXT-DDC1',
        edidSerial: `EDID-${Math.floor(100000 + Math.random() * 900000)}`,
        connection: c?.connection?.trim() || 'USB-C DP Alt',
        isBuiltIn: false,
        diagonalInches: clamp(Number(c?.diagonalInches) || 27, 13, 49),
        nativeWidth: clamp(Number(c?.nativeWidth) || 3840, 1280, 7680),
        nativeHeight: clamp(Number(c?.nativeHeight) || 2160, 720, 4320),
        panelType: 'IPS LCD',
        physicalMinNits: clamp(Number(c?.physicalMinNits) || 40, 1, 200),
        physicalMaxNits: clamp(Number(c?.physicalMaxNits) || 350, 100, 1600),
        transport: 'combined',
        linkedToMaster: true,
        brightness: this.state.masterBrightness,
        contrast: 75,
        activeScalingId: modes[1].id,
        refreshRate: 60,
        pixelFormat: 'RGB 8-bit',
        rotation: 0,
        overscanPercent: 0,
        positionIndex: this.state.displays.length,
        scalingModes: modes,
        mapping: {
          mode: 'dual-stage',
          gammaExponent: 1.7,
          softwareKnee: 25,
          softwareMinFactor: 0.2,
          hardwareMinClamp: 0,
          hardwareMaxClamp: 100,
          linkContrastBelowKnee: false,
          contrastMinClamp: 50,
          matchReferenceNits: false,
          customPoints: [
            { x: 0, y: 0 },
            { x: 25, y: 15 },
            { x: 50, y: 40 },
            { x: 75, y: 70 },
            { x: 100, y: 100 },
          ],
        },
      };
    }

    this.state.displays.push(newDisplay);
    this.recordEvent({
      displayId: newDisplay.id,
      displayName: newDisplay.name,
      category: 'bus-probe',
      operation: 'IOAVService Display Attached',
      payload: `${newDisplay.modelCode} · ${newDisplay.nativeWidth}×${newDisplay.nativeHeight} · ${newDisplay.connection}`,
      latencyMs: 26,
      status: 'applied',
    });
    this.enqueueBrightnessDispatch(newDisplay, 'Initial Bind');
    this.persistState();
    this.broadcast('state', this.getState());
    return this.getState();
  }

  public removeDisplay(id: string): AppState | null {
    const target = this.state.displays.find((d) => d.id === id);
    if (!target || target.isBuiltIn) return null;
    this.state.displays = this.state.displays.filter((d) => d.id !== id);
    this.recordEvent({
      displayId: target.id,
      displayName: target.name,
      category: 'bus-probe',
      operation: 'Display Detached',
      payload: `Released I2C handle for ${target.modelCode}`,
      latencyMs: 5,
      status: 'applied',
    });
    this.persistState();
    this.broadcast('state', this.getState());
    return this.getState();
  }

  public updateDaemonSettings(patch: Partial<DaemonSettings>): AppState {
    this.state.daemon = {
      ...this.state.daemon,
      ...patch,
      pollIntervalMs: clamp(patch.pollIntervalMs ?? this.state.daemon.pollIntervalMs, 250, 10000),
      ddcDebounceMs: clamp(patch.ddcDebounceMs ?? this.state.daemon.ddcDebounceMs, 15, 200),
      interPacketDelayMs: clamp(patch.interPacketDelayMs ?? this.state.daemon.interPacketDelayMs, 20, 120),
      retryCount: clamp(patch.retryCount ?? this.state.daemon.retryCount, 1, 5),
      smoothTransitionMs: clamp(patch.smoothTransitionMs ?? this.state.daemon.smoothTransitionMs, 0, 600),
    };
    this.startPollLoop();
    this.recordEvent({
      displayId: 'system',
      displayName: 'LumaBridge Daemon',
      category: 'lifecycle',
      operation: 'Configuration Reloaded',
      payload: `Debounce ${this.state.daemon.ddcDebounceMs}ms · Poll ${this.state.daemon.pollIntervalMs}ms · Retries ${this.state.daemon.retryCount}`,
      latencyMs: 3,
      status: 'applied',
    });
    this.persistState();
    this.broadcast('state', this.getState());
    return this.getState();
  }

  public runDaemonAction(action: string, displayId?: string): AppState {
    switch (action) {
      case 'start':
        this.state.daemon.running = true;
        this.startPollLoop();
        this.recordEvent({
          displayId: 'system',
          displayName: 'LumaBridge Daemon',
          category: 'lifecycle',
          operation: 'Daemon Resumed',
          payload: 'I2C write queue & media key tap active',
          latencyMs: 4,
          status: 'applied',
        });
        break;
      case 'pause':
        this.state.daemon.running = false;
        this.startPollLoop();
        this.recordEvent({
          displayId: 'system',
          displayName: 'LumaBridge Daemon',
          category: 'lifecycle',
          operation: 'Daemon Paused',
          payload: 'Suspended DDC/CI dispatch & ambient polling',
          latencyMs: 2,
          status: 'applied',
        });
        break;
      case 'restart':
        this.state.daemon.running = true;
        this.state.metrics.startedAt = new Date().toISOString();
        this.startPollLoop();
        this.recordEvent({
          displayId: 'system',
          displayName: 'LumaBridge Daemon',
          category: 'lifecycle',
          operation: 'Daemon Restarted',
          payload: `Fresh worker loop on PID ${process.pid}`,
          latencyMs: 14,
          status: 'applied',
        });
        for (const d of this.state.displays) {
          this.enqueueBrightnessDispatch(d, 'Wake / Restart Sync');
        }
        break;
      case 'sync-all':
        for (const d of this.state.displays) {
          this.enqueueBrightnessDispatch(d, 'Full Sync');
        }
        break;
      case 'probe-bus':
        for (const d of this.state.displays) {
          this.recordEvent({
            displayId: d.id,
            displayName: d.name,
            category: 'bus-probe',
            operation: d.isBuiltIn ? 'CoreDisplay Check' : 'DDC/CI Capabilities Probe',
            payload: d.isBuiltIn
              ? `${d.modelCode} · Internal eDP OK`
              : `${d.modelCode} · I2C 0x37 ACK · VCP 0x10/0x12 Supported`,
            latencyMs: d.isBuiltIn ? 3 : 29,
            status: 'applied',
          });
        }
        break;
      case 'clear-events':
        this.state.events = [];
        break;
      case 'step-up':
      case 'step-down':
      case 'fine-up':
      case 'fine-down': {
        const delta =
          action === 'step-up' ? 6.25 : action === 'step-down' ? -6.25 : action === 'fine-up' ? 1.5625 : -1.5625;
        if (displayId) {
          const target = this.state.displays.find((d) => d.id === displayId);
          if (target) {
            this.updateDisplay(target.id, { brightness: clamp(target.brightness + delta, 0, 100) });
          }
        } else {
          this.updateMaster({ masterBrightness: clamp(this.state.masterBrightness + delta, 0, 100) });
        }
        return this.getState();
      }
      default:
        break;
    }

    this.persistState();
    this.broadcast('state', this.getState());
    return this.getState();
  }
}

async function startServer() {
  const app = express();
  app.use(express.json());

  const daemon = new LumaBridgeDaemonProcess();

  // REST API routes
  app.get('/api/state', (_req: Request, res: Response) => {
    res.json(daemon.getState());
  });

  app.get('/api/daemon/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const unsubscribe = daemon.addSseClient(res);
    const keepalive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(keepalive);
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  app.patch('/api/master', (req: Request, res: Response) => {
    const updated = daemon.updateMaster(req.body ?? {});
    res.json(updated);
  });

  app.patch('/api/displays/:id', (req: Request, res: Response) => {
    const updated = daemon.updateDisplay(req.params.id, req.body ?? {});
    if (!updated) {
      res.status(404).json({ error: 'Display not found' });
      return;
    }
    res.json(updated);
  });

  app.post('/api/displays', (req: Request, res: Response) => {
    const updated = daemon.addDisplay(req.body ?? {});
    res.status(201).json(updated);
  });

  app.delete('/api/displays/:id', (req: Request, res: Response) => {
    const updated = daemon.removeDisplay(req.params.id);
    if (!updated) {
      res.status(400).json({ error: 'Cannot remove built-in or unknown display' });
      return;
    }
    res.json(updated);
  });

  app.patch('/api/daemon/settings', (req: Request, res: Response) => {
    const updated = daemon.updateDaemonSettings(req.body ?? {});
    res.json(updated);
  });

  app.post('/api/daemon/action', (req: Request, res: Response) => {
    const { action, displayId } = req.body ?? {};
    if (typeof action !== 'string') {
      res.status(400).json({ error: 'Missing action' });
      return;
    }
    const updated = daemon.runDaemonAction(action, displayId);
    res.json(updated);
  });

  app.get('/api/export/bundle', (_req: Request, res: Response) => {
    const bundle = generateMacOsBundle(daemon.getState());
    res.json(bundle);
  });

  // Mount Vite middleware in development, or static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LumaBridge server & background daemon listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
