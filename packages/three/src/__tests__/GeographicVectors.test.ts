import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Universe, parseGeographicGeoJson, resolveGeographicStyle, type GeographicLayer, type GeographicGeometry, type GeoPosition } from '@cosmolabe/core';
import { GeographicIndex, VECTOR_CELL_LIMIT, VECTOR_PRIMITIVE_LIMIT, VECTOR_RENDER_PAGE_LIMIT, VECTOR_DETAIL_GRIDS, VECTOR_REFERENCE_LIMIT, VECTOR_FLAG, VECTOR_SHAPE_STEP, VECTOR_HALO_PX } from '../geographic/GeographicIndex.js';
import type { GeographicMaterial } from '../geographic/GeographicMaterial.js';
import { GeographicVectorLayer, VECTOR_FRAME_DRAW_LIMIT, VECTOR_SCISSOR_PADDING_PX } from '../geographic/GeographicVectorLayer.js';
import jezero from '../../../core/src/__tests__/__fixtures__/geographic-jezero.json';
import denseJezero from '../../../core/src/__tests__/__fixtures__/geographic-jezero-dense.json';
import southpole from '../../../core/src/__tests__/__fixtures__/geographic-southpole.json';
import type { BodyMesh } from '../BodyMesh.js';

function layer(geometry: GeographicGeometry<GeoPosition>[], body = 'Moon'): GeographicLayer {
  return parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features: geometry.map((g, i) => ({ type: 'Feature', id: i, properties: {}, geometry: g })) }), {
    id: 'science', name: 'Science', body, source: 'science.geojson', coordinates: {
      latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180',
      referenceShape: { kind: 'sphere', radiusKm: 1737.4 }, height: { unit: 'km', datum: 'reference-sphere', convention: 'geodetic-normal' },
    },
  }, { kind: 'local-file', identity: 'science.geojson' });
}
const pick = (index: GeographicIndex, lon: number, lat: number) => index.pick({ lonDeg: lon, latDeg: lat }, [0.0001, 0], [0, 0.0001]);
const ref = { bodyName: 'Moon', layerId: 'science', featureId: 'number:0' };

