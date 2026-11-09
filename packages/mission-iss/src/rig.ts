/**
 * The ISS articulation rig: finds the real joint nodes of the NASA ISS model,
 * checks their pivots and axes, and rotates them (#370).
 *
 * Nothing here fakes articulation: only the named truss and solar-array nodes
 * move, about the axes `joints.ts` documents. Attaching verifies those
 * assumptions against the loaded model (rest rotation, pivot position, long
 * axis, parent-frame alignment) and refuses, with a bounded diagnostic, when
 * the model is not the one the conventions were inspected on. A refusal
 * disables articulation only; the model still draws as authored.
 */
import * as THREE from 'three';
import { ARRAY_JOINTS, TRUSS_JOINTS, type ArrayJoint, type IssJointAngles, type TrussJoint } from './joints.js';

type JointKind = 'truss' | 'array';

interface Joint {
  readonly id: string;
  readonly kind: JointKind;
  readonly node: THREE.Object3D;
  readonly axis: THREE.Vector3;
  /** The authored rotation, restored on `restore()`. */
  readonly rest: THREE.Quaternion;
}

export interface RigAttach {
  readonly rig?: IssRig;
  /** Why articulation is unavailable, when `rig` is absent. Bounded to one line. */
  readonly diagnostic?: string;
  /** True when none of the joint nodes exist: the model is simply not the ISS, so there is nothing to report. */
  readonly notIss?: boolean;
}

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const EPS = 1e-4;
const MAX_NAMED = 4;

/** three's GLTFLoader sanitises node names (spaces to underscores); compare in that form. */
const sanitize = (name: string): string => name.replace(/\s+/g, '_');

const TRUSS_NAME = /^(?:\d+_)?(S4|P4)_Truss$/;
const ARRAY_NAME = /^(?:\d+_)?(S4|S6|P4|P6)_Truss_0([12])$/;

/** First node (pre-order: a mesh group before its same-named primitives) matching a joint pattern. */
function findJointNodes(root: THREE.Object3D): { trusses: Map<TrussJoint, THREE.Object3D>; arrays: Map<ArrayJoint, THREE.Object3D> } {
  const trusses = new Map<TrussJoint, THREE.Object3D>();
  const arrays = new Map<ArrayJoint, THREE.Object3D>();
  root.traverse((object) => {
    const name = sanitize(object.name);
    const truss = TRUSS_NAME.exec(name);
    if (truss && !trusses.has(truss[1] as TrussJoint)) trusses.set(truss[1] as TrussJoint, object);
    const array = ARRAY_NAME.exec(name);
    const id = array ? (`${array[1]}_0${array[2]}` as ArrayJoint) : undefined;
    if (id && !arrays.has(id)) arrays.set(id, object);
  });
  return { trusses, arrays };
}

/** `object`'s world rotation relative to `root`'s. */
function relativeRotation(root: THREE.Object3D, object: THREE.Object3D): THREE.Quaternion {
  const rootQ = root.getWorldQuaternion(new THREE.Quaternion());
  return rootQ.invert().multiply(object.getWorldQuaternion(new THREE.Quaternion()));
}

const nearIdentity = (q: THREE.Quaternion, eps = EPS) => Math.abs(Math.abs(q.w) - 1) < eps;
/** Same orientation (q and -q are one rotation). */
const sameRotation = (a: THREE.Quaternion, b: THREE.Quaternion) => Math.abs(a.dot(b)) > 1 - EPS;

/** Bounds of a leaf node's geometry in the node's own axes. */
function localBounds(node: THREE.Object3D): THREE.Box3 {
  node.updateWorldMatrix(true, true);
  const toLocal = node.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  node.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox;
    if (b) box.union(b.clone().applyMatrix4(mesh.matrixWorld.clone().premultiply(toLocal)));
  });
  return box;
}

export class IssRig {
  private constructor(
    readonly root: THREE.Object3D,
    private readonly joints: readonly Joint[],
  ) {}

  /** Joint identifiers this rig drives, for diagnostics and tests. */
  get jointIds(): string[] {
    return this.joints.map((j) => j.id);
  }

