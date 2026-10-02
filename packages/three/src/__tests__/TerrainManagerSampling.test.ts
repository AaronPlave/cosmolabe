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

describe('TerrainManager debug surface modes and metrics', () => {
  /** Neighbouring real z14 tiles at Jezero, plus their parent. */
  const JEZERO = [[14, 23432, 9870], [14, 23433, 9870], [13, 11716, 4935]] as const;
  const load = (tm: TerrainManager, z: number, x: number, y: number) => {
    const tile = fakeTile(z, x, y);
    capture(tm, tile, fixture(`marshub-${z}-${x}-${y}.terrain`), `https://example.invalid/mars_v14/${tile.content.uri}`);
    return tile;
  };
  const colorOf = (tm: TerrainManager, tile: unknown) => {
    const c = new THREE.Color();
    (tm as unknown as { debugColorFor(t: unknown, c: THREE.Color): void }).debugColorFor(tile, c);
    return c;
  };
  const dispose = (tm: TerrainManager, tile: unknown) =>
    (tm as unknown as { tiles: { dispatchEvent(e: unknown): void } })
      .tiles.dispatchEvent({ type: 'dispose-model', tile, scene: new THREE.Group() });

  it('measures the seam between cached same-level neighbours, and forgets it when one is evicted', () => {
    const tm = makeManager();
    const [a, b] = JEZERO;
    const tileA = load(tm, ...a);
    const idA = `decoded:${tileA.content.uri}`;
    expect(tm.tileSeamError(idA)).toBeNull(); // no neighbour cached yet

    const tileB = load(tm, ...b);
    const seam = tm.tileSeamError(idA)!;
    // Same order as validate-terrain's offline report for this pair (~1.75 m).
    expect(seam).toBeGreaterThan(1e-4);
    expect(seam).toBeLessThan(0.01);
    expect(tm.tileSeamError(`decoded:${tileB.content.uri}`)).toBeCloseTo(seam, 9);

    dispose(tm, tileB);
    expect(tm.tileSeamError(idA)).toBeNull();
  });

  it('forgets a seam when the sampler evicts a neighbour on its own, not only on renderer disposal', () => {
    // Review repro: with a two-tile CPU cache, the parent's arrival evicts the
    // oldest neighbour; the survivor must stop reporting the seam it shared.
    const tm = makeManager({ samplerMaxTiles: 2 });
    const [a, b, parent] = JEZERO;
    const tileA = load(tm, ...a);
    const tileB = load(tm, ...b);
    const idA = `decoded:${tileA.content.uri}`, idB = `decoded:${tileB.content.uri}`;
    expect(tm.tileSeamError(idB)).toBeGreaterThan(1e-4);

    load(tm, ...parent);
    expect(tm.sampler.getTile(idA)).toBeUndefined();
    expect(tm.tileSeamError(idB)).toBeNull();
    expect(tm.tileSeamError(idA)).toBeNull();
  });

  it('colors CPU coverage from the sampler cache, not from rendered geometry', () => {
    const tm = makeManager();
    tm.setDebugMode('cpu-coverage');
    const decoded = load(tm, ...JEZERO[0]);
    const synthesized = { ...fakeTile(15, 46864, 19740), content: undefined, parent: decoded };
    expect(colorOf(tm, decoded).getHex()).toBe(0x2fbf71);
    expect(colorOf(tm, synthesized).getHex()).toBe(0xf2a33a);
  });

  it('colors below-datum terrain blue, inheriting a split tile\'s ancestor', () => {
    const tm = makeManager();
    tm.setDebugMode('datum-height');
    const decoded = load(tm, ...JEZERO[0]);
    const child = { content: undefined, parent: decoded };
    const hsl = { h: 0, s: 0, l: 0 };
    colorOf(tm, decoded).getHSL(hsl);
    expect(hsl.h).toBeCloseTo(0.6, 2); // Jezero sits ~2.5 km below the Mars reference
    expect(colorOf(tm, child).getHex()).toBe(colorOf(tm, decoded).getHex());
  });

  it('maps modes onto the upstream debug plugin, and unregisters it once nothing is on', () => {
    const tm = makeManager();
    const plugin = () => (tm as unknown as { debugPlugin: { colorMode: number; unlit: boolean } | null }).debugPlugin;
    tm.setDebugMode('none');
    expect(plugin()).toBeNull(); // nothing registered until a mode is asked for
    tm.setDebugMode('lod');
    expect(plugin()!.colorMode).toBe(4); // ColorModes.DEPTH
    expect(plugin()!.unlit).toBe(true);
    tm.setDebugMode('seam-error');
    expect(plugin()!.colorMode).toBe(9); // ColorModes.CUSTOM_COLOR
    tm.setDebug(true);
    tm.setDebugMode('none');
    // Bounds still on: the plugin stays, with real materials restored.
    expect(plugin()!.colorMode).toBe(0);
    expect(plugin()!.unlit).toBe(false);
    expect(tm.debugSurfaceMode).toBe('none');
    // Nothing left on: the plugin is unregistered so it costs nothing per frame.
    tm.setDebug(false);
    expect(plugin()).toBeNull();
    expect((tm.tiles as unknown as { plugins: unknown[] }).plugins.some((p) => p instanceof Object && (p as { name?: string }).name === 'DEBUG_TILES_PLUGIN')).toBe(false);
    expect(() => tm.setDebugMode('bogus' as never)).toThrow(/Unknown terrain debug mode/);
  });

  it('estimates memory over every loaded model, including overlays and set-aside originals in debug mode', () => {
    const tm = makeManager();
    const shared = new THREE.Texture({ width: 64, height: 32 });
    const original = new THREE.Texture({ width: 16, height: 16 });
    const plane = () => new THREE.PlaneGeometry(1, 1);
    const scenes: THREE.Object3D[] = [];
    for (let i = 0; i < 3; i++) {
      // applyNormalMap clones one map per tile: distinct Textures, one Source.
      const scene = new THREE.Group();
      scene.add(new THREE.Mesh(plane(), new THREE.MeshStandardMaterial({ normalMap: shared.clone() })));
      scenes.push(scene);
    }
    // A tile in debug mode: the plugin's flat material is current and the real
    // one sits under its private symbol.
    const debugged = new THREE.Mesh(plane(), new THREE.MeshBasicMaterial());
    (debugged as unknown as Record<symbol, THREE.Material>)[Symbol('ORIGINAL_MATERIAL')] =
      new THREE.MeshStandardMaterial({ map: original });
    const hidden = new THREE.Group();
    hidden.add(debugged);
    scenes.push(hidden);
    // Imagery overlays: textures in ImageOverlayPlugin's per-material uniform array.
    const overlayTex = new THREE.Texture({ width: 128, height: 128 });
    const overlaid = new THREE.Mesh(plane(), new THREE.MeshStandardMaterial());
    (overlaid.material as unknown as Record<symbol, unknown>)[Symbol('OVERLAY_PARAMS')] =
      { layerMaps: { value: [overlayTex, null] } };
    const withOverlay = new THREE.Group();
    withOverlay.add(overlaid);
    scenes.push(withOverlay);
    // Only one scene is attached to the visible group; the rest are cached but out of view.
    tm.group.add(scenes[0]);
    (tm.tiles as unknown as { forEachLoadedModel(cb: (s: THREE.Object3D) => void): void })
      .forEachLoadedModel = (cb) => scenes.forEach((sc) => cb(sc));

    const g = plane();
    const perGeometry = Object.values(g.attributes).reduce((a, attr) => a + (attr as THREE.BufferAttribute).array.byteLength, 0) + g.index!.array.byteLength;
    const m = tm.metrics;
    expect(m.memory.geometryBytes).toBe(5 * perGeometry);
    // Sized as upstream sizes them (RGBA8 plus a full mip chain, ×4/3).
    expect(m.memory.textureBytes).toBe((64 * 32 * 4 + 16 * 16 * 4 + 128 * 128 * 4) * 4 / 3);
  });

  it('reports decode cost, CPU tiles and sample timing, and resets them', () => {
    const tm = makeManager();
    for (const [z, x, y] of JEZERO) load(tm, z, x, y);
    tm.sample(18.44, 77.45);
    let m = tm.metrics;
    expect(m.cpuDecode.count).toBe(3);
    expect(m.cpuDecode.meanMs).toBeGreaterThan(0);
    expect(m.tiles.cpu).toBe(3);
    expect(m.sample.count).toBe(1);
    expect(m.network.requests).toBe(0);
    expect(m.memory.geometryBytes).toBe(0); // nothing rendered in this harness
    tm.resetMetrics();
    m = tm.metrics;
    expect(m.cpuDecode.count).toBe(0);
    expect(m.sample.meanMicros).toBe(0);
  });
});