describe('geographic surface index', () => {
  it('omits unresolved grazing marks beyond the spatial padding while retaining fills', () => {
    const index = new GeographicIndex([layer([
      {type: 'Point', coordinates: [0,0]},
      {type: 'LineString', coordinates: [[-1,0],[1,0]]},
      {type: 'Polygon', coordinates: [[[-2,-2],[2,-2],[2,2],[-2,2],[-2,-2]]]},
    ])]);
    expect(pick(index,0,0)?.featureId).toBe('number:0');
    expect(index.pick({lonDeg:0,latDeg:0},[2,0],[0,2])?.featureId).toBe('number:2');
  });
  it('keeps polar point markers independent of the pole longitude', () => {
    for (const sign of [-1, 1]) {
      const index = new GeographicIndex([layer([{ type: 'Point', coordinates: [45, sign * 90] }])]);
      for (const longitude of [-179, -20, 90, 179]) {
        expect(pick(index, longitude, sign * 89.9998)).toEqual(ref);
      }
    }
  });
  it('preserves a seam-crossing concave polygon, holes and ring boundary picking', () => {
    const data = layer([{ type: 'Polygon', coordinates: [
      [[177, -3], [-177, -3], [-177, 3], [179, 3], [179, 1], [177, 1], [177, -3]],
      [[179.3, -1], [-179.3, -1], [-179.3, 0], [179.3, 0], [179.3, -1]],
    ] }]);
    expect(data.skippedFeatures).toBe(0);
    const index = new GeographicIndex([data]);
    expect(index.diagnostics).toEqual([]);
    expect(pick(index, 179, -2)).toEqual(ref);
    expect(pick(index, -179, -2)).toEqual(ref);
    expect(pick(index, 180, -0.5)).toBeNull();
    expect(pick(index, 179.3, -0.5)).toEqual(ref);
    expect(pick(index, 178, 2)).toBeNull();
    expect(pick(index, 0, 0)).toBeNull();
  });

  it('supports pole-enclosing rings and independent polar holes without a longitude seam', () => {
    const ring = (latitude: number): GeoPosition[] => [[-135, latitude], [-45, latitude], [45, latitude], [135, latitude], [-135, latitude]];
    for (const sign of [-1, 1]) {
      const data = layer([{ type: 'Polygon', coordinates: [ring(sign * 85), ring(sign * 89)] }]);
      expect(data.skippedFeatures).toBe(0);
      const index = new GeographicIndex([data]);
      expect(index.diagnostics).toEqual([]);
      expect(pick(index, 179, sign * 87)).toEqual(ref);
      expect(pick(index, -179, sign * 87)).toEqual(ref);
      expect(pick(index, 25, sign * 89.9)).toBeNull();
      expect(pick(index, 0, sign * 82)).toBeNull();
    }
  });

  it('handles wide regions without filling the antipodal side', () => {
    const index = new GeographicIndex([layer([{ type: 'Polygon', coordinates: [
      [[-120, -30], [0, -30], [120, -30], [120, 30], [0, 30], [-120, 30], [-120, -30]],
      [[99, 10], [101, 10], [101, 12], [99, 12], [99, 10]],
    ] }])]);
    expect(index.diagnostics).toEqual([]);
    expect(pick(index, 100, 0)).toEqual(ref);
    expect(pick(index, -100, 0)).toEqual(ref);
    expect(pick(index, 170, 0)).toBeNull();
    expect(pick(index, 100, 11)).toBeNull();
    expect(pick(index, -115, 20)).toEqual(ref);
  });

  it('imports the Jezero and lunar fixtures including every Multi geometry', () => {
    for (const fixture of [jezero, southpole]) {
      const definition = layer([]).definition;
      const data = parseGeographicGeoJson(JSON.stringify(fixture), definition, { kind: 'local-file', identity: 'fixture' });
      const index = new GeographicIndex([data]);
      expect(data.skippedFeatures).toBe(0);
      expect(index.features).toHaveLength(fixture.features.length);
      expect(index.diagnostics).toEqual([]);
      const packed = index.pack();
      expect(packed.records.every(Number.isFinite)).toBe(true);
      expect(packed.cells.every(Number.isFinite)).toBe(true);
    }
  });

  it('returns deterministic point/line/fill precedence and keeps line tolerance in pixels', () => {
    const index = new GeographicIndex([layer([
      { type: 'Point', coordinates: [0, 0] },
      { type: 'LineString', coordinates: [[-1, 0], [1, 0]] },
      { type: 'Polygon', coordinates: [[[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]]] },
    ])]);
    expect(pick(index, 0, 0)).toEqual(ref);
    expect(pick(index, 0.5, 0.0003)?.featureId).toBe('number:1');
    expect(pick(index, 0.5, 0.0006)?.featureId).toBe('number:2');
  });

  it('retains a detailed Jezero polygon and every localized target in bounded GPU pages', () => {
    const data = parseGeographicGeoJson(JSON.stringify(denseJezero), layer([]).definition, { kind: 'local-file', identity: 'dense-jezero' });
    const index = new GeographicIndex([data]);
    expect(data.skippedFeatures).toBe(0);
    expect(index.diagnostics).toEqual([]);
    expect(index.features).toHaveLength(denseJezero.features.length);
    expect(pick(index, 77.45, 18.45)?.featureId).toBe('string:target-820');
    expect(pick(index, 77.451, 18.451)?.featureId).toBe('string:detailed-region');
    for (const feature of data.features.slice(1)) {
      if (feature.geometry.type !== 'Point') throw new Error('Expected point fixture');
      expect(pick(index, feature.geometry.coordinates.lonDeg, feature.geometry.coordinates.latDeg)?.featureId).toBe(feature.id);
    }
    const packed = index.pack();
    const packedIds = new Set<number>();
    for (let i = 0; i < packed.cells.length; i += 4) {
      const offset = packed.cells[i], count = packed.cells[i + 1];
      expect(count).toBeLessThanOrEqual(VECTOR_CELL_LIMIT);
      for (let j = 0; j < count; j++) packedIds.add(packed.references[(offset + j) * 4]);
    }
    expect(packedIds.size).toBe(index.primitives.length);
    expect(packed.pages).toBeGreaterThan(1);
    expect(packed.detail).toBeDefined();
    const detail = packed.detail!.levels[0];
    expect(detail.size).toBe(VECTOR_DETAIL_GRIDS[0]);
    expect(packed.detail!.levels.length).toBe(VECTOR_DETAIL_GRIDS.length);
    for (const level of packed.detail!.levels) {
      expect(level.pages).toBeLessThanOrEqual(packed.pages);
      // Paging at coarser zoom levels must retain every target too.
      for (let i = 1; i < data.features.length; i++) {
        const g = data.features[i].geometry;
        if (g.type !== 'Point') throw new Error('Expected point fixture');
        const x = Math.floor((g.coordinates.lonDeg - level.bounds[0]) / level.step[0]);
        const y = Math.floor((g.coordinates.latDeg - level.bounds[1]) / level.step[1]);
        let found = false;
        for (let page = 0; page < level.pages; page++) {
          const cell = (level.offset + page * level.size ** 2 + y * level.size + x) * 4;
          const offset = packed.detail!.cells[cell], count = packed.detail!.cells[cell + 1];
          for (let j = 0; j < count; j++) if (index.primitives[packed.references[(offset + j) * 4]].feature === i + 1) found = true;
        }
        expect(found).toBe(true);
      }
    }
    expect(packed.references.length / 4).toBeLessThanOrEqual(VECTOR_REFERENCE_LIMIT);
    for (let cell = 0; cell < packed.detail!.cells.length; cell += 4) expect(packed.detail!.cells[cell + 1]).toBeLessThanOrEqual(VECTOR_CELL_LIMIT);
    // Every point remains a candidate throughout its padded footprint, including
    // neighbouring cell boundaries. Detail is an acceleration, not simplification.
    for (let i = 1; i < data.features.length; i++) {
      const g = data.features[i].geometry;
      if (g.type !== 'Point') throw new Error('Expected point fixture');
      for (const sx of [-0.99, 0, 0.99]) for (const sy of [-0.99, 0, 0.99]) {
        const x = Math.floor((g.coordinates.lonDeg + sx * detail.step[0] - detail.bounds[0]) / detail.step[0]);
        const y = Math.floor((g.coordinates.latDeg + sy * detail.step[1] - detail.bounds[1]) / detail.step[1]);
        const cell = (detail.offset + y * detail.size + x) * 4;
        const offset = packed.detail!.cells[cell], count = packed.detail!.cells[cell + 1];
        const ids = Array.from({ length: count }, (_, j) => packed.references[(offset + j) * 4]);
        expect(ids.some(id => index.primitives[id].feature === i + 1)).toBe(true);
      }
    }
  });

  it('retains a seam-aware global grid when localized geometry crosses the longitude seam', () => {
    const ring: GeoPosition[] = Array.from({ length: 160 }, (_, i) => {
      const angle = i / 160 * Math.PI * 2;
      const lon = 179.99 + 0.04 * Math.cos(angle);
      return [lon > 180 ? lon - 360 : lon, 18.45 + 0.04 * Math.sin(angle)];
    });
    ring.push(ring[0]);
    const index = new GeographicIndex([layer([{ type: 'Polygon', coordinates: [ring] }])]);
    expect(index.diagnostics).toEqual([]);
    expect(index.features).toHaveLength(1);
    expect(index.pack().detail?.levels[0]).toMatchObject({size: 256, height: 128});
    expect(pick(index, -179.999, 18.45)).toEqual(ref);
  });

  it('rejects a feature atomically at the batch primitive budget', () => {
    const data = layer([{ type: 'Point', coordinates: [77.45, 18.45] }]);
    const geometry = data.features[0].geometry;
    if (geometry.type !== 'Point') throw new Error('Expected point fixture');
    data.features[0].geometry = { type: 'MultiPoint', coordinates: Array.from({ length: VECTOR_PRIMITIVE_LIMIT + 1 }, () => geometry.coordinates) };
    const index = new GeographicIndex([data]);
    expect(index.features).toEqual([]);
    expect(index.primitives).toEqual([]);
    expect(index.cells.every(ids => ids.length === 0)).toBe(true);
    expect(index.diagnostics).toMatchObject([{ featureId: 'number:0', code: 'vector-budget', message: 'Error: primitive budget exceeded' }]);
  });

  it('pages coincident inputs and allocates nothing for hidden layers', () => {
    const data = layer(Array.from({ length: 5000 }, () => ({ type: 'Point', coordinates: [0, 0] })));
    const index = new GeographicIndex([data]);
    expect(index.features).toHaveLength(5000);
    expect(index.diagnostics).toEqual([]);
    expect(index.pack().pages).toBe(Math.ceil(5000 / VECTOR_CELL_LIMIT));
    expect(Math.max(...index.cells.map(c => c.length))).toBe(5000);
    data.definition.display = { visible: false };
    const hidden = new GeographicIndex([data]);
    expect(hidden.primitives).toHaveLength(0);
    expect(hidden.pack().records.byteLength).toBe(0);
  });
});