  /**
   * Find and verify the joint nodes under `root` (the model's container).
   * `root` must already be placed so world matrices are meaningful; pivots
   * and axes are checked relative to it, so its own orientation and uniform
   * scale do not matter.
   */
  static attach(root: THREE.Object3D): RigAttach {
    root.updateWorldMatrix(true, true);
    const { trusses, arrays } = findJointNodes(root);

    if (trusses.size === 0 && arrays.size === 0) return { notIss: true };

    const missing = [
      ...TRUSS_JOINTS.filter((j) => !trusses.has(j)).map((j) => `${j} Truss`),
      ...ARRAY_JOINTS.filter((j) => !arrays.has(j)).map((j) => `${j.replace('_', ' Truss_')}`),
    ];
    if (missing.length) {
      const named = missing.slice(0, MAX_NAMED).join(', ');
      return { diagnostic: `ISS articulation unavailable: model has no ${named}${missing.length > MAX_NAMED ? ` and ${missing.length - MAX_NAMED} more` : ''}` };
    }

    const joints: Joint[] = [];
    for (const id of TRUSS_JOINTS) {
      const node = trusses.get(id)!;
      // The SARJ axis is the model's X: the rest rotation must be about it, and
      // the parent frame must be aligned with the model so a model-local Sun
      // direction is also a parent-local one.
      const q = node.quaternion;
      if (Math.abs(q.y) > EPS || Math.abs(q.z) > EPS) return { diagnostic: `ISS articulation unavailable: ${id} Truss rest rotation is not about the model X axis` };
      if (!node.parent || !nearIdentity(relativeRotation(root, node.parent))) {
        return { diagnostic: `ISS articulation unavailable: ${id} Truss parent frame is not aligned with the model axes` };
      }
      joints.push({ id: `truss:${id}`, kind: 'truss', node, axis: AXIS_X, rest: node.quaternion.clone() });
    }
    for (const id of ARRAY_JOINTS) {
      const node = arrays.get(id)!;
      if (!nearIdentity(node.quaternion)) return { diagnostic: `ISS articulation unavailable: ${id} has a non-zero rest rotation` };
      // Pivot and long axis: the array is a wing along +/-Z rooted at the node origin.
      const size = localBounds(node).getSize(new THREE.Vector3());
      const box = localBounds(node);
      const rootOffset = Math.min(Math.abs(box.min.z), Math.abs(box.max.z));
      if (!(size.z > 2 * size.x && size.x > size.y) || rootOffset > 0.05 * size.z) {
        return { diagnostic: `ISS articulation unavailable: ${id} geometry is not a wing along Z rooted at its pivot` };
      }
      // Its parent frame is the model's, turned by its truss's rest rotation.
      const truss = trusses.get(id.slice(0, 2) === 'S4' || id.slice(0, 2) === 'S6' ? 'S4' : 'P4')!;
      if (!node.parent || !sameRotation(relativeRotation(root, node.parent), relativeRotation(root, truss))) {
        return { diagnostic: `ISS articulation unavailable: ${id} parent frame does not follow its truss` };
      }
      joints.push({ id: `array:${id}`, kind: 'array', node, axis: AXIS_Z, rest: node.quaternion.clone() });
    }
    return { rig: new IssRig(root, joints) };
  }

  /** Set joint angles (radians about each joint's axis). Joints omitted keep their current pose. */
  apply(angles: IssJointAngles): void {
    for (const joint of this.joints) {
      const angle = joint.kind === 'truss'
        ? angles.truss?.[joint.id.slice(joint.id.indexOf(':') + 1) as TrussJoint]
        : angles.arrays?.[joint.id.slice(joint.id.indexOf(':') + 1) as ArrayJoint];
      if (angle === undefined || !Number.isFinite(angle)) continue;
      joint.node.quaternion.setFromAxisAngle(joint.axis, angle);
      joint.node.updateMatrix();
    }
  }

  /** Return every joint to its authored pose. */
  restore(): void {
    for (const joint of this.joints) {
      joint.node.quaternion.copy(joint.rest);
      joint.node.updateMatrix();
    }
  }

  /** Current angle about each joint's axis, radians; for tests and readouts. */
  angles(): { truss: Record<string, number>; arrays: Record<string, number> } {
    const out = { truss: {} as Record<string, number>, arrays: {} as Record<string, number> };
    for (const joint of this.joints) {
      const q = joint.node.quaternion;
      // Rotation about a single axis: angle = 2 * atan2(sin component, w).
      const s = joint.kind === 'truss' ? q.x : q.z;
      const angle = 2 * Math.atan2(s, q.w);
      (joint.kind === 'truss' ? out.truss : out.arrays)[joint.id.slice(joint.id.indexOf(':') + 1)] = angle;
    }
    return out;
  }

  /** The Sun (or any world direction) expressed in the model's own axes. */
  directionToModel(worldDirection: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    this.root.updateWorldMatrix(true, false);
    const q = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    return out.copy(worldDirection).applyQuaternion(q).normalize();
  }
}
