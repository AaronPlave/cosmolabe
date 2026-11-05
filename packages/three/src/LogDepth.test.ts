import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { LOG_DEPTH_COVERAGE_PATCH, LOG_DEPTH_PATCH, patchLogDepthCoverage, patchLogDepthPrecision } from './LogDepth.js';

// The depth a fragment writes, in float32 and quantised to a 24-bit buffer, at view
// depth w (scene units) with the far plane at `far`: three's formula and the patched one.
const f = Math.fround;
const quantise = (d: number) => Math.round(d * (2 ** 24 - 1));
const fc = (far: number) => f(2 / Math.log2(far + 1));
const threeDepth = (w: number, far: number) => quantise(f(f(Math.log2(f(1 + w))) * fc(far) * 0.5));
const patchedDepth = (w: number, far: number) => quantise(f(f(Math.log2(f(1 + f(1e9 * w)))) / f(Math.log2(1e9) + 2 / fc(far))));

// three's own text, whether or not something has patched the shared chunks already.
const unpatched = () => ({
  logdepthbuf_vertex: THREE.ShaderChunk.logdepthbuf_vertex.replace(LOG_DEPTH_PATCH.vertex, 'vFragDepth = 1.0 + gl_Position.w;'),
  logdepthbuf_fragment: THREE.ShaderChunk.logdepthbuf_fragment.replace(LOG_DEPTH_PATCH.fragment, 'log2( vFragDepth ) * logDepthBufFC * 0.5'),
});

describe('patchLogDepthCoverage', () => {
  const original = () => ({
    logdepthbuf_pars_vertex: THREE.ShaderChunk.logdepthbuf_pars_vertex.replace(LOG_DEPTH_COVERAGE_PATCH, 'varying float vFragDepth;'),
    logdepthbuf_pars_fragment: THREE.ShaderChunk.logdepthbuf_pars_fragment.replace(LOG_DEPTH_COVERAGE_PATCH, 'varying float vFragDepth;'),
  });

  afterEach(() => vi.restoreAllMocks());

  it('uses matching centroid interpolation in both shader stages, idempotently', () => {
    const chunks = original();
    expect(patchLogDepthCoverage(chunks)).toBe(true);
    for (const source of Object.values(chunks)) expect(source).toContain(LOG_DEPTH_COVERAGE_PATCH);
    const once = { ...chunks };
    expect(patchLogDepthCoverage(chunks)).toBe(true);
    expect(chunks).toEqual(once);
  });

  it.each(['logdepthbuf_pars_vertex', 'logdepthbuf_pars_fragment'] as const)('completes a half-patched %s without mismatched interpolation', key => {
    const chunks = original();
    chunks[key] = chunks[key].replace('varying float vFragDepth;', LOG_DEPTH_COVERAGE_PATCH);
    expect(patchLogDepthCoverage(chunks)).toBe(true);
    for (const source of Object.values(chunks)) expect(source).toContain(LOG_DEPTH_COVERAGE_PATCH);
  });

  it.each([undefined, 'varying float renamedDepth;'])('leaves both declarations untouched if a stage is unsupported (%s)', declaration => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = { ...original(), logdepthbuf_pars_fragment: declaration };
    const before = { ...chunks };
    expect(patchLogDepthCoverage(chunks)).toBe(false);
    expect(chunks).toEqual(before);
  });

  it('preserves the physical depth formula and other interpolants', () => {
    const chunks = { ...original(), ...unpatched() };
    patchLogDepthPrecision(chunks);
    const formula = { vertex: chunks.logdepthbuf_vertex, fragment: chunks.logdepthbuf_fragment };
    patchLogDepthCoverage(chunks);
    expect(chunks.logdepthbuf_vertex).toBe(formula.vertex);
    expect(chunks.logdepthbuf_fragment).toBe(formula.fragment);
    for (const key of ['logdepthbuf_pars_vertex', 'logdepthbuf_pars_fragment'] as const) {
      expect(chunks[key].replace(LOG_DEPTH_COVERAGE_PATCH, 'varying float vFragDepth;')).toBe(original()[key]);
    }
  });
});

describe('patchLogDepthPrecision', () => {
  afterEach(() => vi.restoreAllMocks());

  it('patches three.js log depth chunks once', () => {
    const chunks = unpatched();
    expect(patchLogDepthPrecision(chunks)).toBe(true);
    expect(chunks.logdepthbuf_vertex).toContain(LOG_DEPTH_PATCH.vertex);
    expect(chunks.logdepthbuf_fragment).toContain(LOG_DEPTH_PATCH.fragment);
    // No per-fragment exp2/log2 of uniforms: only the varying's log2.
    expect(chunks.logdepthbuf_fragment).not.toContain('exp2');
    const once = { ...chunks };
    expect(patchLogDepthPrecision(chunks)).toBe(true);
    expect(chunks).toEqual(once);
  });

  it('completes a half-patched pair, so vertex and fragment always agree', () => {
    const patched = unpatched();
    patchLogDepthPrecision(patched);
    for (const half of ['logdepthbuf_vertex', 'logdepthbuf_fragment'] as const) {
      const chunks = { ...unpatched(), [half]: patched[half] };
      expect(patchLogDepthPrecision(chunks)).toBe(true);
      expect(chunks).toEqual(patched);
    }
  });

  it('leaves unknown or missing chunks alone and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const changed = { ...unpatched(), logdepthbuf_fragment: 'gl_FragDepth = somethingElse;' };
    const before = { ...changed };
    expect(patchLogDepthPrecision(changed)).toBe(false);
    expect(changed).toEqual(before);
    // An unknown fragment chunk must not leave the vertex chunk patched alone.
    expect(changed.logdepthbuf_vertex).not.toContain(LOG_DEPTH_PATCH.vertex);
    const missing: Record<string, unknown> = { logdepthbuf_vertex: unpatched().logdepthbuf_vertex };
    expect(patchLogDepthPrecision(missing)).toBe(false);
    expect(missing.logdepthbuf_vertex).not.toContain(LOG_DEPTH_PATCH.vertex);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('separates surfaces metres apart at ground level, which three alone cannot (24-bit model)', () => {
    const km = 1e-6, far = 1e6; // default scale factor; the renderer's minimum far plane
    // A surface 1 km away and a skirt 100 m behind it.
    expect(threeDepth(1 * km, far)).toBe(threeDepth(1.1 * km, far));
    expect(patchedDepth(1.1 * km, far)).toBeGreaterThan(patchedDepth(1 * km, far));
    // 1 m apart at 1 km, and 10 km apart at the Moon's distance from Earth.
    expect(patchedDepth(1.001 * km, far)).toBeGreaterThan(patchedDepth(1 * km, far));
    expect(patchedDepth(384_410 * km, far)).toBeGreaterThan(patchedDepth(384_400 * km, far));
    // Order and range are kept: the far plane maps to (just under) 1, never beyond.
    for (const fp of [1e6, 1e12]) { // the renderer keeps far ≥ 1e6
      expect(patchedDepth(fp, fp)).toBeLessThanOrEqual(2 ** 24 - 1);
      expect(patchedDepth(fp, fp)).toBeGreaterThan((2 ** 24 - 1) * 0.9999);
    }
  });
});
