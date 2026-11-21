import type {
  BrightnessMappingConfig,
  ComputedBrightnessOutput,
  CurvePoint,
  DisplayCatalogTemplate,
  DisplayConfig,
  ScalingMode,
} from './types.ts';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Computes an authentic DDC/CI VCP Set Feature (0x03) I2C packet with XOR checksum.
 * Destination 0x6E (7-bit 0x37), Source 0x51, Length 0x84 (4 bytes), Command 0x03 (Set VCP),
 * VCP Opcode (0x10 = Luminance, 0x12 = Contrast), High Byte, Low Byte, XOR Checksum.
 */
export function buildDdcVcpPacketHex(vcpCode: number, value: number): string {
  const destAddr = 0x6e;
  const srcAddr = 0x51;
  const length = 0x84;
  const cmdSetVcp = 0x03;
  const clamped = Math.round(clamp(value, 0, 100));
  const hi = (clamped >> 8) & 0xff;
  const lo = clamped & 0xff;

  const checksum = destAddr ^ srcAddr ^ length ^ cmdSetVcp ^ vcpCode ^ hi ^ lo;
  const bytes = [srcAddr, length, cmdSetVcp, vcpCode, hi, lo, checksum];
  return bytes.map((b) => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/**
 * Converts physical luminance ratio (Y = L / L_max) to CIE 1976 L* perceptual lightness (0..100).
 */
export function luminanceToLStar(nits: number, maxNits: number): number {
  const y = clamp(nits / Math.max(maxNits, 1), 0, 1);
  if (y <= 0.008856) {
    return Number((y * 903.3).toFixed(1));
  }
  return Number((116 * Math.cbrt(y) - 16).toFixed(1));
}

/**
 * Inverse CIE L*: converts desired perceptual lightness (0..100) to linear relative luminance (0..1).
 */
export function lStarToLinearRatio(lStar: number): number {
  const l = clamp(lStar, 0, 100);
  if (l <= 8) {
    return l / 903.3;
  }
  const f = (l + 16) / 116;
  return f * f * f;
}

/**
 * Evaluates a piecewise smooth spline over sorted CurvePoints (x in 0..100, y in 0..100).
 */
export function evaluateCustomSpline(points: CurvePoint[], xInput: number): number {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  if (sorted.length === 0) return xInput;
  if (xInput <= sorted[0].x) return sorted[0].y;
  if (xInput >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

  for (let i = 0; i < sorted.length - 1; i++) {
    const p0 = sorted[i];
    const p1 = sorted[i + 1];
    if (xInput >= p0.x && xInput <= p1.x) {
      const span = Math.max(p1.x - p0.x, 0.001);
      const t = (xInput - p0.x) / span;
      // Hermite smoothstep interpolation for smooth perceptual transitions
      const smoothT = t * t * (3 - 2 * t);
      return clamp(p0.y + (p1.y - p0.y) * smoothT, 0, 100);
    }
  }
  return xInput;
}

/**
 * Computes the effective hardware DDC value (VCP 0x10), software gamma table multiplier,
 * contrast adjustment, estimated physical nits, and wire-level DDC/CI packet for a display.
 */
export function computeBrightnessOutput(
  display: DisplayConfig,
  inputPercentOverride?: number,
  referenceDisplayNits?: number,
): ComputedBrightnessOutput {
  const rawInput = clamp(inputPercentOverride ?? display.brightness, 0, 100);
  const mapping: BrightnessMappingConfig = display.mapping;

  // Built-in Apple display uses CoreDisplay native perceptual curve directly
  if (display.isBuiltIn || display.transport === 'native-apple') {
    const linearRatio = lStarToLinearRatio(rawInput);
    const nits = display.physicalMinNits + linearRatio * (display.physicalMaxNits - display.physicalMinNits);
    const ddcEquivalent = Math.round(rawInput);
    return {
      inputPercent: Number(rawInput.toFixed(1)),
      hardwareDdc: ddcEquivalent,
      softwareGamma: 1,
      contrastDdc: display.contrast,
      estimatedNits: Number(nits.toFixed(1)),
      perceptualLStar: luminanceToLStar(nits, display.physicalMaxNits),
      inSoftwareZone: false,
      vcpPacketHex: 'CoreDisplay · DisplayServicesSetBrightness(' + (rawInput / 100).toFixed(3) + ')',
    };
  }

  // Optional Reference Match: solve for target physical nits equal to built-in MacBook display
  if (mapping.matchReferenceNits && typeof referenceDisplayNits === 'number') {
    const targetNits = clamp(referenceDisplayNits, 1, display.physicalMaxNits);
    const hwMin = clamp(mapping.hardwareMinClamp, 0, 100);
    const hwMax = clamp(mapping.hardwareMaxClamp, hwMin, 100);
    const nitsAtHwMin =
      display.physicalMinNits + (hwMin / 100) * (display.physicalMaxNits - display.physicalMinNits);
    const nitsAtHwMax =
      display.physicalMinNits + (hwMax / 100) * (display.physicalMaxNits - display.physicalMinNits);

    if (targetNits < nitsAtHwMin && display.transport !== 'ddc-ci') {
      const gammaNeeded = clamp(targetNits / Math.max(nitsAtHwMin, 1), mapping.softwareMinFactor, 1);
      const actualNits = nitsAtHwMin * gammaNeeded;
      const contrastVal = mapping.linkContrastBelowKnee
        ? Math.round(mapping.contrastMinClamp + gammaNeeded * (display.contrast - mapping.contrastMinClamp))
        : display.contrast;
      return {
        inputPercent: Number(rawInput.toFixed(1)),
        hardwareDdc: Math.round(hwMin),
        softwareGamma: Number(gammaNeeded.toFixed(3)),
        contrastDdc: contrastVal,
        estimatedNits: Number(actualNits.toFixed(1)),
        perceptualLStar: luminanceToLStar(actualNits, display.physicalMaxNits),
        inSoftwareZone: true,
        vcpPacketHex: buildDdcVcpPacketHex(0x10, hwMin),
      };
    }

    const ratio = clamp((targetNits - nitsAtHwMin) / Math.max(nitsAtHwMax - nitsAtHwMin, 1), 0, 1);
    const ddc = Math.round(hwMin + ratio * (hwMax - hwMin));
    const actualNits =
      display.physicalMinNits + (ddc / 100) * (display.physicalMaxNits - display.physicalMinNits);
    return {
      inputPercent: Number(rawInput.toFixed(1)),
      hardwareDdc: ddc,
      softwareGamma: 1,
      contrastDdc: display.contrast,
      estimatedNits: Number(actualNits.toFixed(1)),
      perceptualLStar: luminanceToLStar(actualNits, display.physicalMaxNits),
      inSoftwareZone: false,
      vcpPacketHex: buildDdcVcpPacketHex(0x10, ddc),
    };
  }

  // Software-Gamma-Only mode (for HDMI adapters or DisplayLink hubs that block DDC/CI)
  if (display.transport === 'software-gamma') {
    const normalized = rawInput / 100;
    const curved =
      mapping.mode === 'perceptual'
        ? lStarToLinearRatio(rawInput)
        : mapping.mode === 'custom-spline'
          ? evaluateCustomSpline(mapping.customPoints, rawInput) / 100
          : Math.pow(normalized, mapping.gammaExponent);
    const gamma = clamp(mapping.softwareMinFactor + curved * (1 - mapping.softwareMinFactor), mapping.softwareMinFactor, 1);
    // Assume monitor panel sits at fixed ~75% hardware brightness when DDC unavailable
    const fixedPanelNits = display.physicalMinNits + 0.75 * (display.physicalMaxNits - display.physicalMinNits);
    const estNits = fixedPanelNits * gamma;
    return {
      inputPercent: Number(rawInput.toFixed(1)),
      hardwareDdc: 75,
      softwareGamma: Number(gamma.toFixed(3)),
      contrastDdc: display.contrast,
      estimatedNits: Number(estNits.toFixed(1)),
      perceptualLStar: luminanceToLStar(estNits, display.physicalMaxNits),
      inSoftwareZone: gamma < 0.999,
      vcpPacketHex: 'CGSetDisplayTransferByTable(gamma=' + gamma.toFixed(3) + ')',
    };
  }

  // Hardware DDC or Combined (DDC + Sub-Zero Software Gamma)
  const allowSoftDim = display.transport === 'combined';
  const knee = allowSoftDim ? clamp(mapping.softwareKnee, 0, 60) : 0;
  const hwMin = clamp(mapping.hardwareMinClamp, 0, 95);
  const hwMax = clamp(mapping.hardwareMaxClamp, hwMin + 5, 100);

  let hardwareDdc = hwMin;
  let softwareGamma = 1.0;
  let inSoftwareZone = false;

  if (allowSoftDim && knee > 0 && rawInput < knee) {
    inSoftwareZone = true;
    hardwareDdc = Math.round(hwMin);
    const subRatio = clamp(rawInput / knee, 0, 1);
    const shaped = mapping.mode === 'perceptual' ? Math.pow(subRatio, 1.35) : Math.pow(subRatio, Math.min(mapping.gammaExponent, 2.0));
    softwareGamma = clamp(
      mapping.softwareMinFactor + shaped * (1 - mapping.softwareMinFactor),
      mapping.softwareMinFactor,
      1,
    );
  } else {
    const effectiveRange = Math.max(100 - knee, 1);
    const normalizedAboveKnee = clamp((rawInput - knee) / effectiveRange, 0, 1);

    let mappedUnit = normalizedAboveKnee;
    if (mapping.mode === 'perceptual') {
      // CIE L* inverse curve maps human uniform steps to physical linear backlight power
      mappedUnit = lStarToLinearRatio(normalizedAboveKnee * 100);
    } else if (mapping.mode === 'gamma' || mapping.mode === 'dual-stage') {
      mappedUnit = Math.pow(normalizedAboveKnee, mapping.gammaExponent);
    } else if (mapping.mode === 'custom-spline') {
      mappedUnit = evaluateCustomSpline(mapping.customPoints, rawInput) / 100;
    }

    hardwareDdc = Math.round(hwMin + mappedUnit * (hwMax - hwMin));
    softwareGamma = 1.0;
  }

  const contrastDdc =
    inSoftwareZone && mapping.linkContrastBelowKnee
      ? Math.round(mapping.contrastMinClamp + softwareGamma * (display.contrast - mapping.contrastMinClamp))
      : display.contrast;

  const panelBaseNits =
    display.physicalMinNits + (hardwareDdc / 100) * (display.physicalMaxNits - display.physicalMinNits);
  const estimatedNits = panelBaseNits * softwareGamma;

  return {
    inputPercent: Number(rawInput.toFixed(1)),
    hardwareDdc,
    softwareGamma: Number(softwareGamma.toFixed(3)),
    contrastDdc,
    estimatedNits: Number(estimatedNits.toFixed(1)),
    perceptualLStar: luminanceToLStar(estimatedNits, display.physicalMaxNits),
    inSoftwareZone,
    vcpPacketHex: buildDdcVcpPacketHex(0x10, hardwareDdc),
  };
}

export interface ScalingMetrics {
  activeMode: ScalingMode;
  nativePpi: number;
  effectiveLogicalPpi: number;
  scaleFactor: number;
  gpuOversampleRatio: number;
  isIntegerScale: boolean;
  bandwidthGbps: number;
}

export function computeScalingMetrics(display: DisplayConfig): ScalingMetrics {
  const activeMode =
    display.scalingModes.find((m) => m.id === display.activeScalingId) ?? display.scalingModes[0];
  const diagPixels = Math.hypot(display.nativeWidth, display.nativeHeight);
  const nativePpi = Math.round(diagPixels / Math.max(display.diagonalInches, 1));
  const logicalDiag = Math.hypot(activeMode.logicalWidth, activeMode.logicalHeight);
  const effectiveLogicalPpi = Math.round(logicalDiag / Math.max(display.diagonalInches, 1));
  const scaleFactor = Number((display.nativeWidth / Math.max(activeMode.logicalWidth, 1)).toFixed(2));
  const gpuOversampleRatio = Number(
    ((activeMode.backingWidth * activeMode.backingHeight) / Math.max(display.nativeWidth * display.nativeHeight, 1)).toFixed(2),
  );
  const isIntegerScale =
    activeMode.backingWidth === display.nativeWidth && activeMode.backingHeight === display.nativeHeight;

  const bitsPerPixel = display.pixelFormat === 'RGB 10-bit' ? 30 : display.pixelFormat === 'RGB 8-bit' ? 24 : 20;
  // Approximate DisplayPort/HDMI link bandwidth including ~8% blanking overhead
  const bandwidthGbps = Number(
    ((display.nativeWidth * display.nativeHeight * display.refreshRate * bitsPerPixel * 1.08) / 1e9).toFixed(1),
  );

  return {
    activeMode,
    nativePpi,
    effectiveLogicalPpi,
    scaleFactor,
    gpuOversampleRatio,
    isIntegerScale,
    bandwidthGbps,
  };
}

export function create4KScalingModes(refreshRates: number[] = [60]): ScalingMode[] {
  return [
    {
      id: '1920x1080-hidpi',
      label: '1920 × 1080 (HiDPI · Larger Text)',
      logicalWidth: 1920,
      logicalHeight: 1080,
      backingWidth: 3840,
      backingHeight: 2160,
      hidpi: true,
      refreshRates,
    },
    {
      id: '2560x1440-hidpi',
      label: '2560 × 1440 (HiDPI · Default Scaled)',
      logicalWidth: 2560,
      logicalHeight: 1440,
      backingWidth: 5120,
      backingHeight: 2880,
      hidpi: true,
      refreshRates,
      recommended: true,
    },
    {
      id: '3008x1692-hidpi',
      label: '3008 × 1692 (HiDPI · More Space)',
      logicalWidth: 3008,
      logicalHeight: 1692,
      backingWidth: 6016,
      backingHeight: 3384,
      hidpi: true,
      refreshRates,
    },
    {
      id: '3360x1890-hidpi',
      label: '3360 × 1890 (HiDPI · High Density)',
      logicalWidth: 3360,
      logicalHeight: 1890,
      backingWidth: 6720,
      backingHeight: 3780,
      hidpi: true,
      refreshRates,
    },
    {
      id: '3840x2160-1x',
      label: '3840 × 2160 (1× Native Unscaled)',
      logicalWidth: 3840,
      logicalHeight: 2160,
      backingWidth: 3840,
      backingHeight: 2160,
      hidpi: false,
      refreshRates,
    },
  ];
}

export function create5KScalingModes(): ScalingMode[] {
  return [
    {
      id: '2048x1152-hidpi',
      label: '2048 × 1152 (HiDPI · Larger Text)',
      logicalWidth: 2048,
      logicalHeight: 1152,
      backingWidth: 4096,
      backingHeight: 2304,
      hidpi: true,
      refreshRates: [60],
    },
    {
      id: '2560x1440-hidpi-2x',
      label: '2560 × 1440 (2× Exact Retina)',
      logicalWidth: 2560,
      logicalHeight: 1440,
      backingWidth: 5120,
      backingHeight: 2880,
      hidpi: true,
      refreshRates: [60],
      recommended: true,
    },
    {
      id: '2880x1620-hidpi',
      label: '2880 × 1620 (HiDPI · More Space)',
      logicalWidth: 2880,
      logicalHeight: 1620,
      backingWidth: 5760,
      backingHeight: 3240,
      hidpi: true,
      refreshRates: [60],
    },
    {
      id: '3200x1800-hidpi',
      label: '3200 × 1800 (HiDPI · Maximum Space)',
      logicalWidth: 3200,
      logicalHeight: 1800,
      backingWidth: 6400,
      backingHeight: 3600,
      hidpi: true,
      refreshRates: [60],
    },
  ];
}

export function createUWQHDScalingModes(refreshRates: number[] = [60, 120, 175]): ScalingMode[] {
  return [
    {
      id: '1720x720-hidpi',
      label: '1720 × 720 (2× Exact HiDPI)',
      logicalWidth: 1720,
      logicalHeight: 720,
      backingWidth: 3440,
      backingHeight: 1440,
      hidpi: true,
      refreshRates,
    },
    {
      id: '2580x1080-hidpi',
      label: '2580 × 1080 (HiDPI · Balanced)',
      logicalWidth: 2580,
      logicalHeight: 1080,
      backingWidth: 5160,
      backingHeight: 2160,
      hidpi: true,
      refreshRates,
      recommended: true,
    },
    {
      id: '3440x1440-1x',
      label: '3440 × 1440 (1× Native UWQHD)',
      logicalWidth: 3440,
      logicalHeight: 1440,
      backingWidth: 3440,
      backingHeight: 1440,
      hidpi: false,
      refreshRates,
    },
  ];
}

export function create1080pScalingModes(refreshRates: number[] = [60]): ScalingMode[] {
  return [
    {
      id: '1920x1080-native',
      label: '1920 × 1080 (1× Native 1080p)',
      logicalWidth: 1920,
      logicalHeight: 1080,
      backingWidth: 1920,
      backingHeight: 1080,
      hidpi: false,
      refreshRates,
      recommended: true,
    },
    {
      id: '1600x900-scaled',
      label: '1600 × 900 (Scaled 16:9)',
      logicalWidth: 1600,
      logicalHeight: 900,
      backingWidth: 1600,
      backingHeight: 900,
      hidpi: false,
      refreshRates,
    },
    {
      id: '1280x720-hidpi',
      label: '1280 × 720 (HiDPI · Crisp Text)',
      logicalWidth: 1280,
      logicalHeight: 720,
      backingWidth: 2560,
      backingHeight: 1440,
      hidpi: true,
      refreshRates,
    },
  ];
}

export function createAirRetinaScalingModes(refreshRates: number[] = [60]): ScalingMode[] {
  return [
    {
      id: '1470x956-hidpi',
      label: '1470 × 956 (Default Retina)',
      logicalWidth: 1470,
      logicalHeight: 956,
      backingWidth: 2940,
      backingHeight: 1912,
      hidpi: true,
      refreshRates,
      recommended: true,
    },
    {
      id: '1710x1112-hidpi',
      label: '1710 × 1112 (HiDPI · More Space)',
      logicalWidth: 1710,
      logicalHeight: 1112,
      backingWidth: 3420,
      backingHeight: 2224,
      hidpi: true,
      refreshRates,
    },
    {
      id: '1280x832-hidpi',
      label: '1280 × 832 (HiDPI · Larger Text)',
      logicalWidth: 1280,
      logicalHeight: 832,
      backingWidth: 2560,
      backingHeight: 1664,
      hidpi: true,
      refreshRates,
    },
    {
      id: '2560x1664-native',
      label: '2560 × 1664 (1× Native Pixel Grid)',
      logicalWidth: 2560,
      logicalHeight: 1664,
      backingWidth: 2560,
      backingHeight: 1664,
      hidpi: false,
      refreshRates,
    },
  ];
}

export const DISPLAY_CATALOG: DisplayCatalogTemplate[] = [
  {
    key: 'dell-p2417h',
    name: 'Dell P2417H (1080p IPS)',
    vendor: 'Dell',
    modelCode: 'DEL-A0DC',
    connection: 'DisplayPort / HDMI',
    diagonalInches: 23.8,
    nativeWidth: 1920,
    nativeHeight: 1080,
    panelType: 'IPS Full HD',
    physicalMinNits: 35,
    physicalMaxNits: 250,
    transport: 'combined',
    scalingModes: create1080pScalingModes([60]),
  },
  {
    key: 'dell-u2723qe',
    name: 'Dell UltraSharp U2723QE',
    vendor: 'Dell',
    modelCode: 'DEL-426D',
    connection: 'USB-C DP Alt (90W PD)',
    diagonalInches: 27,
    nativeWidth: 3840,
    nativeHeight: 2160,
    panelType: 'IPS Black (2000:1)',
    physicalMinNits: 42,
    physicalMaxNits: 400,
    transport: 'combined',
    scalingModes: create4KScalingModes([60]),
  },
  {
    key: 'lg-32un880',
    name: 'LG UltraFine Ergo 32UN880',
    vendor: 'LG Electronics',
    modelCode: 'GSM-772A',
    connection: 'Thunderbolt 4 → DP 1.4',
    diagonalInches: 31.5,
    nativeWidth: 3840,
    nativeHeight: 2160,
    panelType: 'IPS 95% DCI-P3',
    physicalMinNits: 54,
    physicalMaxNits: 350,
    transport: 'combined',
    scalingModes: create4KScalingModes([60]),
  },
  {
    key: 'benq-pd3220u',
    name: 'BenQ DesignVue PD3220U',
    vendor: 'BenQ',
    modelCode: 'BNQ-7956',
    connection: 'Thunderbolt 3 Daisy-Chain',
    diagonalInches: 31.5,
    nativeWidth: 3840,
    nativeHeight: 2160,
    panelType: 'IPS AQCOLOR',
    physicalMinNits: 38,
    physicalMaxNits: 300,
    transport: 'combined',
    scalingModes: create4KScalingModes([60]),
  },
  {
    key: 'asus-pa279cv',
    name: 'ASUS ProArt PA279CV',
    vendor: 'ASUS',
    modelCode: 'AUS-27C9',
    connection: 'USB-C DP 1.2',
    diagonalInches: 27,
    nativeWidth: 3840,
    nativeHeight: 2160,
    panelType: 'IPS Calman Verified',
    physicalMinNits: 48,
    physicalMaxNits: 350,
    transport: 'ddc-ci',
    scalingModes: create4KScalingModes([60]),
  },
  {
    key: 'samsung-odyssey-g8',
    name: 'Samsung Odyssey OLED G8',
    vendor: 'Samsung',
    modelCode: 'SAM-7291',
    connection: 'Mini DP 1.4',
    diagonalInches: 34,
    nativeWidth: 3440,
    nativeHeight: 1440,
    panelType: 'QD-OLED',
    physicalMinNits: 14,
    physicalMaxNits: 250,
    transport: 'combined',
    scalingModes: createUWQHDScalingModes([60, 120, 175]),
  },
  {
    key: 'apple-studio-5k',
    name: 'Apple Studio Display 27"',
    vendor: 'Apple',
    modelCode: 'APP-AE36',
    connection: 'Thunderbolt 4',
    diagonalInches: 27,
    nativeWidth: 5120,
    nativeHeight: 2880,
    panelType: '5K Retina P3',
    physicalMinNits: 4,
    physicalMaxNits: 600,
    transport: 'native-apple',
    scalingModes: create5KScalingModes(),
  },
];

export function createDefaultDisplays(): DisplayConfig[] {
  return [
    {
      id: 'disp-builtin-color-lcd',
      name: 'Built-in Liquid Retina',
      vendor: 'Apple',
      modelCode: 'APP-M4-AIR',
      edidSerial: 'BUILTIN-0001',
      connection: 'Internal (eDP)',
      isBuiltIn: true,
      diagonalInches: 13.6,
      nativeWidth: 2560,
      nativeHeight: 1664,
      panelType: 'Liquid Retina Display',
      physicalMinNits: 2,
      physicalMaxNits: 500,
      transport: 'native-apple',
      linkedToMaster: true,
      brightness: 64,
      contrast: 100,
      activeScalingId: '1470x956-hidpi',
      refreshRate: 60,
      pixelFormat: 'RGB 10-bit',
      rotation: 0,
      overscanPercent: 0,
      positionIndex: 0,
      scalingModes: createAirRetinaScalingModes([60]),
      mapping: {
        mode: 'perceptual',
        gammaExponent: 1.8,
        softwareKnee: 0,
        softwareMinFactor: 1.0,
        hardwareMinClamp: 0,
        hardwareMaxClamp: 100,
        linkContrastBelowKnee: false,
        contrastMinClamp: 70,
        matchReferenceNits: false,
        customPoints: [
          { x: 0, y: 0 },
          { x: 25, y: 14 },
          { x: 50, y: 38 },
          { x: 75, y: 68 },
          { x: 100, y: 100 },
        ],
      },
    },
    {
      id: 'disp-dell-p2417h-1',
      name: 'Dell P2417H (1)',
      vendor: 'Dell Inc.',
      modelCode: 'DEL-A0DC',
      edidSerial: 'EXT-DISP-0001',
      connection: 'DisplayPort / HDMI (DDC)',
      isBuiltIn: false,
      diagonalInches: 23.8,
      nativeWidth: 1920,
      nativeHeight: 1080,
      panelType: 'IPS Full HD (1000:1)',
      physicalMinNits: 35,
      physicalMaxNits: 250,
      transport: 'combined',
      linkedToMaster: true,
      brightness: 64,
      contrast: 75,
      activeScalingId: '1920x1080-native',
      refreshRate: 60,
      pixelFormat: 'RGB 8-bit',
      rotation: 0,
      overscanPercent: 0,
      positionIndex: 1,
      scalingModes: create1080pScalingModes([60]),
      mapping: {
        mode: 'dual-stage',
        gammaExponent: 1.65,
        softwareKnee: 24,
        softwareMinFactor: 0.18,
        hardwareMinClamp: 0,
        hardwareMaxClamp: 100,
        linkContrastBelowKnee: true,
        contrastMinClamp: 50,
        matchReferenceNits: true,
        customPoints: [
          { x: 0, y: 0 },
          { x: 25, y: 14 },
          { x: 50, y: 38 },
          { x: 75, y: 68 },
          { x: 100, y: 100 },
        ],
      },
    },
    {
      id: 'disp-dell-p2417h-2',
      name: 'Dell P2417H (2)',
      vendor: 'Dell Inc.',
      modelCode: 'DEL-A0DB',
      edidSerial: 'EXT-DISP-0002',
      connection: 'DisplayPort / HDMI (DDC)',
      isBuiltIn: false,
      diagonalInches: 23.8,
      nativeWidth: 1920,
      nativeHeight: 1080,
      panelType: 'IPS Full HD (1000:1)',
      physicalMinNits: 35,
      physicalMaxNits: 250,
      transport: 'combined',
      linkedToMaster: true,
      brightness: 64,
      contrast: 75,
      activeScalingId: '1920x1080-native',
      refreshRate: 60,
      pixelFormat: 'RGB 8-bit',
      rotation: 0,
      overscanPercent: 0,
      positionIndex: 2,
      scalingModes: create1080pScalingModes([60]),
      mapping: {
        mode: 'dual-stage',
        gammaExponent: 1.65,
        softwareKnee: 24,
        softwareMinFactor: 0.18,
        hardwareMinClamp: 0,
        hardwareMaxClamp: 100,
        linkContrastBelowKnee: true,
        contrastMinClamp: 50,
        matchReferenceNits: true,
        customPoints: [
          { x: 0, y: 0 },
          { x: 25, y: 14 },
          { x: 50, y: 38 },
          { x: 75, y: 68 },
          { x: 100, y: 100 },
        ],
      },
    },
  ];
}