function harness(data: GeographicLayer) {
  const universe = new Universe();
  universe.geographicLayers.replaceCatalog('test', [{ id: data.id, status: 'ready', layer: data, source: data.source, diagnostics: [] }]);
  const vectors = new GeographicVectorLayer(universe, 1);
  const geometry = new THREE.SphereGeometry(1737.4, 16, 8).rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh<THREE.BufferGeometry>(geometry, new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld(true);
  const body = { visible: true, body: { name: 'Moon', geometryType: 'Globe', radii: [1737.4, 1737.4, 1737.4] }, mesh,
    position: new THREE.Vector3(), terrainTileGroup: null, terrainDatum: null, getSurfaceOverlays: () => [],
    bodyToWorldQuaternion: (q: THREE.Quaternion) => q.identity(), surfaceTransitionState: 'static', isImageryOnlySurface: false } as unknown as BodyMesh;
  // A default framebuffer with an 800×600 viewport; the scissor each render used is recorded.
  const scissor = { test: false, rect: new THREE.Vector4(0, 0, 800, 600) };
  const renderer = {
    getPixelRatio: () => 1, render: () => { scissors.push(scissor.test ? scissor.rect.clone() : null); },
    getRenderTarget: () => null, getViewport: (v: THREE.Vector4) => v.set(0, 0, 800, 600),
    getScissor: (v: THREE.Vector4) => v.copy(scissor.rect), getScissorTest: () => scissor.test,
    setScissor: (v: THREE.Vector4) => { scissor.rect.copy(v); }, setScissorTest: (on: boolean) => { scissor.test = on; },
  } as unknown as THREE.WebGLRenderer;
  const scissors: (THREE.Vector4 | null)[] = [];
  // Looking at (0°, 0°) from 2,500 km, where the fixtures' features are.
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
  camera.position.set(2500, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  return { universe, vectors, mesh, body, renderer, scissors, camera };
}

describe('geographic vector pass cost', () => {
  it('pads scissor rectangles enough for the largest styled mark', () => {
    // A 24 px diamond reaches √2 × (12 + emphasis + halo) px along an axis, plus antialiasing.
    expect(VECTOR_SCISSOR_PADDING_PX).toBeGreaterThanOrEqual(Math.SQRT2 * (12 + 0.75 + 1.5) + 0.5);
  });

  const look = (h: ReturnType<typeof harness>, at: [number, number, number]) => {
    h.camera.position.set(2500, 0, 0); h.camera.up.set(0, 0, 1); h.camera.lookAt(...at); h.camera.updateMatrixWorld(true);
  };
  const frame = (h: ReturnType<typeof harness>) => {
    h.scissors.length = 0;
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    return [...h.scissors];
  };

  it('scissors the pass to where the features are, not the whole visible body', () => {
    const h = harness(layer([{ type: 'Point', coordinates: [1, 1] }]));
    look(h, [0, 0, 0]);
    const [rect, ...rest] = frame(h);
    expect(rest).toEqual([]);
    expect(rect).toBeInstanceOf(THREE.Vector4);
    expect(rect!.z * rect!.w).toBeLessThan(0.02 * 800 * 600);
    // It contains the point as drawn.
    const q = new THREE.Vector3(...[1737.4 * Math.cos(Math.PI / 180) ** 2, 1737.4 * Math.cos(Math.PI / 180) * Math.sin(Math.PI / 180), 1737.4 * Math.sin(Math.PI / 180)]).project(h.camera);
    const [x, y] = [(q.x + 1) / 2 * 800, (q.y + 1) / 2 * 600];
    expect(x).toBeGreaterThan(rect!.x); expect(x).toBeLessThan(rect!.x + rect!.z);
    expect(y).toBeGreaterThan(rect!.y); expect(y).toBeLessThan(rect!.y + rect!.w);
    expect(h.vectors.metrics.shadedPixels).toBe(rect!.z * rect!.w);
    h.vectors.dispose(); h.universe.dispose();
  });

  it('gives a selection highlight its own small rectangle, and draws nothing out of view', () => {
    const h = harness(layer([{ type: 'LineString', coordinates: [[1, 1], [1.5, 1.2]] }, { type: 'LineString', coordinates: [[20, 5], [21, 6]] }]));
    look(h, [0, 0, 0]);
    h.vectors.setSelected({ layerId: 'science', featureId: 'number:0', bodyName: 'Moon' });
    const [layerRect, highlight] = frame(h);
    expect(highlight).toBeInstanceOf(THREE.Vector4);
    expect(highlight!.z * highlight!.w).toBeLessThan(layerRect!.z * layerRect!.w);
    // Looking out to the side, past the limb: no vector draws at all.
    look(h, [2500, 5000, 0]);
    expect(frame(h)).toEqual([]);
    expect(h.vectors.metrics.drawCalls).toBe(0);
    h.vectors.dispose(); h.universe.dispose();
  });

  it('keeps the full viewport for features spread across the globe', () => {
    const h = harness(layer([{ type: 'Point', coordinates: [-100, 0] }, { type: 'Point', coordinates: [100, 0] }]));
    look(h, [0, 0, 0]);
    expect(frame(h)).toEqual([null]);
    expect(h.vectors.metrics.shadedPixels).toBe(800 * 600);
    h.vectors.dispose(); h.universe.dispose();
  });
});

describe('geographic renderer lifecycle and placement', () => {
  it('omits a pathological 100k-point group before allocating GPU resources or pick targets', () => {
    // Inside a grid cell: nine padded references each, below the 1M cap.
    const data = layer([{ type: 'Point', coordinates: [1, 1] }]);
    const geometry = data.features[0].geometry;
    if (geometry.type !== 'Point') throw new Error('Expected point fixture');
    data.features[0].geometry = { type: 'MultiPoint', coordinates: Array.from({ length: VECTOR_PRIMITIVE_LIMIT }, () => geometry.coordinates) };
    const index = new GeographicIndex([data]);
    expect(index.primitives).toHaveLength(VECTOR_PRIMITIVE_LIMIT);
    expect(index.renderPages).toBe(Math.ceil(VECTOR_PRIMITIVE_LIMIT / VECTOR_CELL_LIMIT));
    expect(index.renderPages).toBeGreaterThan(VECTOR_RENDER_PAGE_LIMIT);
    const h = harness(data);
    let calls = 0;
    h.renderer.render = () => { calls++; };
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(calls).toBe(0);
    expect(h.vectors.featureCount).toBe(0);
    expect(h.vectors.metrics).toEqual({ batches: 0, surfaceMeshes: 0, offsetVertices: 0, textureBytes: 0, drawPages: 0, drawCalls: 0, shadedPixels: 0, restyles: 0 });
    expect(h.vectors.diagnostics).toMatchObject([{ code: 'vector-render-budget', message: expect.stringContaining('391 render pages; limit is 16') }]);
    expect(h.vectors.pick(50, 50, 100, 100, h.camera, new Map([['Moon', h.body]]), null)).toBeNull();
    h.vectors.dispose(); h.universe.dispose();
  });

  it('draws shared-border highlights after all ordinary pages and counts their draws', () => {
    const h = harness(layer(Array.from({length: VECTOR_CELL_LIMIT + 1}, () => ({type: 'LineString', coordinates: [[-1,0],[1,0]]}))));
    h.vectors.setSelected({...ref, featureId: `number:${VECTOR_CELL_LIMIT}`});
    h.vectors.setHovered(ref);
    const draws: {page: number; highlight: number}[] = [];
    h.renderer.render = scene => {
      for (const child of scene.children) if (child.visible) {
        const material = (child as THREE.Mesh).material as THREE.ShaderMaterial;
        draws.push({page: material.uniforms.vectorPage.value, highlight: material.uniforms.vectorHighlight.value});
      }
    };
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(draws).toEqual([
      {page:0,highlight:0},{page:1,highlight:0},
      {page:0,highlight:1},
      {page:0,highlight:VECTOR_CELL_LIMIT+1},
    ]);
    expect(h.vectors.metrics.drawCalls).toBe(draws.length);
    h.vectors.dispose(); h.universe.dispose();
  });

  it('caps total surface draws across main/local/overlay passes and recovers next frame', () => {
    const h = harness(layer(Array.from({ length: VECTOR_RENDER_PAGE_LIMIT * VECTOR_CELL_LIMIT }, () => ({ type: 'Point', coordinates: [0, 0] }))));
    const tiles = new THREE.Group();
    const sources = VECTOR_FRAME_DRAW_LIMIT / VECTOR_RENDER_PAGE_LIMIT;
    for (let i = 1; i < sources; i++) tiles.add(new THREE.Mesh(h.mesh.geometry, h.mesh.material));
    const overlay = new THREE.Group(); overlay.add(new THREE.Mesh(h.mesh.geometry, h.mesh.material));
    Object.assign(h.body, { terrainTileGroup: tiles, getSurfaceOverlays: () => [{ group: overlay }] });
    let draws = 0;
    h.renderer.render = scene => { draws += scene.children.filter(child => child.visible).length; };
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]);
    expect(draws).toBe(VECTOR_FRAME_DRAW_LIMIT);
    expect(h.vectors.metrics.drawCalls).toBe(VECTOR_FRAME_DRAW_LIMIT);
    expect(h.vectors.metrics.surfaceMeshes).toBe(sources);
    h.vectors.render(h.renderer, h.camera, [h.body], true);
    h.vectors.render(h.renderer, h.camera, [h.body], false, new THREE.Vector3(1, 0, 0));
    h.vectors.end();
    expect(draws).toBe(VECTOR_FRAME_DRAW_LIMIT);
    expect(h.vectors.metrics.surfaceMeshes).toBe(0);
    expect(h.vectors.diagnostics).toMatchObject([{ code: 'vector-draw-budget' }]);
    expect(h.vectors.pick(50, 50, 100, 100, h.camera, new Map([['Moon', h.body]]), null)).toBeNull();
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(draws).toBe(VECTOR_FRAME_DRAW_LIMIT * 2);
    expect(h.vectors.diagnostics).toEqual([]);
    h.vectors.dispose(); h.universe.dispose();
  });

  it('shares terrain geometry, prunes LOD/reload proxies and preserves source resources', () => {
    const h = harness(layer([{ type: 'Point', coordinates: [0, 0] }]));
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(h.vectors.status[0]).toMatchObject({ bodySurfaceMode: 'reference-globe', featureTerrainCoverage: 'not-assessed', features: 1 });
    const old = h.mesh.geometry;
    h.mesh.geometry = old.clone();
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(h.mesh.geometry).not.toBe(old);
    h.vectors.setVisible('science', false); h.vectors.begin();
    expect(h.vectors.featureCount).toBe(0);
    expect(old.getAttribute('position').count).toBeGreaterThan(0);
    h.vectors.dispose(); h.universe.dispose();
  });

  it('disables source drawing and picking without changing retained visibility', () => {
    const h=harness(layer([{type:'Point',coordinates:[0,0]}]));
    h.vectors.begin();expect(h.vectors.featureCount).toBe(1);
    h.vectors.setSourceEnabled('science',false);h.vectors.begin();expect(h.vectors.featureCount).toBe(0);
    h.vectors.setSourceEnabled('science',true);h.vectors.begin();expect(h.vectors.featureCount).toBe(1);
    h.vectors.setVisible('science',false);h.vectors.setSourceEnabled('science',false);h.vectors.setSourceEnabled('science',true);h.vectors.begin();expect(h.vectors.featureCount).toBe(0);
    h.vectors.dispose();h.universe.dispose();
  });

  it('keeps explicit heights in km and rejects mixed/variable heights with diagnostics', () => {
    const h = harness(layer([{ type: 'Point', coordinates: [0, 0, 2] }, { type: 'LineString', coordinates: [[0, 0, 1], [1, 0, 2]] }]));
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(h.vectors.featureCount).toBe(0);
    expect(h.vectors.diagnostics.map(d => d.code)).toEqual(['unsupported-height', 'unsupported-height']);
    h.vectors.setPlacement('science', { mode: 'terrain-relative', offsetKm: 0.002 });
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(h.vectors.featureCount).toBe(2);
    expect(h.vectors.diagnostics).toEqual([]);
    h.vectors.dispose(); h.universe.dispose();
  });

  it.each([0, 0.002])('omits absolute Z=%s km against detailed terrain until an error-bounded representation exists', heightKm => {
    const data = layer([{ type: 'Point', coordinates: [0, 0, heightKm] }], 'Mars');
    data.datum.referenceShape = { kind: 'sphere', radiusKm: 3396.19 };
    const h = harness(data);
    Object.assign(h.body.body, { name: 'Mars', radii: [3396.19, 3396.19, 3396.19] });
    // A kilometre-wide, 10 m tessellated patch lies on the datum sphere.
    const terrain = new THREE.PlaneGeometry(1, 1, 100, 100);
    const position = terrain.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      const y = position.getX(i), z = position.getY(i);
      position.setXYZ(i, Math.sqrt(3396.19 ** 2 - y ** 2 - z ** 2), y, z);
    }
    h.mesh.geometry = terrain;
    Object.assign(h.body, { terrainDatum: data.datum, surfaceTransitionState: 'streamed' });
    const draw = () => { h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end(); };
    draw();
    expect(h.vectors.metrics).toEqual({ batches: 0, surfaceMeshes: 0, offsetVertices: 0, textureBytes: 0, drawPages: 0, drawCalls: 0, shadedPixels: 0, restyles: 0 });
    expect(h.vectors.diagnostics).toMatchObject([{ featureId: 'number:0', code: 'unsupported-height' }]);
    expect(h.vectors.pick(50, 50, 100, 100, h.camera, new Map([['Mars', h.body]]), null)).toBeNull();
    // Explicit absolute placement is constrained too.
    h.vectors.setPlacement(data.id, { mode: 'body-fixed-height', heightKm }); draw();
    expect(h.vectors.featureCount).toBe(0);
    // Only an explicit draping choice may reinterpret the drawing placement.
    h.vectors.setPlacement(data.id, { mode: 'clamp' }); draw();
    expect(h.vectors.featureCount).toBe(1);
    expect(h.vectors.metrics.surfaceMeshes).toBe(1);
    expect(h.vectors.diagnostics).toEqual([]);
    expect(data.features[0].geometry).toMatchObject({ coordinates: { heightKm } });
    h.vectors.dispose(); h.universe.dispose();
    terrain.dispose();
  });

  it('reports body mode without claiming feature coverage when streamed terrain is absent', () => {
    const h = harness(layer([{ type: 'Point', coordinates: [0, 0] }]));
    Object.assign(h.body, { surfaceTransitionState: 'streamed' });
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(h.body.terrainTileGroup).toBeNull();
    expect(h.vectors.status[0]).toMatchObject({ bodySurfaceMode: 'terrain-streaming', featureTerrainCoverage: 'not-assessed' });
    Object.assign(h.body, { isImageryOnlySurface: true });
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(h.vectors.status[0].bodySurfaceMode).toBe('reference-globe');
    h.vectors.dispose(); h.universe.dispose();
  });

  it('does not project onto DSKs or mismatched datums', () => {
    const h = harness(layer([{ type: 'Point', coordinates: [0, 0] }]));
    Object.defineProperty(h.body.body, 'geometryType', { value: 'Mesh' });
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(h.vectors.diagnostics[0].code).toBe('unsupported-surface');
    h.vectors.dispose(); h.universe.dispose();
  });
});

