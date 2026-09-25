// The SPICE capability a `Dsk` geometry needs: reading a DSK's plate model.
//
// Same shape as InstrumentFovProvider: core's SpiceInstance carries only what
// core calls, and core never reads a shape model — the renderer does, to draw
// one. So the renderer declares the one routine it needs and narrows the
// injected engine to it where it is used. @cosmolabe/frames' heritage adapter
// satisfies it structurally.

import * as THREE from 'three';

/** A DSK read as one triangle mesh: vertices in km in the body-fixed frame. */
export interface DskShape {
  /** Flat x,y,z vertex coordinates (km, body-fixed), length 3 * nv. */
  readonly vertices: ArrayLike<number>;
  /** Flat 0-based triangle vertex indices, length 3 * np. */
  readonly plates: ArrayLike<number>;
  /** NAIF ID of the body the shape describes. */
  readonly centerId: number;
  /** Name of the body-fixed frame the vertices are in; empty if the kernels do not name it. */
  readonly frame: string;
}

/** An engine that can read a DSK's plate model from its bytes. */
export interface DskShapeProvider {
  readDsk(name: string, bytes: Uint8Array): DskShape;
}

/** Narrow an injected engine to the DSK capability, or null if it has none. */
export function dskShapeProviderOf(spice: unknown): DskShapeProvider | null {
  return spice != null && typeof (spice as DskShapeProvider).readDsk === 'function'
    ? (spice as DskShapeProvider)
    : null;
}

/**
 * Build an indexed BufferGeometry from a DSK shape.
 *
 * Positions stay in km, in the body-fixed frame, with no recentering: the
 * frame's origin is the body's centre of mass, which is where the body's
 * trajectory puts it, so moving the mesh would misplace the surface. Float32 is
 * ample at small-body scale (sub-millimetre at 10 km). DSK plates wind
 * counter-clockwise seen from outside, which is Three.js's front face.
 *
 * Vertex normals are averaged over the plates sharing each vertex, which reads
 * well on the moderate-resolution models a scene loads by default.
 */
export function dskToBufferGeometry(shape: DskShape): THREE.BufferGeometry {
  const nv = shape.vertices.length / 3;
  if (!Number.isInteger(nv) || shape.plates.length % 3 !== 0) {
    throw new Error(`DSK shape is malformed: ${shape.vertices.length} vertex values, ${shape.plates.length} plate indices`);
  }
  for (let i = 0; i < shape.plates.length; i++) {
    const idx = shape.plates[i]!;
    if (idx < 0 || idx >= nv) throw new Error(`DSK plate index ${idx} is outside 0..${nv - 1}`);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(shape.vertices), 3));
  const IndexArray = nv > 65535 ? Uint32Array : Uint16Array;
  geometry.setIndex(new THREE.BufferAttribute(IndexArray.from(shape.plates), 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Undo gzip transport compression, recognised by magic bytes rather than by name. */
export async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
