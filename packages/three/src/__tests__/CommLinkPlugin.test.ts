import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Body, FixedPointTrajectory, Universe, HostDataAdapter, PLUGIN_DATA_COLORS, type HostData, type ContactWindow } from '@cosmolabe/core';
import { CommLinkPlugin } from '../plugins/stock/CommLinkPlugin.js';
import type { RendererContext } from '../plugins/RendererContext.js';

function fixture(blocked = false) {
  const universe = new Universe();
  for (const [name, position, radii] of [
    ['SC', [-2, 0, 0], undefined], ['station', [2, 0, 0], undefined],
    ['planet', [0, blocked ? 0 : 3, 0], [1, 1, 1]],
  ] as const) universe.addBody(new Body({ name, trajectory: new FixedPointTrajectory([...position]), radii: radii ? [...radii] : undefined }));
  const meshes = new Map(['SC', 'station'].map(name => {
    const mesh = new THREE.Object3D();
    mesh.position.fromArray(universe.absolutePositionOf(name, 0));
    return [name, mesh];
  }));
  const scene = new THREE.Scene();
  // This fixture exercises only the context members used by the stock plugin.
  const ctx = { scene, universe, getBodyMesh: (name: string) => meshes.get(name) } as unknown as RendererContext;
  const plugin = new CommLinkPlugin();
  plugin.setLinks([{ spacecraft: 'SC', station: 'station', startEt: 0, endEt: 100 }]);
  plugin.onSceneSetup(ctx);
  return { plugin, ctx, scene, meshes, universe };
}
const windows = [{ spacecraft: 'SC', station: 'station', startEt: 10, endEt: 20 }];
const adapter = new HostDataAdapter('astrolabe');
const supplied = (value: readonly ContactWindow[]) => adapter.supply(value, { id: 'contacts', kind: 'analysis' });
const line = (scene: THREE.Scene) => scene.children[0] as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;

describe('CommLink strategies', () => {
  it('draws exploratory links only with line of sight and within candidate bounds', () => {
    const { plugin, ctx, scene, universe } = fixture();
    plugin.onBeforeRender(0, ctx);
    expect(line(scene).visible).toBe(true);
    expect(line(scene).material.color.getHex()).toBe(PLUGIN_DATA_COLORS.exploratory);
    expect(plugin.data.authority).toBe('exploratory');
    plugin.onBeforeRender(101, ctx);
    expect(line(scene).visible).toBe(false);
    universe.getBody('planet')!.setTrajectory(new FixedPointTrajectory([0, 0, 0]));
    plugin.onBeforeRender(10, ctx);
    expect(line(scene).visible).toBe(false);
  });
  it('prefers host windows even when local geometry disagrees', () => {
    const { plugin, ctx, scene } = fixture(true);
    plugin.setContactWindows(supplied(windows));
    expect(plugin.data.authority).toBe('host');
    for (const et of [10, 20]) {
      plugin.onBeforeRender(et, ctx);
      expect(line(scene).visible).toBe(true);
    }
    expect(line(scene).material.color.getHex()).toBe(PLUGIN_DATA_COLORS.host);
    plugin.onBeforeRender(21, ctx);
    expect(line(scene).visible).toBe(false);
  });
  it('keeps an empty schedule empty and restores fallback only when removed', () => {
    const { plugin, ctx, scene } = fixture();
    plugin.setContactWindows(supplied([]));
    plugin.onBeforeRender(10, ctx);
    expect(scene.children).toHaveLength(0);
    plugin.setContactWindows(undefined);
    plugin.onBeforeRender(10, ctx);
    expect(line(scene).visible).toBe(true);
  });
  it('respects host validity, missing endpoints, and releases resources', () => {
    const { plugin, ctx, scene, meshes } = fixture();
    plugin.setContactWindows(adapter.supply(windows, { id: 'contacts', kind: 'analysis', validity: { startEt: 12, endEt: 18 } }));
    plugin.onBeforeRender(10, ctx);
    expect(line(scene).visible).toBe(false);
    meshes.delete('SC');
    plugin.onBeforeRender(15, ctx);
    expect(line(scene).visible).toBe(false);
    plugin.dispose();
    plugin.setContactWindows(supplied(windows));
    expect(scene.children).toHaveLength(0);
  });
  it('rejects malformed windows and cannot accept unadapted arrays', () => {
    const { plugin } = fixture();
    expect(() => plugin.setContactWindows(supplied([{ ...windows[0], startEt: 30 }]))).toThrow('Invalid contact window');
    // Compile-only negative API checks.
    // eslint-disable-next-line no-constant-condition
    if (false) {
      // @ts-expect-error Bare host authority lacks adapter issuance.
      const forged: HostData<readonly ContactWindow[]> = { authority: 'host', value: windows, provenance: { id: 'fake', kind: 'analysis' }, adapterId: 'fake' };
      plugin.setContactWindows(forged);
      // @ts-expect-error Host contact windows must come from an adapter.
      plugin.setContactWindows(windows);
    }
  });
});