describe('geographic visibility, feature filters and selection invalidation', () => {
  const data = () => layer([
    { type: 'Point', coordinates: [1, 1] },
    { type: 'LineString', coordinates: [[2, 2], [3, 3]] },
    { type: 'Polygon', coordinates: [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]] },
  ]);
  function filtered() {
    const h = harness(data());
    const changes: unknown[] = [];
    const vectors = new GeographicVectorLayer(h.universe, 1, feature => changes.push(feature));
    const frame = () => { vectors.begin(); vectors.render(h.renderer, h.camera, [h.body]); vectors.end(); };
    return { ...h, vectors, changes, frame };
  }

  it('draws and indexes only the filtered features, and restores all of them when the filter clears', () => {
    const h = filtered();
    h.frame();
    expect(h.vectors.featureCount).toBe(3);
    h.vectors.setFeatureFilter('science', new Set(['number:1']));
    h.frame();
    expect(h.vectors.featureCount).toBe(1);
    expect(h.vectors.featureFilter('science')).toEqual(new Set(['number:1']));
    h.vectors.setFeatureFilter('science', new Set());
    h.frame();
    expect(h.vectors.featureCount).toBe(0);
    expect(h.vectors.metrics.batches).toBe(0);
    h.vectors.setFeatureFilter('science', null);
    h.frame();
    expect(h.vectors.featureCount).toBe(3);
    h.vectors.dispose(); h.universe.dispose();
  });

  it('reports visibility from the session override, else the catalog default', () => {
    const h = filtered();
    expect(h.vectors.isVisible('science')).toBe(true);
    h.vectors.setVisible('science', false);
    expect(h.vectors.isVisible('science')).toBe(false);
    h.universe.geographicLayers.get('science')!.definition.display = { visible: false };
    const fresh = new GeographicVectorLayer(h.universe, 1);
    expect(fresh.isVisible('science')).toBe(false);
    fresh.dispose(); h.vectors.dispose(); h.universe.dispose();
  });

  it.each([
    ['filtered out', (h: ReturnType<typeof filtered>) => h.vectors.setFeatureFilter('science', new Set(['number:1']))],
    ['hidden', (h: ReturnType<typeof filtered>) => h.vectors.setVisible('science', false)],
    ['unloaded', (h: ReturnType<typeof filtered>) => { h.universe.geographicLayers.removeCatalog('test'); h.universe.events.emit('geographic:changed', {}); }],
  ] as const)('clears and announces a selection whose feature is %s', (_, remove) => {
    const h = filtered();
    h.frame();
    h.vectors.setSelected(ref);
    h.vectors.setHovered(ref);
    expect(h.changes).toEqual([ref]);
    remove(h);
    h.frame();
    expect(h.vectors.selectedFeature).toBeNull();
    expect(h.changes).toEqual([ref, null]);
    h.vectors.dispose(); h.universe.dispose();
  });

  it('keeps a selection that remains shown and does not announce unchanged selections', () => {
    const h = filtered();
    h.frame();
    h.vectors.setSelected(ref);
    h.vectors.setSelected({ ...ref });
    h.vectors.setFeatureFilter('science', new Set(['number:0', 'number:2']));
    h.frame();
    expect(h.vectors.selectedFeature).toEqual(ref);
    expect(h.changes).toEqual([ref]);
    h.vectors.dispose(); h.universe.dispose();
  });
});

