import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import type { RendererContext } from '@cosmolabe/three';
import { IssArticulationPlugin, APPROXIMATE_LABEL, type JointSource } from './plugin.js';
import { ARRAY_JOINTS, arrayNormal } from './joints.js';
import { buildIssModel, buildNonIssModel } from './__fixtures__/build-model.js';

/** A minimal renderer context: bodies with positions and an optional model. */
function makeScene(models: Record<string, THREE.Object3D | null>, sunPos = new THREE.Vector3(1000, 0, 0)) {
  const meshes = new Map<string, { position: THREE.Vector3; modelContainer: THREE.Object3D | null; isModelVisible: boolean }>();
  meshes.set('Sun', { position: sunPos, modelContainer: null, isModelVisible: false });
  for (const [name, model] of Object.entries(models)) meshes.set(name, { position: new THREE.Vector3(0, 0, 0), modelContainer: model, isModelVisible: true });
  const bodies = Object.keys(models).map((name) => ({ name, geometryData: { type: 'Mesh' } }));
  const ctx = { universe: { getAllBodies: () => bodies }, getBodyMesh: (n: string) => meshes.get(n) } as unknown as RendererContext;
  return { ctx, meshes };
}

const wingNormalWorld = (model: THREE.Object3D) =>
  new THREE.Vector3(0, 1, 0).applyQuaternion(model.getObjectByName('23_S4_Truss_01')!.getWorldQuaternion(new THREE.Quaternion()));

