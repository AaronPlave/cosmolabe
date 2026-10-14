import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { patchLogDepthPrecision } from './UniverseRenderer.js';

// The depth a fragment writes, in float32 and quantised to a 24-bit buffer, at view
// depth w (scene units) with the far plane at `far`: three's formula and the patched one.
const f = Math.fround;
const quantise = (d: number) => Math.round(d * (2 ** 24 - 1));
const threeDepth = (w: number, far: number) => quantise(f(Math.log2(f(1 + w)) / Math.log2(far + 1)));
const patchedDepth = (w: number, far: number) => quantise(f(Math.log2(f(1 + f(1e9 * w))) / Math.log2(1 + 1e9 * far)));

describe('patchLogDepthPrecision', () => {
  it('rewrites three.js log depth chunks once', () => {
    const chunks = { logdepthbuf_vertex: THREE.ShaderChunk.logdepthbuf_vertex, logdepthbuf_fragment: THREE.ShaderChunk.logdepthbuf_fragment };
    // The renderer may have patched the shared chunks already; start from three's text.
    chunks.logdepthbuf_vertex = chunks.logdepthbuf_vertex.replace('1.0 + 1e9 * gl_Position.w', '1.0 + gl_Position.w');
    chunks.logdepthbuf_fragment = chunks.logdepthbuf_fragment.replace(/log2\( vFragDepth \) \/ log2\(.*\) \)/, 'log2( vFragDepth ) * logDepthBufFC * 0.5');
    expect(patchLogDepthPrecision(chunks)).toBe(true);
    expect(chunks.logdepthbuf_vertex).toContain('vFragDepth = 1.0 + 1e9 * gl_Position.w;');
    expect(chunks.logdepthbuf_fragment).toContain('exp2( 2.0 / logDepthBufFC )');
    const once = { ...chunks };
    expect(patchLogDepthPrecision(chunks)).toBe(true);
    expect(chunks).toEqual(once);
  });

  it('separates surfaces metres apart at ground level, which three alone cannot', () => {
    const km = 1e-6, far = 1e6; // default scale factor; the renderer's minimum far plane
    // A surface 1 km away and a skirt 100 m behind it.
    expect(threeDepth(1 * km, far)).toBe(threeDepth(1.1 * km, far));
    expect(patchedDepth(1.1 * km, far)).toBeGreaterThan(patchedDepth(1 * km, far));
    // 1 m apart at 1 km, and 10 km apart at the Moon's distance from Earth.
    expect(patchedDepth(1.001 * km, far)).toBeGreaterThan(patchedDepth(1 * km, far));
    expect(patchedDepth(384_410 * km, far)).toBeGreaterThan(patchedDepth(384_400 * km, far));
    // Order and range are kept: the far plane is still depth 1.
    expect(patchedDepth(far, far)).toBe(2 ** 24 - 1);
  });
});
