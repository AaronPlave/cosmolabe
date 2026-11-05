import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { StarField } from '../StarField.js';
import { decodeStarCatalog, magnitudeToRelativeFlux, starPsfSample } from '../StarCatalog.js';

function str2(magnitudes: number[], positions?: number[][]): ArrayBuffer {
  const buffer = new ArrayBuffer(16 + magnitudes.length * 10);
  const view = new DataView(buffer);
  for (let j = 0; j < 4; j++) view.setUint8(j, 'STR2'.charCodeAt(j));
  view.setUint32(4, magnitudes.length, true);
  const bright = Math.min(...magnitudes), faint = Math.max(...magnitudes);
  view.setFloat32(8, bright, true);
  view.setFloat32(12, faint, true);
  for (let i = 0; i < magnitudes.length; i++) {
    const p = positions?.[i] ?? [1, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      view.setInt16(16 + 10 * i + 2 * axis, Math.round(p[axis] * 0x7fff), true);
    }
    view.setUint8(16 + 10 * i + 6, faint === bright ? 0 :
      Math.round(255 * (magnitudes[i] - bright) / (faint - bright)));
    view.setUint8(16 + 10 * i + 7, 255);
    view.setUint8(16 + 10 * i + 8, 230);
    view.setUint8(16 + 10 * i + 9, 208);
  }
  return buffer;
}

function legacy(mag: number): ArrayBuffer {
  const buffer = new ArrayBuffer(28);
  const view = new DataView(buffer);
  for (let j = 0; j < 4; j++) view.setUint8(j, 'STAR'.charCodeAt(j));
  view.setUint32(4, 1, true);
  view.setFloat32(8, 0, true);
  view.setFloat32(12, 1, true);
  view.setFloat32(16, 0, true);
  view.setFloat32(20, mag, true);
  view.setFloat32(24, 0.65, true);
  return buffer;
}

/** Weighted by the area of physical pixels in CSS-pixel units. */
function integratedFlux(mag: number, dpr: number, x: number, y: number): number {
  const sigma = 0.875 * dpr;
  let sum = 0;
  for (let j = -18 * dpr; j <= 18 * dpr; j++) {
    for (let i = -18 * dpr; i <= 18 * dpr; i++) {
      sum += magnitudeToRelativeFlux(mag) * dpr * dpr *
        starPsfSample(i + 0.5 - x * dpr, j + 0.5 - y * dpr, sigma) / (dpr * dpr);
    }
  }
  return sum;
}

describe('star point-source relative flux', () => {
  it('makes a +2.5 magnitude difference exactly 10:1 before tone mapping', () => {
    expect(magnitudeToRelativeFlux(0) / magnitudeToRelativeFlux(2.5)).toBeCloseTo(10, 8);
    expect(integratedFlux(0, 1, 0.25, 0.65) /
           integratedFlux(2.5, 1, 0.25, 0.65)).toBeCloseTo(10, 4);
  });

  it('keeps integrated CSS-pixel flux stable across subpixel shifts and DPR', () => {
    const baseline = integratedFlux(0, 1, 0, 0);
    for (const dpr of [1, 2]) {
      for (const phase of [0, 0.15, 0.49, 0.8]) {
        const flux = integratedFlux(0, dpr, phase, 0.71);
        expect(Math.abs(flux / baseline - 1)).toBeLessThan(0.01);
      }
    }
  });
});

