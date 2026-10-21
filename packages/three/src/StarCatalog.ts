/**
 * STR2 (10 bytes/star) and legacy STAR (20 bytes/star) HYG catalog decoder.
 * Positions are unit ECLIPJ2000 directions; magnitude is apparent V-ish
 * magnitude (not calibrated RGB radiance). No synthetic replacement on errors.
 */
export interface DecodedStarCatalog {
  positions: Float32Array;
  colors: Float32Array;
  magnitudes: Float32Array;
  sourceCount: number;
  count: number;
  brightestMagnitude: number;
  faintestMagnitude: number;
  format: 'STR2' | 'STAR';
}

const MAX_STARS = 1_000_000;

/** Relative flux within a common bandpass: m+2.5 has one tenth the flux. */
export function magnitudeToRelativeFlux(magnitude: number): number {
  return Math.pow(10, -0.4 * magnitude);
}

/**
 * Sample a normalized 2-D Gaussian PSF at a physical pixel center.
 * A sigma >= 0.65 pixels makes the discrete integral essentially invariant
 * under subpixel translation (and leaves no hard minimum visible star disc).
 */
export function starPsfSample(x: number, y: number, sigma: number): number {
  return Math.exp(-(x * x + y * y) / (2 * sigma * sigma))
    / (2 * Math.PI * sigma * sigma);
}

function blackBodyRGB(bv: number): [number, number, number] {
  const c = Number.isFinite(bv) ? Math.max(-0.4, Math.min(2, bv)) : 0.65;
  const t = 4600 * (1 / (0.92 * c + 1.7) + 1 / (0.92 * c + 0.62));
  const t2 = t * t;
  const u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t2) /
            (1 + 8.42420235e-4 * t + 7.08145163e-7 * t2);
  const v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t2) /
            (1 - 2.89741816e-5 * t + 1.61456053e-7 * t2);
  const d = 2 * u - 8 * v + 4;
  const x = 3 * u / d, y = 2 * v / d;
  const X = y > 0 ? x / y : 0, Z = y > 0 ? (1 - x - y) / y : 0;
  const rgb: [number, number, number] = [
    Math.max(0, 3.2406255 * X - 1.5372080 - 0.4986286 * Z),
    Math.max(0, -0.9689307 * X + 1.8757561 + 0.0415175 * Z),
    Math.max(0, 0.0557101 * X - 0.2040211 + 1.0569959 * Z),
  ];
  const max = Math.max(...rgb);
  return max > 0 ? [rgb[0] / max, rgb[1] / max, rgb[2] / max] : [1, 1, 1];
}

export function decodeStarCatalog(buffer: ArrayBuffer, magLimit?: number): DecodedStarCatalog {
  if (buffer.byteLength < 8) throw new Error('Truncated star catalog header');
  const view = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (magic !== 'STR2' && magic !== 'STAR') throw new Error('Unknown star catalog magic');
  const compact = magic === 'STR2';
  const header = compact ? 16 : 8;
  const stride = compact ? 10 : 20;
  if (buffer.byteLength < header) throw new Error('Truncated star catalog header');
  const count = view.getUint32(4, true);
  if (count === 0 || count > MAX_STARS || buffer.byteLength !== header + count * stride) {
    throw new Error('Invalid star catalog count or byte length');
  }

  const bright = compact ? view.getFloat32(8, true) : -10;
  const faint = compact ? view.getFloat32(12, true) : 6.5;
  if (compact && (!Number.isFinite(bright) || !Number.isFinite(faint) ||
      bright < -10 || faint > 50 || faint < bright)) {
    throw new Error('Invalid STR2 magnitude bounds');
  }
  const limit = magLimit ?? (compact ? faint : 6.5);
  if (!Number.isFinite(limit)) throw new Error('Invalid star magnitude limit');

  const pos: number[] = [], rgb: number[] = [], mags: number[] = [];
  let actualBright = Infinity, actualFaint = -Infinity;
  for (let i = 0; i < count; i++) {
    const o = header + i * stride;
    const x = compact ? view.getInt16(o, true) / 0x7fff : view.getFloat32(o, true);
    const y = compact ? view.getInt16(o + 2, true) / 0x7fff : view.getFloat32(o + 4, true);
    const z = compact ? view.getInt16(o + 4, true) / 0x7fff : view.getFloat32(o + 8, true);
    const n = Math.hypot(x, y, z);
    if (!Number.isFinite(n) || n < 0.5 || n > 1.5) {
      throw new Error(`Invalid star direction at record ${i}`);
    }
    const magnitude = compact
      ? bright + (faint - bright) * view.getUint8(o + 6) / 255
      : view.getFloat32(o + 12, true);
    if (!Number.isFinite(magnitude) || magnitude < -10 || magnitude > 50) {
      throw new Error(`Invalid star magnitude at record ${i}`);
    }
    actualBright = Math.min(actualBright, magnitude);
    actualFaint = Math.max(actualFaint, magnitude);
    if (magnitude > limit) continue;

    pos.push(x / n, y / n, z / n);
    if (compact) {
      const r = view.getUint8(o + 7) / 255, g = view.getUint8(o + 8) / 255;
      const b = view.getUint8(o + 9) / 255;
      if (r + g + b === 0) throw new Error(`Invalid star color at record ${i}`);
      rgb.push(r, g, b);
    } else {
      rgb.push(...blackBodyRGB(view.getFloat32(o + 16, true)));
    }
    mags.push(magnitude);
  }
  if (compact && (actualBright < bright - 0.02 || actualFaint > faint + 0.02)) {
    throw new Error('STR2 magnitudes inconsistent with header');
  }
  return {
    positions: Float32Array.from(pos), colors: Float32Array.from(rgb),
    magnitudes: Float32Array.from(mags), sourceCount: count, count: mags.length,
    brightestMagnitude: compact ? bright : actualBright,
    faintestMagnitude: compact ? faint : actualFaint,
    format: magic,
  };
}
