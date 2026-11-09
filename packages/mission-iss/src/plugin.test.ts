import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import type { RendererContext } from '@cosmolabe/three';
import { IssArticulationPlugin, APPROXIMATE_LABEL, usesIssModel, type JointSource, type JointSourceStatus } from './plugin.js';
import { ARRAY_JOINTS, arrayNormal } from './joints.js';
import { buildIssModel, buildNonIssModel } from './__fixtures__/build-model.js';

/** A minimal renderer context: bodies with positions and an optional model. */
function makeScene(models: Record<string, THREE.Object3D | null>, sunPos = new THREE.Vector3(1000, 0, 0)) {
  const meshes = new Map<string, { position: THREE.Vector3; modelContainer: THREE.Object3D | null; isModelVisible: boolean }>();
  meshes.set('Sun', { position: sunPos, modelContainer: null, isModelVisible: false });
  for (const [name, model] of Object.entries(models)) meshes.set(name, { position: new THREE.Vector3(0, 0, 0), modelContainer: model, isModelVisible: true });
  const bodies = Object.keys(models).map((name) => ({ name, geometryData: { type: 'Mesh', source: 'models/ISS_stationary.glb' } }));
  const ctx = { universe: { getAllBodies: () => bodies }, getBodyMesh: (n: string) => meshes.get(n) } as unknown as RendererContext;
  return { ctx, meshes };
}

const wingNormalWorld = (model: THREE.Object3D) =>
  new THREE.Vector3(0, 1, 0).applyQuaternion(model.getObjectByName('23_S4_Truss_01')!.getWorldQuaternion(new THREE.Quaternion()));

describe('usesIssModel', () => {
  const body = (geometryData: unknown) => ({ geometryData }) as never;
  it('matches the ISS glb mesh source and nothing else', () => {
    expect(usesIssModel(body({ type: 'Mesh', source: 'models/ISS_stationary.glb' }))).toBe(true);
    expect(usesIssModel(body({ type: 'Mesh', source: 'https://x.test/a/ISS_stationary.glb' }))).toBe(true);
    expect(usesIssModel(body({ type: 'Mesh', source: 'models/Cassini.glb' }))).toBe(false);
    expect(usesIssModel(body({ type: 'Globe', source: 'models/ISS_stationary.glb' }))).toBe(false);
    expect(usesIssModel(body(undefined))).toBe(false);
  });
});

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

  it('dispose is safe to call twice (renderer and universe each dispose their plugins)', () => {
    const model = buildIssModel();
    const { ctx } = makeScene({ ISS: model });
    const plugin = new IssArticulationPlugin();
    plugin.onSceneSetup(ctx);
    plugin.onBeforeRender(0, ctx);
    plugin.dispose();
    expect(() => plugin.dispose()).not.toThrow();
    plugin.onBeforeRender(0, ctx); // a late frame after disposal does nothing
    expect(plugin.status('ISS')).toBeUndefined();
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
    const source = (valid: () => boolean, status: () => JointSourceStatus = () => 'stale'): JointSource => ({ authority: 'observed', label: 'test feed', anglesAt: () => (valid() ? angles : undefined), status: () => (valid() ? 'live' : status()) });

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

    it('observed -> stale -> approximate Sun tracking -> observed, with a historical seek, never a frozen or authored pose', () => {
      const model = buildIssModel();
      const authored = buildIssModel().getObjectByName('23_S4_Truss')!.quaternion.clone();
      const { ctx } = makeScene({ ISS: model });
      const plugin = new IssArticulationPlugin();
      plugin.onSceneSetup(ctx);
      let status: JointSourceStatus = 'live';
      plugin.setJointSource('ISS', { authority: 'observed', label: 'test feed', anglesAt: () => (status === 'live' ? angles : undefined), status: () => status });
      const trussAngle = () => 2 * Math.atan2(model.getObjectByName('23_S4_Truss')!.quaternion.x, model.getObjectByName('23_S4_Truss')!.quaternion.w);
      const readout = () => JSON.stringify(plugin.ui.infoSections![0].render({ name: 'ISS' } as never, 0, ctx));

      plugin.onBeforeRender(0, ctx);
      expect(plugin.status('ISS')).toMatchObject({ mode: 'observed' });
      expect(trussAngle()).toBeCloseTo(0.8, 9);

      // Telemetry lost: the pose is the approximation (arrays aim at the Sun on +X), labelled with the telemetry status.
      for (const lost of ['stale', 'disconnected', 'unverified', 'not-current'] as const) {
        status = lost;
        plugin.onBeforeRender(1, ctx);
        model.updateMatrixWorld(true);
        expect(plugin.status('ISS')).toMatchObject({ mode: 'approximate-sun-tracking', telemetry: lost });
        expect(wingNormalWorld(model).angleTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-9);
        expect(model.getObjectByName('23_S4_Truss')!.quaternion.angleTo(authored)).toBeGreaterThan(1e-3);
        expect(readout()).toContain(APPROXIMATE_LABEL);
        expect(readout()).toContain(lost);
        expect(readout()).not.toContain('"Observed"');
      }

      status = 'live';
      plugin.onBeforeRender(2, ctx);
      expect(plugin.status('ISS')).toMatchObject({ mode: 'observed', telemetry: undefined });
      expect(trussAngle()).toBeCloseTo(0.8, 9);
    });

    it('a seek away from the sample is approximate (the source reports not-current), and back again is observed', () => {
      const model = buildIssModel();
      const { ctx } = makeScene({ ISS: model });
      const plugin = new IssArticulationPlugin();
      plugin.onSceneSetup(ctx);
      plugin.setJointSource('ISS', { authority: 'observed', label: 'test feed', anglesAt: (et) => (Math.abs(et - 1000) < 10 ? angles : undefined), status: (et) => (Math.abs(et - 1000) < 10 ? 'live' : 'not-current') });
      for (const [et, mode] of [[1000, 'observed'], [-5e8, 'approximate-sun-tracking'], [1005, 'observed'], [5e8, 'approximate-sun-tracking']] as const) {
        plugin.onBeforeRender(et, ctx);
        expect(plugin.status('ISS')?.mode).toBe(mode);
      }
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