describe('IssArticulationPlugin', () => {
  it('points the arrays at the Sun and labels the result as approximate', () => {
    const model = buildIssModel();
    model.quaternion.setFromEuler(new THREE.Euler(0.3, 0.9, -0.5));
    const { ctx } = makeScene({ ISS: model });
    const plugin = new IssArticulationPlugin();
    plugin.onSceneSetup(ctx);
    plugin.onBeforeRender(0, ctx);
    model.updateMatrixWorld(true);

    expect(wingNormalWorld(model).angleTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-9);
    expect(plugin.status('ISS')?.mode).toBe('approximate-sun-tracking');
    const section = plugin.ui.infoSections![0].render({ name: 'ISS' } as never, 0, ctx);
    expect(JSON.stringify(section)).toContain(APPROXIMATE_LABEL);
    expect(APPROXIMATE_LABEL).toBe('Approximate Sun tracking (not recorded ISS array positions)');
  });

  it('gives the same pose however the Sun moved to its position (no history, no smoothing)', () => {
    const run = (path: THREE.Vector3[]) => {
      const model = buildIssModel();
      const { ctx, meshes } = makeScene({ ISS: model });
      const plugin = new IssArticulationPlugin();
      plugin.onSceneSetup(ctx);
      for (const p of path) { meshes.get('Sun')!.position.copy(p); plugin.onBeforeRender(0, ctx); }
      return model.getObjectByName('23_S4_Truss')!.quaternion.clone();
    };
    const target = new THREE.Vector3(-300, 500, 800);
    const direct = run([target]);
    const wandering = run([new THREE.Vector3(1, 2, 3), new THREE.Vector3(0, -9, 1), new THREE.Vector3(7, 7, -7), target]);
    expect(direct.angleTo(wandering)).toBeLessThan(1e-12);
  });

  it('leaves a model without the ISS nodes alone and reports nothing for it', () => {
    const other = buildNonIssModel();
    const { ctx } = makeScene({ Other: other });
    const plugin = new IssArticulationPlugin();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    plugin.onSceneSetup(ctx);
    plugin.onBeforeRender(0, ctx);
    expect(plugin.status('Other')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('disables only articulation for a partly matching model and warns once', () => {
    const model = buildIssModel();
    model.getObjectByName('23_S4_Truss_01')!.removeFromParent();
    const { ctx } = makeScene({ ISS: model });
    const plugin = new IssArticulationPlugin();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    plugin.onSceneSetup(ctx);
    plugin.onBeforeRender(0, ctx); plugin.onBeforeRender(1, ctx);
    expect(plugin.status('ISS')).toMatchObject({ mode: 'disabled' });
    expect(plugin.status('ISS')?.diagnostic).toMatch(/no S4_01 Truss_01|no S4 Truss_01/);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('waits for the model to load, then articulates; a swapped model gets a fresh rig', () => {
    const { ctx, meshes } = makeScene({ ISS: null });
    const plugin = new IssArticulationPlugin();
    plugin.onSceneSetup(ctx);
    plugin.onBeforeRender(0, ctx);
    expect(plugin.status('ISS')).toBeUndefined();

    const first = buildIssModel();
    meshes.get('ISS')!.modelContainer = first;
    plugin.onBeforeRender(0, ctx);
    expect(plugin.status('ISS')?.mode).toBe('approximate-sun-tracking');

    const second = buildIssModel();
    meshes.get('ISS')!.modelContainer = second;
    plugin.onBeforeRender(0, ctx);
    // The old model is back at its authored pose; the new one is driven.
    expect(first.getObjectByName('23_S4_Truss')!.quaternion.angleTo(buildIssModel().getObjectByName('23_S4_Truss')!.quaternion)).toBeLessThan(1e-12);
    expect(second.getObjectByName('23_S4_Truss')!.quaternion.angleTo(buildIssModel().getObjectByName('23_S4_Truss')!.quaternion)).toBeGreaterThan(1e-3);
  });

  it('dispose restores the authored pose and forgets everything', () => {
    const model = buildIssModel();
    const authored = buildIssModel().getObjectByName('20_P4_Truss')!.quaternion.clone();
    const { ctx } = makeScene({ ISS: model });
    const plugin = new IssArticulationPlugin();
    plugin.onSceneSetup(ctx);
    plugin.onBeforeRender(0, ctx);
    expect(model.getObjectByName('20_P4_Truss')!.quaternion.angleTo(authored)).toBeGreaterThan(1e-3);
    plugin.dispose();
    expect(model.getObjectByName('20_P4_Truss')!.quaternion.angleTo(authored)).toBeLessThan(1e-12);
    expect(plugin.status('ISS')).toBeUndefined();
  });

  describe('observed joint source seam', () => {
    const angles = { truss: { S4: 0.8, P4: 0.8 }, arrays: Object.fromEntries(ARRAY_JOINTS.map((j) => [j, -0.3])) };
    const source = (valid: () => boolean): JointSource => ({ authority: 'observed', label: 'test feed', anglesAt: () => (valid() ? angles : undefined) });

    it('observed angles replace the approximation, and none competes with them', () => {
      const model = buildIssModel();
      const { ctx } = makeScene({ ISS: model });
      const plugin = new IssArticulationPlugin();
      plugin.onSceneSetup(ctx);
      plugin.setJointSource('ISS', source(() => true));
      plugin.onBeforeRender(0, ctx);
      const n = arrayNormal(0.8, -0.3);
      const world = new THREE.Vector3(...n).applyQuaternion(model.getWorldQuaternion(new THREE.Quaternion()));
      expect(wingNormalWorld(model).angleTo(world)).toBeLessThan(1e-9);
      expect(plugin.status('ISS')).toMatchObject({ mode: 'observed', sourceLabel: 'test feed' });
    });

    it('missing observations return the arrays to the authored pose and say so; never the approximation', () => {
      const model = buildIssModel();
      const authored = buildIssModel().getObjectByName('23_S4_Truss')!.quaternion.clone();
      const { ctx } = makeScene({ ISS: model });
      const plugin = new IssArticulationPlugin();
      plugin.onSceneSetup(ctx);
      let valid = true;
      plugin.setJointSource('ISS', source(() => valid));
      plugin.onBeforeRender(0, ctx);
      valid = false;
      plugin.onBeforeRender(1, ctx);
      expect(plugin.status('ISS')?.mode).toBe('observed-unavailable');
      expect(model.getObjectByName('23_S4_Truss')!.quaternion.angleTo(authored)).toBeLessThan(1e-12);
      expect(JSON.stringify(plugin.ui.infoSections![0].render({ name: 'ISS' } as never, 1, ctx))).toContain('Unavailable');
    });

    it('is bound to the named body only: another ISS-modelled body keeps the approximation', () => {
      const a = buildIssModel(), b = buildIssModel();
      const { ctx } = makeScene({ ISS: a, Other: b });
      const plugin = new IssArticulationPlugin();
      plugin.onSceneSetup(ctx);
      plugin.setJointSource('ISS', source(() => true));
      plugin.onBeforeRender(0, ctx);
      expect(plugin.status('ISS')?.mode).toBe('observed');
      expect(plugin.status('Other')?.mode).toBe('approximate-sun-tracking');
    });
  });
});
