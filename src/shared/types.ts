export type ControlTransport = 'native-apple' | 'ddc-ci' | 'combined' | 'software-gamma';

export type CurveMode = 'perceptual' | 'gamma' | 'dual-stage' | 'custom-spline';

export type PixelFormat = 'RGB 10-bit' | 'RGB 8-bit' | 'YCbCr 4:2:2';

export type RotationDegrees = 0 | 90 | 180 | 270;

export interface CurvePoint {
  x: number; // 0..100 input %
  y: number; // 0..100 normalized output %
}

export interface BrightnessMappingConfig {
  mode: CurveMode;
  gammaExponent: number; // 0.6 to 3.0
  softwareKnee: number; // 0 to 50 (% input below which software gamma dims below hardware min)
  softwareMinFactor: number; // 0.12 to 1.0 (minimum gamma LUT multiplier)
  hardwareMinClamp: number; // 0 to 40 (min VCP 0x10 sent to monitor)
  hardwareMaxClamp: number; // 60 to 100 (max VCP 0x10 sent to monitor)
  linkContrastBelowKnee: boolean;
  contrastMinClamp: number; // 30 to 80
  matchReferenceNits: boolean;
  customPoints: CurvePoint[]; // 5 control points for custom-spline mode
}

export interface ScalingMode {
  id: string;
  label: string;
  logicalWidth: number;
  logicalHeight: number;
  backingWidth: number;
  backingHeight: number;
  hidpi: boolean;
  refreshRates: number[];
  recommended?: boolean;
}

export interface DisplayConfig {
  id: string;
  name: string;
  vendor: string;
  modelCode: string;
  edidSerial: string;
  connection: string; // e.g., "USB-C DP Alt", "Thunderbolt 4", "HDMI 2.1", "Internal eDP"
  isBuiltIn: boolean;
  diagonalInches: number;
  nativeWidth: number;
  nativeHeight: number;
  panelType: string; // e.g., "IPS Black", "Liquid Retina XDR", "QD-OLED", "IPS Matte"
  physicalMinNits: number; // Measured luminance at DDC 0
  physicalMaxNits: number; // Measured luminance at DDC 100
  transport: ControlTransport;
  linkedToMaster: boolean;
  brightness: number; // 0..100 perceived command %
  contrast: number; // 0..100 VCP 0x12
  activeScalingId: string;
  refreshRate: number;
  pixelFormat: PixelFormat;
  rotation: RotationDegrees;
  overscanPercent: number; // 0..10
  scalingModes: ScalingMode[];
  mapping: BrightnessMappingConfig;
  positionIndex: number; // Layout ordering on desk
}

export interface ComputedBrightnessOutput {
  inputPercent: number;
  hardwareDdc: number; // 0..100 integer VCP 0x10
  softwareGamma: number; // 0.12..1.00 CGSetDisplayTransferByTable multiplier
  contrastDdc: number; // 0..100 integer VCP 0x12
  estimatedNits: number; // cd/m^2
  perceptualLStar: number; // 0..100 CIE L*
  inSoftwareZone: boolean;
  vcpPacketHex: string; // Authentic DDC/CI I2C frame bytes
}

export interface DaemonSettings {
  running: boolean;
  ambientSyncEnabled: boolean;
  syncAutoBrightness: boolean; // Follow gradual macOS Auto-Brightness (ALS) drift; false = manual F1/F2 & sliders only
  alsDeadbandPercent: number; // 0.5..10.0 (% delta threshold before ALS drift updates external displays)
  alsSmoothingWindowMs: number; // 400..6000 (EMA low-pass smoothing & settle window for ALS drift)
  ddcRampStepMs: number; // 35..250 (paced ms interval between hardware DDC steps during smooth fades)
  pollIntervalMs: number; // 250..5000
  ddcDebounceMs: number; // 15..150
  interPacketDelayMs: number; // 25..100
  retryCount: number; // 1..5
  interceptMediaKeys: boolean;
  reapplyOnWake: boolean;
  smoothTransitionMs: number; // 0..600
}

export type DaemonEventCategory = 'ddc-write' | 'gamma-lut' | 'scaling' | 'sync' | 'bus-probe' | 'lifecycle';

export type DaemonEventStatus = 'applied' | 'coalesced' | 'retrying' | 'skipped';

export interface DaemonEvent {
  id: string;
  timestamp: string;
  displayId: string;
  displayName: string;
  category: DaemonEventCategory;
  operation: string;
  payload: string;
  latencyMs: number;
  status: DaemonEventStatus;
}

export interface DaemonMetrics {
  pid: number;
  platform: string;
  arch: string;
  startedAt: string;
  commandsDispatched: number;
  commandsCoalesced: number;
  activeQueueDepth: number;
  lastSyncAt: string | null;
}

export interface AppState {
  masterBrightness: number; // 0..100
  referenceDisplayId: string;
  displays: DisplayConfig[];
  daemon: DaemonSettings;
  metrics: DaemonMetrics;
  events: DaemonEvent[];
}

export interface DisplayCatalogTemplate {
  key: string;
  name: string;
  vendor: string;
  modelCode: string;
  connection: string;
  diagonalInches: number;
  nativeWidth: number;
  nativeHeight: number;
  panelType: string;
  physicalMinNits: number;
  physicalMaxNits: number;
  transport: ControlTransport;
  scalingModes: ScalingMode[];
}