describe('geographic styles', () => {
  const mixed = () => layer([
    { type: 'Point', coordinates: [1, 1] },
    { type: 'LineString', coordinates: [[2, 2], [3, 3]] },
    { type: 'Polygon', coordinates: [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]] },
  ]);
  const roles = (index: GeographicIndex, role: string) => index.primitives.filter(p => p.role === role);

  it('draws the catalog defaults exactly as before styles existed', () => {
    const index = new GeographicIndex([mixed()]);
    expect(roles(index, 'point')[0]).toMatchObject({ size: 3.5, flags: 0, opacity: 1 });
    expect(roles(index, 'line')[0]).toMatchObject({ size: 1, flags: 0, opacity: 1 });
    expect(roles(index, 'outline')[0]).toMatchObject({ kind: 1, size: 1, opacity: 1 });
    expect(roles(index, 'fill')[0]).toMatchObject({ kind: 2, size: 0, opacity: 0.14 });
    expect(index.reachPx).toBe(4.5);
    const records = index.packRecords();
    expect([...records.slice(14, 16)]).toEqual([3.5, 0]);
  });

  it('encodes sizes, shapes and flags per geometry type', () => {
    const data = mixed();
    const index = new GeographicIndex([data], false, (l, f) => resolveGeographicStyle(l, {
      version: 1, point: { sizePx: 12, shape: 'diamond', halo: true }, line: { widthPx: 5, dashed: true, outline: true },
      polygon: { hatch: true, outlineWidthPx: 3, fillOpacity: 0.5 },
    }, f));
    expect(roles(index, 'point')[0]).toMatchObject({ size: 6, flags: VECTOR_FLAG.halo + 2 * VECTOR_SHAPE_STEP });
    expect(roles(index, 'line')[0]).toMatchObject({ size: 2.5, flags: VECTOR_FLAG.dashed + VECTOR_FLAG.halo });
    expect(roles(index, 'fill')[0]).toMatchObject({ flags: VECTOR_FLAG.hatch, opacity: 0.5 });
    expect(roles(index, 'outline')[0]).toMatchObject({ size: 1.5, flags: 0 });
    expect(index.reachPx).toBe(6 + 1 + VECTOR_HALO_PX);
  });

  it('restyles a drawing layer in place: same textures and program, new records, no rebuild', () => {
    const h = harness(mixed());
    const frame = () => { h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end(); };
    frame();
    const internal = h.vectors as unknown as { batches: { material: GeographicMaterial; index: GeographicIndex }[] };
    const [batch] = internal.batches;
    const records = batch.material.textures[0];
    const version = records.version;
    h.vectors.setStyle('science', { version: 1, point: { color: '#ff0000', sizePx: 16 } });
    frame();
    expect(internal.batches[0]).toBe(batch);
    expect(batch.material.textures[0]).toBe(records);
    expect(records.version).toBeGreaterThan(version);
    expect(h.vectors.metrics.restyles).toBe(1);
    const data = records.image.data as Float32Array;
    expect([data[8], data[9], data[10]]).toEqual([1, 0, 0]);
    expect(data[14]).toBe(8);
    expect(batch.material.uniforms.vectorReach.value).toBe(9);
    // Back to the catalog defaults.
    h.vectors.setStyle('science', null);
    expect(roles(batch.index, 'point')[0]).toMatchObject({ size: 3.5 });
    h.vectors.dispose(); h.universe.dispose();
  });

  it('overrides one feature only, and leaves source data untouched', () => {
    const data = mixed();
    const before = JSON.stringify(data.features);
    const index = new GeographicIndex([data], false, (l, f) => resolveGeographicStyle(l, { version: 1, features: { 'number:1': { color: '#000000', opacity: 0.5 } } }, f));
    expect(roles(index, 'line')[0]).toMatchObject({ color: [0, 0, 0], opacity: 0.5 });
    expect(roles(index, 'point')[0].opacity).toBe(1);
    expect(JSON.stringify(data.features)).toBe(before);
  });

  it('does not pick invisible parts, and picks wider marks from further away', () => {
    const data = layer([{ type: 'Point', coordinates: [0, 0] }]);
    const at = (index: GeographicIndex, px: number) => index.pick({ lonDeg: px * 0.0001, latDeg: 0 }, [0.0001, 0], [0, 0.0001]);
    const plain = new GeographicIndex([data]);
    expect(at(plain, 6)).toBeNull();
    const big = new GeographicIndex([data], false, (l, f) => resolveGeographicStyle(l, { version: 1, point: { sizePx: 16 } }, f));
    expect(at(big, 6)).toEqual(ref);
    const hidden = new GeographicIndex([data], false, (l, f) => resolveGeographicStyle(l, { version: 1, point: { opacity: 0 } }, f));
    expect(at(hidden, 0)).toBeNull();
  });

  it('orders layers sharing a body by the requested order', () => {
    const first = mixed();
    const second = { ...layer([{ type: 'Point', coordinates: [1, 1] }]), id: 'other' };
    const universe = new Universe();
    universe.geographicLayers.replaceCatalog('test', [first, second].map(l => ({ id: l.id, status: 'ready' as const, layer: l, source: l.source, diagnostics: [] })));
    const vectors = new GeographicVectorLayer(universe, 1);
    const order = () => { vectors.begin(); vectors.end(); return (vectors as unknown as { batches: { layers: GeographicLayer[] }[] }).batches[0].layers.map(l => l.id); };
    expect(order()).toEqual(['science', 'other']);
    vectors.setLayerOrder(['other']);
    expect(order()).toEqual(['other', 'science']);
    vectors.dispose(); universe.dispose();
  });

  it('draws and picks the user\'s own layers over published data unless ordered otherwise', () => {
    const catalog = mixed();
    const mine = { ...layer([{ type: 'Point', coordinates: [1, 1] }]), id: 'mine', ownership: 'user' as const };
    const universe = new Universe();
    universe.geographicLayers.replaceCatalog('test', [catalog, mine].map(l => ({ id: l.id, status: 'ready' as const, layer: l, source: l.source, diagnostics: [] })));
    const vectors = new GeographicVectorLayer(universe, 1);
    const order = () => { vectors.begin(); vectors.end(); return (vectors as unknown as { batches: { layers: GeographicLayer[] }[] }).batches[0].layers.map(l => l.id); };
    expect(order()).toEqual(['mine', 'science']);
    vectors.setLayerOrder(['science']);
    expect(order()).toEqual(['science', 'mine']);
    vectors.dispose(); universe.dispose();
  });
});

