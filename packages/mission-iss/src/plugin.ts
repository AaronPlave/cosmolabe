/**
 * Renderer plugin that articulates the NASA ISS model (#370).
 *
 * It attaches to a catalog body whose loaded model carries the ISS truss and
 * array nodes (the rig verifies them; any other model is left alone). Each
 * frame it sets joint angles from one of two authorities:
 *
 *  - **observed**: a `JointSource` a host registered for the body (the
 *    live-data seam of #371), only while it reports valid, time-appropriate
 *    angles;
 *  - **approximate Sun tracking**: arrays aimed at the Sun from the current
 *    scene geometry, a pure function of the current state, so seeking and
 *    reverse playback land on the same pose and nothing smooths over time.
 *    Explicitly *not* recorded or commanded ISS joint state.
 *
 * Whenever observed angles are not available (no source, stale, disconnected,
 * unverified mapping, or a simulation time away from the sample), the pose is
 * the approximation, and the readout says why. It never freezes an old pose
 * and never touches the station's body attitude: only joint nodes move.
 *
 * No catalog code is executed. Disposal restores every joint it moved, and is
 * safe to call twice (renderer and universe both dispose their plugins).
 */
import * as THREE from 'three';
import type { Body } from '@cosmolabe/core';
import type { InfoSectionResult, PluginUISlots, RendererContext, RendererPlugin } from '@cosmolabe/three';
import { sunTrackingJointAngles, type IssJointAngles } from './joints.js';
import { IssRig } from './rig.js';

/** Why a joint source has no angles to apply at an epoch. */
export type JointSourceStatus = 'live' | 'stale' | 'disconnected' | 'unavailable' | 'unverified' | 'not-current';

/** A host-supplied source of observed joint angles for one body. */
export interface JointSource {
  readonly authority: 'observed';
  /** One-line provenance for the readout, e.g. "NASA ISS Live telemetry". */
  readonly label: string;
  /** Angles valid at `et`, or `undefined` when there is no valid observation. */
  anglesAt(et: number): IssJointAngles | undefined;
  /** Why `anglesAt(et)` is or is not usable, for the readout. */
  status(et: number): JointSourceStatus;
}

export type ArticulationMode =
  /** Arrays aimed at the Sun from scene geometry; not recorded ISS state. */
  | 'approximate-sun-tracking'
  /** Driven by registered, valid observed angles. */
  | 'observed'
  /** The model lacks the expected nodes; the model draws as authored. */
  | 'disabled';

export interface ArticulationStatus {
  readonly bodyName: string;
  readonly mode: ArticulationMode;
  readonly diagnostic?: string;
  readonly sourceLabel?: string;
  /** Why observed angles are not in use, when a source is registered and `mode` is approximate. */
  readonly telemetry?: JointSourceStatus;
}

interface Binding {
  container: THREE.Object3D;
  rig?: IssRig;
  diagnostic?: string;
  /** Not the ISS model: no status, no readout. */
  silent: boolean;
  mode: ArticulationMode;
  telemetry?: JointSourceStatus;
}

/** Statement the readout shows for the approximation. */
export const APPROXIMATE_LABEL = 'Approximate Sun tracking (not recorded ISS array positions)';

/** Catalog `Mesh` source of the NASA ISS model this plugin knows (inspected node layout). */
const ISS_MODEL = /(?:^|[\\/])ISS_stationary\.glb$/i;

/** Does this body draw the ISS model? Cheap, data-only; the rig still verifies the nodes. */
export function usesIssModel(body: Body): boolean {
  const geometry = body.geometryData as { type?: string; source?: unknown } | undefined;
  return geometry?.type === 'Mesh' && typeof geometry.source === 'string' && ISS_MODEL.test(geometry.source);
}

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
    return { bodyName, mode: b.mode, diagnostic: b.diagnostic, sourceLabel: this.sources.get(bodyName)?.label, telemetry: b.telemetry };
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
            case 'observed':
              return { rows: [{ label: 'Joint state', value: 'Observed' }, { label: 'Source', value: s.sourceLabel ?? 'host source' }] };
            case 'approximate-sun-tracking':
              return { rows: [
                { label: 'Joint state', value: APPROXIMATE_LABEL },
                ...(s.telemetry ? [{ label: 'Live telemetry', value: s.telemetry }] : []),
                { label: 'Model', value: 'NASA ISS 3D model' },
              ] };
            default:
              return { rows: [{ label: 'Joint state', value: 'Not articulated' }, ...(s.diagnostic ? [{ label: 'Reason', value: s.diagnostic }] : [])] };
          }
        },
      },
    ],
  };

  onSceneSetup(ctx: RendererContext): void {
    this.candidates = ctx.universe.getAllBodies().filter(usesIssModel).map((b) => b.name);
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
      if (!binding.rig || !mesh) continue;
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
        binding.telemetry = undefined;
        return;
      }
      binding.telemetry = source.status(et);
    } else {
      binding.telemetry = undefined;
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
