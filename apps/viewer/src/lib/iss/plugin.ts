/**
 * Trusted built-in renderer plugin that articulates the NASA ISS model (#370).
 *
 * It attaches to whatever catalog body's loaded model carries the ISS truss and
 * array nodes (the rig verifies them; any other model is left alone), and each
 * frame sets joint angles from one of two authorities:
 *
 *  - the **approximate** mode: arrays pointed at the Sun from the current
 *    scene geometry. A pure function of the current state, so seeking and
 *    reverse playback land on the same pose and nothing smooths over time.
 *    It is explicitly *not* recorded or commanded ISS joint state.
 *  - an **observed** `JointSource` a host registers for a named body (the
 *    live-data seam of #371). While the source has no valid angles the arrays
 *    return to their authored pose and the readout says so; the approximation
 *    never quietly stands in for missing observations.
 *
 * No catalog code is executed: a catalog only supplies the model it already
 * had. Scene disposal restores every joint it moved.
 */
import * as THREE from 'three';
import type { Body } from '@cosmolabe/core';
import type { InfoSectionResult, PluginUISlots, RendererContext, RendererPlugin } from '@cosmolabe/three';
import { sunTrackingJointAngles, type IssJointAngles } from './joints.js';
import { IssRig } from './rig.js';

/** A host-supplied source of joint angles for one body. */
export interface JointSource {
  /** `observed` for real telemetry; shown in the readout. */
  readonly authority: 'observed';
  /** One-line provenance for the info section, e.g. "NASA ISS Live (Lightstreamer)". */
  readonly label: string;
  /** Angles valid at `et`, or `undefined` when there is no valid observation. */
  anglesAt(et: number): IssJointAngles | undefined;
}

export type ArticulationMode =
  /** Arrays aimed at the Sun from scene geometry; not recorded ISS state. */
  | 'approximate-sun-tracking'
  /** Driven by a registered observed source. */
  | 'observed'
  /** An observed source is registered but has no valid angles; arrays at authored pose. */
  | 'observed-unavailable'
  /** The model lacks the expected nodes; the model draws as authored. */
  | 'disabled';

export interface ArticulationStatus {
  readonly bodyName: string;
  readonly mode: ArticulationMode;
  readonly diagnostic?: string;
  readonly sourceLabel?: string;
}

interface Binding {
  container: THREE.Object3D;
  rig?: IssRig;
  diagnostic?: string;
  /** Not the ISS model: no status, no readout. */
  silent: boolean;
  mode: ArticulationMode;
}

/** Statement the readout shows for the approximation. */
export const APPROXIMATE_LABEL = 'Approximate Sun tracking (not recorded ISS array positions)';

const scratchSun = new THREE.Vector3();
const scratchBody = new THREE.Vector3();
const scratchLocal = new THREE.Vector3();

export class IssArticulationPlugin implements RendererPlugin {
  readonly name = 'iss-articulation';

  private candidates: string[] = [];
  private readonly bindings = new Map<string, Binding>();
  private readonly sources = new Map<string, JointSource>();
  private readonly reported = new Set<string>();

  /** Register the observed source for one body; replaces any previous one. */
  setJointSource(bodyName: string, source: JointSource | undefined): void {
    if (source) this.sources.set(bodyName, source);
    else this.sources.delete(bodyName);
  }

  status(bodyName: string): ArticulationStatus | undefined {
    const b = this.bindings.get(bodyName);
    if (!b || b.silent) return undefined;
    return { bodyName, mode: b.mode, diagnostic: b.diagnostic, sourceLabel: this.sources.get(bodyName)?.label };
  }

  readonly ui: PluginUISlots = {
    infoSections: [
      {
        id: 'iss-articulation',
        label: 'Solar arrays',
        order: 20,
        render: (body: Body): InfoSectionResult | null => {
          const s = this.status(body.name);
          if (!s) return null;
          switch (s.mode) {
            case 'approximate-sun-tracking':
              return { rows: [{ label: 'Joint state', value: APPROXIMATE_LABEL }, { label: 'Model', value: 'NASA ISS 3D model' }] };
            case 'observed':
              return { rows: [{ label: 'Joint state', value: 'Observed' }, { label: 'Source', value: s.sourceLabel ?? 'host source' }] };
            case 'observed-unavailable':
              return { rows: [{ label: 'Joint state', value: 'Unavailable (arrays shown at authored pose)' }, { label: 'Source', value: s.sourceLabel ?? 'host source' }] };
            default:
              return { rows: [{ label: 'Joint state', value: 'Not articulated' }, ...(s.diagnostic ? [{ label: 'Reason', value: s.diagnostic }] : [])] };
          }
        },
      },
    ],
  };

  onSceneSetup(ctx: RendererContext): void {
    this.candidates = ctx.universe.getAllBodies()
      .filter((b) => (b.geometryData as { type?: string } | undefined)?.type === 'Mesh')
      .map((b) => b.name);
  }

  onBeforeRender(et: number, ctx: RendererContext): void {
    for (const name of this.candidates) {
      const mesh = ctx.getBodyMesh(name);
      const container = mesh?.modelContainer ?? null;
      let binding = this.bindings.get(name);
      if (!container) {
        // Model not loaded (yet), or removed: forget a rig whose nodes are gone.
        if (binding) { binding.rig?.restore(); this.bindings.delete(name); }
        continue;
      }
      if (!binding || binding.container !== container) {
        binding?.rig?.restore();
        binding = this.bind(name, container);
      }
      if (!binding.rig || !mesh || !mesh.isModelVisible) continue;
      this.drive(name, binding, mesh.position, et, ctx);
    }
  }

  dispose(): void {
    for (const b of this.bindings.values()) b.rig?.restore();
    this.bindings.clear();
    this.sources.clear();
    this.candidates = [];
  }

  private bind(name: string, container: THREE.Object3D): Binding {
    const { rig, diagnostic, notIss } = IssRig.attach(container);
    // Cached even when the model is not the ISS, so it is inspected once.
    const binding: Binding = { container, rig, diagnostic, silent: !!notIss, mode: rig ? 'approximate-sun-tracking' : 'disabled' };
    this.bindings.set(name, binding);
    if (diagnostic && !this.reported.has(name)) {
      this.reported.add(name);
      console.warn(`[Cosmolabe] ${name}: ${diagnostic}`);
    }
    return binding;
  }

  private drive(name: string, binding: Binding, bodyPos: THREE.Vector3, et: number, ctx: RendererContext): void {
    const rig = binding.rig!;
    const source = this.sources.get(name);
    if (source) {
      const angles = source.anglesAt(et);
      if (angles) {
        rig.apply(angles);
        binding.mode = 'observed';
      } else {
        rig.restore();
        binding.mode = 'observed-unavailable';
      }
      return;
    }
    const sun = ctx.getBodyMesh('Sun');
    scratchSun.copy(sun ? sun.position : scratchLocal.set(0, 0, 0));
    scratchBody.copy(bodyPos);
    const toSun = scratchSun.sub(scratchBody);
    if (toSun.lengthSq() === 0) return;
    const local = rig.directionToModel(toSun.normalize(), scratchLocal);
    const angles = sunTrackingJointAngles([local.x, local.y, local.z]);
    if (angles) rig.apply(angles);
    binding.mode = 'approximate-sun-tracking';
  }
}