describe('HYG binary decoding', () => {
  it('loads the shipped HYG catalog and matches Sirius in ECLIPJ2000', () => {
    const bytes = readFileSync(new URL('../data/stars.bin', import.meta.url));
    const data = decodeStarCatalog(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(data.count).toBe(data.sourceCount);
    // Independent J2000 reference: Sirius, RA 06h45m08.9173s,
    // Dec -16d42m58.017s, apparent V magnitude -1.46. HYG's packed
    // magnitude is -1.44; allow catalog/photometry and int16 rounding.
    const ra = (6 + 45 / 60 + 8.9173 / 3600) * Math.PI / 12;
    const dec = -(16 + 42 / 60 + 58.017 / 3600) * Math.PI / 180;
    const obliquity = 23.4392911 * Math.PI / 180;
    const expected = new THREE.Vector3(
      Math.cos(dec) * Math.cos(ra),
      Math.cos(dec) * Math.sin(ra) * Math.cos(obliquity) + Math.sin(dec) * Math.sin(obliquity),
      -Math.cos(dec) * Math.sin(ra) * Math.sin(obliquity) + Math.sin(dec) * Math.cos(obliquity),
    );
    const brightest = data.magnitudes.indexOf(Math.min(...data.magnitudes));
    const direction = new THREE.Vector3().fromArray(data.positions, brightest * 3);
    expect(direction.angleTo(expected) * 180 / Math.PI).toBeLessThan(0.005);
    expect(Math.abs(data.magnitudes[brightest] - (-1.46))).toBeLessThan(0.04);
  });

  it('decodes and filters STR2 using actual magnitudes and ECLIPJ2000 directions', () => {
    const data = decodeStarCatalog(str2([-1.46, 1.04, 6.5], [
      [1, 0, 0], [0, 1, 0], [0, 0, 1],
    ]), 1.1);
    expect(data.format).toBe('STR2');
    expect(data.count).toBe(2);
    expect(data.sourceCount).toBe(3);
    expect(data.magnitudes[0]).toBeCloseTo(-1.46, 2);
    expect(data.magnitudes[1]).toBeCloseTo(1.04, 1);
    expect(Array.from(data.positions)).toEqual([1, 0, 0, 0, 1, 0]);
  });

  it('keeps legacy STAR catalog controls', () => {
    const data = decodeStarCatalog(legacy(1.2));
    expect(data.format).toBe('STAR');
    expect(data.count).toBe(1);
    expect(data.magnitudes[0]).toBeCloseTo(1.2, 4);
    expect(data.colors.every(Number.isFinite)).toBe(true);
  });

  it('accepts unit directions rounded to int16 or float32', () => {
    const component = 1 / Math.sqrt(3);
    const compact = decodeStarCatalog(str2([1], [[component, component, component]]));
    const buffer = legacy(1);
    const view = new DataView(buffer);
    for (const offset of [8, 12, 16]) view.setFloat32(offset, component, true);
    const old = decodeStarCatalog(buffer);
    for (const data of [compact, old]) {
      expect(Math.hypot(...data.positions)).toBeCloseTo(1, 6);
    }
  });

  it.each([0.75, 1.25, 0.9999, 1.0001])('rejects nonunit nonzero directions of length %s in both formats', length => {
    const compact = str2([1], [[length * 0.6, length * 0.8, 0]]);
    const old = legacy(1);
    new DataView(old).setFloat32(12, length, true);
    // Filtering the record out must not hide its corruption either.
    for (const buffer of [compact, old]) {
      expect(() => decodeStarCatalog(buffer)).toThrow(/direction/);
      expect(() => decodeStarCatalog(buffer, 0)).toThrow(/direction/);
    }
  });

  it('rejects truncation, bogus lengths, headers and invalid directions', () => {
    const good = str2([1, 3]);
    expect(() => decodeStarCatalog(new ArrayBuffer(3))).toThrow();
    expect(() => decodeStarCatalog(good.slice(0, -1))).toThrow(/count or byte length/);
    const badCount = good.slice(0);
    new DataView(badCount).setUint32(4, 500_000, true);
    expect(() => decodeStarCatalog(badCount)).toThrow();
    const badMagnitude = good.slice(0);
    new DataView(badMagnitude).setFloat32(8, NaN, true);
    expect(() => decodeStarCatalog(badMagnitude)).toThrow(/magnitude bounds/);
    const badDirection = good.slice(0);
    new DataView(badDirection).setInt16(16, 0, true);
    expect(() => decodeStarCatalog(badDirection)).toThrow(/direction/);
    const badMagic = good.slice(0);
    new DataView(badMagic).setUint8(0, 0);
    expect(() => decodeStarCatalog(badMagic)).toThrow(/magic/);
  });
});

describe('StarField lifecycle and output convention', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never adds random stars when the URL is absent or 404', async () => {
    const field = new StarField();
    expect(field.children).toHaveLength(0);
    expect(field.getCatalogStatus().state).toBe('unconfigured');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await field.loadCatalog('/missing-stars.bin');
      expect(field.children).toHaveLength(0);
      expect(field.getCatalogStatus()).toMatchObject({ state: 'error', url: '/missing-stars.bin' });
    } finally {
      warn.mockRestore();
      field.dispose();
    }
  });

  it('loads a real catalog, retains linear flux hook, and disposes safely', async () => {
    const fixture = str2([-1.46, 1.04]);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, arrayBuffer: async () => fixture,
    })));
    const field = new StarField();
    await field.loadCatalog('/stars.bin');
    expect(field.getCatalogStatus()).toMatchObject({ state: 'ready', count: 2, format: 'STR2' });
    expect(field.children).toHaveLength(1);
    const points = field.children[0] as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(points.geometry.getAttribute('aMagnitude').getX(0)).toBeCloseTo(-1.46, 2);
    expect(points.material.vertexShader).toContain('pow(10.0, -0.4 * aMagnitude)');
    expect(points.material.fragmentShader).toContain('#include <colorspace_fragment>');
    field.setLinearFluxScale(0.1);
    field.setSkyBrightness(0.5);
    expect(points.material.uniforms.uLinearFluxScale.value).toBe(0.1);
    expect(points.material.uniforms.uSkyBrightness.value).toBe(0.5);
    field.dispose();
    expect(field.children).toHaveLength(0);
  });

  it('retains the constructor magnitude limit on reload with request-local overrides', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, arrayBuffer: async () => str2([1, 3, 6]),
    })));
    const field = new StarField({ catalogUrl: '/initial.bin', magLimit: 2 });
    try {
      await vi.waitFor(() => expect(field.getCatalogStatus()).toMatchObject({ state: 'ready', count: 1 }));
      await field.loadCatalog('/reload.bin');
      expect(field.getCatalogStatus()).toMatchObject({ state: 'ready', count: 1 });
      await field.loadCatalog('/override.bin', { magLimit: 4 });
      expect(field.getCatalogStatus()).toMatchObject({ state: 'ready', count: 2 });
      await field.loadCatalog('/reload-again.bin');
      expect(field.getCatalogStatus()).toMatchObject({ state: 'ready', count: 1 });
    } finally {
      field.dispose();
    }
  });

  it('does not resurrect stars after disposal while a request is pending', async () => {
    let resolveResponse!: (response: { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveResponse = resolve; })));
    const field = new StarField();
    const load = field.loadCatalog('/pending.bin');
    field.dispose();
    resolveResponse({ ok: true, arrayBuffer: async () => str2([1]) });
    await load;
    expect(field.children).toHaveLength(0);
  });
});
