/**
 * Type predicates for three.js objects that use duck-typing instead of
 * `instanceof THREE.*`.
 *
 * Why: `instanceof` fails silently when a consuming app and cosmolabe end up
 * with two physical copies of the `three` module (common with `file:`
 * dependencies in monorepos / sibling checkouts that share a single THREE
 * version but don't dedupe). Three.js sets a stable `.isMesh` / `.isLine` /
 * `.isMeshBasicMaterial` etc. boolean flag on each class's prototype precisely
 * for this purpose. Use these helpers everywhere so cross-package boundary
 * issues never silently disable rendering features.
 *
 * @see https://threejs.org/docs/#manual/en/introduction/FAQ
 */
import type * as THREE from 'three';

export function isMesh(o: THREE.Object3D): o is THREE.Mesh {
  return (o as Partial<THREE.Mesh>).isMesh === true;
}

export function isLine(o: THREE.Object3D): o is THREE.Line {
  return (o as Partial<THREE.Line>).isLine === true;
}

export function isPoints(o: THREE.Object3D): o is THREE.Points {
  return (o as Partial<THREE.Points>).isPoints === true;
}

export function isSprite(o: THREE.Object3D): o is THREE.Sprite {
  return (o as Partial<THREE.Sprite>).isSprite === true;
}

export function isMeshBasicMaterial(m: THREE.Material): m is THREE.MeshBasicMaterial {
  return (m as Partial<THREE.MeshBasicMaterial>).isMeshBasicMaterial === true;
}