describe('geographic vectors over cross-fading terrain tiles', () => {
  /** Draw over one terrain tile, running each proxy's onBeforeRender as three would; the fade uniforms each draw used. */
  function drawOver(material: THREE.Material) {
    const h = harness(layer([{ type: 'Point', coordinates: [0, 0] }]));
    const tiles = new THREE.Group();
    tiles.add(new THREE.Mesh(h.mesh.geometry, material));
    tiles.updateMatrixWorld(true);
    h.mesh.visible = false;
    Object.assign(h.body, { terrainTileGroup: tiles });
    const used: [number, number][] = [];
    h.renderer.render = (scene) => {
      for (const child of scene.children) if (child.visible && child instanceof THREE.Mesh) {
        child.onBeforeRender(h.renderer, scene as THREE.Scene, h.camera, child.geometry, child.material, new THREE.Group());
        used.push([child.material.uniforms.vectorFadeIn.value, child.material.uniforms.vectorFadeOut.value]);
      }
    };
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    return { used, diagnostics: h.vectors.diagnostics };
  }

  it('draws over a fading tile with that tile\'s own fade, and over a settled one with none', async () => {
    // @ts-expect-error -- the library's own fade wrapper, which ships no type declarations
    const { wrapFadeMaterial } = await import('3d-tiles-renderer/src/three/plugins/fade/wrapFadeMaterial.js');
    const fading = new THREE.MeshBasicMaterial();
    const params = wrapFadeMaterial(fading, fading.onBeforeCompile);
    params.fadeIn.value = 1; params.fadeOut.value = 0.4;
    fading.defines!.FEATURE_FADE = 1;
    expect(drawOver(fading).used).toEqual([[1, 0.4]]);
    expect(drawOver(new THREE.MeshBasicMaterial()).used).toEqual([[1, 0]]);
  });

  it('reports a fading tile whose fade cannot be read instead of silently drawing over it twice', () => {
    const unknown = new THREE.MeshBasicMaterial();
    unknown.defines = { FEATURE_FADE: 1 };
    const { used, diagnostics } = drawOver(unknown);
    expect(used).toEqual([[1, 0]]);
    expect(diagnostics).toMatchObject([{ code: 'tile-fade-unreadable' }]);
  });
});
