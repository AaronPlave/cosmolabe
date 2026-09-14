import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TerrainManager, type TerrainConfig } from '../TerrainManager.js';

/**
 * Integration cover for the wiring between the tiles renderer and the CPU
 * sampler: the `parseToMesh` capture hook, the `dispose-model` eviction, the
 * tileset height-offset correction, and the tile bounds read off the tile.
 * The sampler's own maths lives in TerrainSampler.test.ts.
 */

const MARS_RADII: [number, number, number] = [3396.19, 3396.19, 3376.2];

/**
 * TerrainManager takes a WebGLRenderer only to hand to ImageOverlayPlugin, which
 * stores it and uses it at render time. Nothing on the paths under test touches
 * it, and there is no GL context in this environment, so a stub stands in.
 */
const NO_RENDERER = undefined as unknown as THREE.WebGLRenderer;
const OFFSET_KM = 8.765; // mars_v14, as configured in msl-dingo-gap.json

const fixture = (name: string) => {
  const buf = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

/** A tile shaped the way QuantizedMeshPlugin.createChild builds one. */
function fakeTile(z: number, x: number, y: number) {
  const nx = 2 ** (z + 1), ny = 2 ** z;
  const toRad = Math.PI / 180;
  const west = ((x / nx) * 360 - 180) * toRad;
  const east = (((x + 1) / nx) * 360 - 180) * toRad;
  const south = ((y / ny) * 180 - 90) * toRad;
  const north = ((((y + 1) / ny) * 180 - 90)) * toRad;
  return {
    content: { uri: `${z}/${x}/${y}.terrain?v=2.0` },
    boundingVolume: { region: [west, south, east, north, -1000, 1000] },
    geometricError: 1,
  };
}

const makeManager = (over: Partial<TerrainConfig> = {}) => new TerrainManager(
  {
    type: 'quantized-mesh',
    url: 'https://example.invalid/mars_v14/',
    referenceRadiusOffsetKm: OFFSET_KM,
    ...over,
  } as TerrainConfig,
  MARS_RADII,
  NO_RENDERER,
);

const capture = (tm: TerrainManager, tile: unknown, buffer: ArrayBuffer, absoluteUrl: string) =>
  (tm as unknown as {
    captureDecodedQuantizedMesh(b: ArrayBuffer, t: unknown, u: string): void;
  }).captureDecodedQuantizedMesh(buffer, tile, absoluteUrl);

describe('TerrainManager CPU sampling wiring', () => {
  it('captures a decoded tile into the sampler and samples inside its bounds', () => {
    const tm = makeManager();
    const tile = fakeTile(14, 9366, 7669);
    expect(tm.sampler.diagnostics.state).toBe('unloaded');

    capture(tm, tile, fixture('marshub-14-9366-7669.terrain'), `https://example.invalid/mars_v14/${tile.content.uri}`);

    expect(tm.sampler.diagnostics.tileCount).toBe(1);
    const toDeg = 180 / Math.PI;
    const [w, s, e, n] = tile.boundingVolume.region;
    const sample = tm.sample(((s + n) / 2) * toDeg, ((w + e) / 2) * toDeg);
    expect(sample).not.toBeNull();
    expect(Number.isFinite(sample!.elevationKm)).toBe(true);
  });

  it('applies the tileset height offset so samples agree with the rendered surface', () => {
    const withOffset = makeManager();
    const withoutOffset = makeManager({ referenceRadiusOffsetKm: 0 });
    const tile = fakeTile(14, 9366, 7669);
    const url = `https://example.invalid/mars_v14/${tile.content.uri}`;
    capture(withOffset, tile, fixture('marshub-14-9366-7669.terrain'), url);
    capture(withoutOffset, tile, fixture('marshub-14-9366-7669.terrain'), url);

    const toDeg = 180 / Math.PI;
    const [w, s, e, n] = tile.boundingVolume.region;
    const lat = ((s + n) / 2) * toDeg, lon = ((w + e) / 2) * toDeg;
    const corrected = withOffset.sample(lat, lon)!.elevationKm;
    const raw = withoutOffset.sample(lat, lon)!.elevationKm;

    expect(raw - corrected).toBeCloseTo(OFFSET_KM, 5);
    // mars_v14 encodes ~8.765 km high; corrected, this plateau tile is plausible
    // Mars topography rather than an impossible +12 km.
    expect(corrected).toBeGreaterThan(-9);
    expect(corrected).toBeLessThan(22);
  });

  it('evicts the tile on dispose-model — insert and dispose must agree on identity', () => {
    // Regression: `parseToMesh` receives the URL already resolved against the
    // base path, while dispose only ever sees the relative `content.uri`. Keying
    // one on each silently leaked every tile.
    const tm = makeManager();
    const tile = fakeTile(6, 63, 31);
    capture(tm, tile, fixture('marshub-6-63-31.terrain'), `https://example.invalid/mars_v14/${tile.content.uri}`);
    expect(tm.sampler.diagnostics.tileCount).toBe(1);

    // A real Object3D: other plugins (tile fade) listen on this event too.
    (tm as unknown as { tiles: { dispatchEvent(e: unknown): void } })
      .tiles.dispatchEvent({ type: 'dispose-model', tile, scene: new THREE.Group() });

    expect(tm.sampler.diagnostics.tileCount).toBe(0);
    expect(tm.sampler.diagnostics.state).toBe('unloaded');
  });

  it('reads tile bounds from the tile, so samples land in the right place', () => {
    const tm = makeManager();
    const tile = fakeTile(6, 63, 31);
    capture(tm, tile, fixture('marshub-6-63-31.terrain'), `https://example.invalid/mars_v14/${tile.content.uri}`);

    const toDeg = 180 / Math.PI;
    const [w, s, e, n] = tile.boundingVolume.region;
    const midLat = ((s + n) / 2) * toDeg, midLon = ((w + e) / 2) * toDeg;
    expect(tm.sample(midLat, midLon)).not.toBeNull();
    // Well outside this tile's footprint there is no coverage.
    expect(tm.sample(midLat + 60, midLon)).toBeNull();
    expect(tm.sample(midLat, midLon + 120)).toBeNull();
  });

  it('survives a corrupt tile without poisoning the cache', () => {
    const tm = makeManager();
    const good = fakeTile(6, 63, 31);
    capture(tm, good, fixture('marshub-6-63-31.terrain'), 'https://example.invalid/a');

    const corrupt = fakeTile(6, 62, 31);
    const truncated = fixture('marshub-6-63-31.terrain').slice(0, 120);
    expect(() => capture(tm, corrupt, truncated, 'https://example.invalid/b')).not.toThrow();

    // The good tile is still queryable and the bad one was never inserted.
    expect(tm.sampler.diagnostics.tileCount).toBe(1);
    const toDeg = 180 / Math.PI;
    const [w, s, e, n] = good.boundingVolume.region;
    expect(tm.sample(((s + n) / 2) * toDeg, ((w + e) / 2) * toDeg)).not.toBeNull();
  });

  it('ignores tiles with no usable identity or bounds instead of throwing', () => {
    const tm = makeManager();
    const buffer = fixture('marshub-6-63-31.terrain');
    expect(() => capture(tm, { boundingVolume: fakeTile(6, 63, 31).boundingVolume }, buffer, 'u')).not.toThrow();
    expect(() => capture(tm, { content: { uri: 'x.terrain' } }, buffer, 'u')).not.toThrow();
    expect(tm.sampler.diagnostics.tileCount).toBe(0);
  });

  it('captures nothing for an imagery-only body', () => {
    const tm = new TerrainManager(
      { type: 'imagery', imagery: [{ type: 'xyz', url: 'https://example.invalid/{z}/{x}/{y}.png' }] } as TerrainConfig,
      MARS_RADII,
      NO_RENDERER,
    );
    const tile = fakeTile(6, 63, 31);
    capture(tm, tile, fixture('marshub-6-63-31.terrain'), 'https://example.invalid/x');
    expect(tm.sampler.diagnostics.tileCount).toBe(0);
  });
});
