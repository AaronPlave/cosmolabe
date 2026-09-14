/**
 * Minimal quantized-mesh-1.0 reader for CPU terrain sampling.
 *
 * Only the vertex and index sections are read — enough to rebuild the tile's
 * triangulation. Quantized mesh is a TIN: its vertices are scattered and do
 * NOT form a regular U×V raster, so callers must interpolate across triangles
 * rather than index into a grid.
 *
 * Layout (little-endian), per the quantized-mesh-1.0 spec:
 *   0..87   header: center[3]f64, minHeight f32, maxHeight f32,
 *           boundingSphereCenter[3]f64, boundingSphereRadius f64,
 *           horizonOcclusionPoint[3]f64
 *   88      uint32 vertexCount
 *           uint16 u[], v[], height[]  — zigzag delta encoded
 *           (padding to index alignment)
 *           uint32 triangleCount
 *           uint16|uint32 indices[triangleCount * 3] — high-water-mark encoded
 */
export interface DecodedQuantizedMesh {
  /** Tile-local normalized coordinates in [0,1]: u west→east, v south→north. */
  u: Float32Array;
  v: Float32Array;
  /** Vertex height in metres above the tileset's own reference surface. */
  heightMeters: Float32Array;
  indices: Uint16Array | Uint32Array;
  minHeight: number;
  maxHeight: number;
}

const HEADER_BYTES = 88;

export function decodeQuantizedMesh(buffer: ArrayBuffer): DecodedQuantizedMesh {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER_BYTES + 4) {
    throw new Error('quantized-mesh buffer is shorter than its header');
  }
  const minHeight = view.getFloat32(24, true);
  const maxHeight = view.getFloat32(28, true);

  let offset = HEADER_BYTES;
  const vertexCount = view.getUint32(offset, true); offset += 4;
  const vertexBytes = vertexCount * 2;
  if (offset + vertexBytes * 3 > buffer.byteLength) {
    throw new Error(`quantized-mesh vertex data overruns buffer (vertexCount=${vertexCount})`);
  }

  const u = new Float32Array(vertexCount);
  const v = new Float32Array(vertexCount);
  const heightMeters = new Float32Array(vertexCount);
  const uBase = offset, vBase = offset + vertexBytes, hBase = offset + vertexBytes * 2;
  const range = maxHeight - minHeight;
  let uValue = 0, vValue = 0, hValue = 0;
  for (let i = 0; i < vertexCount; i++) {
    const ue = view.getUint16(uBase + i * 2, true);
    const ve = view.getUint16(vBase + i * 2, true);
    const he = view.getUint16(hBase + i * 2, true);
    // zigzag decode, then prefix-sum the deltas
    uValue += (ue >> 1) ^ (-(ue & 1));
    vValue += (ve >> 1) ^ (-(ve & 1));
    hValue += (he >> 1) ^ (-(he & 1));
    u[i] = uValue / 32767;
    v[i] = vValue / 32767;
    heightMeters[i] = minHeight + (hValue / 32767) * range;
  }
  offset = hBase + vertexBytes;

  // Indices are padded to their own element alignment.
  const bytesPerIndex = vertexCount > 65536 ? 4 : 2;
  const misalign = offset % bytesPerIndex;
  if (misalign !== 0) offset += bytesPerIndex - misalign;
  if (offset + 4 > buffer.byteLength) {
    throw new Error('quantized-mesh index section is missing');
  }
  const triangleCount = view.getUint32(offset, true); offset += 4;
  const indexCount = triangleCount * 3;
  if (offset + indexCount * bytesPerIndex > buffer.byteLength) {
    throw new Error(`quantized-mesh index data overruns buffer (triangleCount=${triangleCount})`);
  }

  const indices = bytesPerIndex === 4 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  // High-water-mark decoding: each code is a backwards offset from the highest
  // vertex index seen so far, and a zero code advances the watermark.
  let highest = 0;
  for (let i = 0; i < indexCount; i++) {
    const code = bytesPerIndex === 4
      ? view.getUint32(offset + i * 4, true)
      : view.getUint16(offset + i * 2, true);
    indices[i] = highest - code;
    if (code === 0) highest++;
  }

  return { u, v, heightMeters, indices, minHeight, maxHeight };
}
