import { ShaderChunk } from 'three';

/**
 * three.js log depth stores `log2(1 + w)` with `w` in scene units. At the default
 * 1e-6 units per km a ground view has `w ≈ 1e-6`, where `1.0 + w` in float32
 * resolves only ~120 m and the 24-bit buffer ~1 km: terrain skirts and hidden
 * slopes a few hundred metres behind the surface draw through it. Scaling `w`
 * by 1e9 (metres at the default scale) before the log keeps ~1e-6 relative
 * depth precision from millimetres out to the far plane.
 *
 * The far plane's `log2(1 + 1e9·far)` is replaced by `log2(1e9) + log2(far + 1)`,
 * which three already uploads as `2 / logDepthBufFC`: one add and one divide per
 * fragment instead of three's one multiply. It is larger for any far ≥ 1, so
 * the far plane maps just under 1 and nothing extra is clipped.
 */
const ORIGINAL = {
  vertex: 'vFragDepth = 1.0 + gl_Position.w;',
  fragment: 'log2( vFragDepth ) * logDepthBufFC * 0.5',
};
export const LOG_DEPTH_PATCH = {
  vertex: 'vFragDepth = 1.0 + 1e9 * gl_Position.w;',
  fragment: `log2( vFragDepth ) / ( ${Math.log2(1e9)} + 2.0 / logDepthBufFC )`,
};

type Chunks = Record<string, unknown>;

/**
 * Patch three's shared log-depth chunks, so every log-depth material (and
 * renderer) agrees. Both chunks must be three's text or already patched; a
 * half-patched pair is completed. Anything else (renamed, removed or changed
 * upstream) is left alone with a warning and returns false.
 */
export function patchLogDepthPrecision(chunks: Chunks = ShaderChunk as unknown as Chunks): boolean {
  const keys = { vertex: 'logdepthbuf_vertex', fragment: 'logdepthbuf_fragment' } as const;
  const state = (k: keyof typeof keys) => {
    const s = chunks[keys[k]];
    return typeof s !== 'string' ? 'missing' : s.includes(LOG_DEPTH_PATCH[k]) ? 'patched' : s.includes(ORIGINAL[k]) ? 'original' : 'unknown';
  };
  const states = { vertex: state('vertex'), fragment: state('fragment') };
  if (Object.values(states).some(s => s === 'missing' || s === 'unknown')) {
    console.warn(`[LogDepth] three.js log depth chunks not recognised (${JSON.stringify(states)}); ground-level depth precision is not patched`);
    return false;
  }
  for (const k of ['vertex', 'fragment'] as const) {
    if (states[k] === 'original') chunks[keys[k]] = (chunks[keys[k]] as string).replace(ORIGINAL[k], LOG_DEPTH_PATCH[k]);
  }
  return true;
}
