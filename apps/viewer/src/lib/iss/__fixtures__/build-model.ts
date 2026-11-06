/**
 * Build a three.js hierarchy with the real ISS model's node names, rest
 * transforms and geometry bounds (from `iss-node-tree.json`, extracted from
 * the NASA glb by extract-node-tree.mjs). Geometry is a box per
 * node over the true bounds: enough for pivot/axis checks, none of the 44 MB.
 * Names are sanitised as GLTFLoader does (spaces to underscores).
 */
import * as THREE from 'three';
import tree from './iss-node-tree.json';

interface TreeNode {
  name: string;
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  bounds?: { min: number[]; max: number[] };
  children?: TreeNode[];
}

function build(n: TreeNode): THREE.Object3D {
  const object = new THREE.Object3D();
  object.name = n.name.replace(/\s+/g, '_');
  if (n.translation) object.position.fromArray(n.translation);
  if (n.rotation) object.quaternion.fromArray(n.rotation).normalize(); // fixture values are rounded
  if (n.scale) object.scale.fromArray(n.scale);
  if (n.bounds) {
    const size = n.bounds.max.map((v, k) => v - n.bounds!.min[k]);
    const center = n.bounds.max.map((v, k) => (v + n.bounds!.min[k]) / 2);
    const geometry = new THREE.BoxGeometry(Math.max(size[0], 1e-6), Math.max(size[1], 1e-6), Math.max(size[2], 1e-6));
    geometry.translate(center[0], center[1], center[2]);
    object.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  }
  for (const c of n.children ?? []) object.add(build(c));
  return object;
}

/** A container like the viewer's `modelContainer`: the model's axes, ready for placement. */
export function buildIssModel(): THREE.Group {
  const root = new THREE.Group();
  for (const r of (tree as { roots: TreeNode[] }).roots) root.add(build(r));
  root.updateMatrixWorld(true);
  return root;
}

/** A model with the ISS articulation nodes absent. */
export function buildNonIssModel(): THREE.Group {
  const root = new THREE.Group();
  const hull = new THREE.Object3D();
  hull.name = 'Hull';
  root.add(hull);
  return root;
}
