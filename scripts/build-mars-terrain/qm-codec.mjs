/**
 * Cesium quantized-mesh-1.0 codec.
 *
 * Spec: https://github.com/CesiumGS/quantized-mesh
 *
 * Layout (little-endian):
 *  Header (88 bytes):
 *    f64 centerX, centerY, centerZ              (24)
 *    f32 minHeight, maxHeight                    ( 8)
 *    f64 boundingSphereCenterX, Y, Z, radius     (32)
 *    f64 horizonOcclusionX, Y, Z                 (24)
 *  u32 vertexCount
 *  u16[vertexCount] u-buffer    (zigzag-delta encoded)
 *  u16[vertexCount] v-buffer
 *  u16[vertexCount] h-buffer
 *  -- 2-byte align if total vertex-section bytes is odd (vertexCount > 65536 case) --
 *  u32 triangleCount
 *  indices (high-water-mark encoded, u16 if vertexCount <= 65536, else u32)
 *  u32 westVertexCount;  westIndices[u16|u32]
 *  u32 southVertexCount; southIndices[u16|u32]
 *  u32 eastVertexCount;  eastIndices[u16|u32]
 *  u32 northVertexCount; northIndices[u16|u32]
 *  optional extensions (extensionId u8, extensionLength u32, data[extensionLength])...
 *
 * Notes
 *  - u, v, h are 16-bit integers in [0, 32767]. u/v map linearly to tile's
 *    geographic bounds; h maps linearly to [minHeight, maxHeight].
 *  - Edge index arrays are *raw* indices into the vertex array (NOT high-
 *    water encoded), in increasing perpendicular-axis order. The renderer
 *    uses them for skirt construction.
 */

function zigzagDecode(n) { return (n >>> 1) ^ -(n & 1); }
function zigzagEncode(n) { return (n << 1) ^ (n >> 31); }

/**
 * Decode a quantized-mesh tile (uncompressed bytes — caller is responsible
 * for gunzipping any .terrain file).
 * @returns object with fields: header, vertexCount, u, v, h, triangles,
 *   westIndices, southIndices, eastIndices, northIndices, extensions.
 *   `u`, `v`, `h` are absolute (post-delta-decode) Uint16Arrays.
 *   `triangles` is a flat Uint32Array of length triangleCount*3.
 *   `extensions` is an array of { id, data: Uint8Array } pass-through blobs.
 */
export function decodeTile(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;

  const header = {
    centerX: dv.getFloat64(off, true), centerY: dv.getFloat64(off + 8, true), centerZ: dv.getFloat64(off + 16, true),
    minHeight: dv.getFloat32(off + 24, true), maxHeight: dv.getFloat32(off + 28, true),
    sphereCenterX: dv.getFloat64(off + 32, true), sphereCenterY: dv.getFloat64(off + 40, true), sphereCenterZ: dv.getFloat64(off + 48, true),
    sphereRadius: dv.getFloat64(off + 56, true),
    horizonOcclusionX: dv.getFloat64(off + 64, true), horizonOcclusionY: dv.getFloat64(off + 72, true), horizonOcclusionZ: dv.getFloat64(off + 80, true),
  };
  off = 88;

  const vertexCount = dv.getUint32(off, true);
  off += 4;

  const u = new Uint16Array(vertexCount);
  const v = new Uint16Array(vertexCount);
  const h = new Uint16Array(vertexCount);
  let acc = 0;
  for (let i = 0; i < vertexCount; i++) { acc = (acc + zigzagDecode(dv.getUint16(off + 2 * i, true))) & 0xffff; u[i] = acc; }
  off += 2 * vertexCount;
  acc = 0;
  for (let i = 0; i < vertexCount; i++) { acc = (acc + zigzagDecode(dv.getUint16(off + 2 * i, true))) & 0xffff; v[i] = acc; }
  off += 2 * vertexCount;
  acc = 0;
  for (let i = 0; i < vertexCount; i++) { acc = (acc + zigzagDecode(dv.getUint16(off + 2 * i, true))) & 0xffff; h[i] = acc; }
  off += 2 * vertexCount;

  // Index section: aligned to 4-byte boundary if vertexCount > 65536 (u32 indices)
  const big = vertexCount > 65536;
  if (big && (off & 3) !== 0) off += 4 - (off & 3);

  const triangleCount = dv.getUint32(off, true);
  off += 4;
  const triCount = triangleCount * 3;
  const triangles = new Uint32Array(triCount);
  let highest = 0;
  for (let i = 0; i < triCount; i++) {
    const code = big ? dv.getUint32(off, true) : dv.getUint16(off, true);
    off += big ? 4 : 2;
    triangles[i] = (highest - code) & 0xffffffff;
    if (code === 0) highest++;
  }

  function readEdge() {
    const count = dv.getUint32(off, true); off += 4;
    const arr = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      arr[i] = big ? dv.getUint32(off, true) : dv.getUint16(off, true);
      off += big ? 4 : 2;
    }
    return arr;
  }
  const westIndices = readEdge();
  const southIndices = readEdge();
  const eastIndices = readEdge();
  const northIndices = readEdge();

  const extensions = [];
  while (off < buf.byteLength) {
    const id = dv.getUint8(off); off += 1;
    const length = dv.getUint32(off, true); off += 4;
    const data = new Uint8Array(buf.buffer, buf.byteOffset + off, length);
    extensions.push({ id, data });
    off += length;
  }

  return { header, vertexCount, u, v, h, triangles, westIndices, southIndices, eastIndices, northIndices, extensions };
}

/**
 * Encode a tile object back to bytes.
 * Caller must supply: header, u/v/h (each length=vertexCount, values in
 * [0, 32767]), triangles (flat indices in [0, vertexCount-1]),
 * west/south/east/north edge index arrays, and optional `extensions`.
 *
 * Does NOT preserve original byte-for-byte form — re-encodes triangles with
 * the canonical high-water-mark order they're given in. For round-trip
 * verification compare decoded fields, not raw bytes.
 */
export function encodeTile(tile) {
  const { header, u, v, h, triangles, westIndices, southIndices, eastIndices, northIndices, extensions = [] } = tile;
  const vertexCount = u.length;
  if (v.length !== vertexCount || h.length !== vertexCount) throw new Error('u/v/h length mismatch');

  const big = vertexCount > 65536;
  const indexBytes = big ? 4 : 2;

  // Compute size
  let extBytes = 0;
  for (const ext of extensions) extBytes += 1 + 4 + ext.data.byteLength;

  let vertexSecBytes = 4 + 2 * vertexCount * 3; // vertexCount + u + v + h
  let postVertexOff = 88 + vertexSecBytes;
  let alignPad = 0;
  if (big && (postVertexOff & 3) !== 0) alignPad = 4 - (postVertexOff & 3);

  const triCount = triangles.length;
  const triBytes = 4 + triCount * indexBytes;
  const edgeBytes = 4 * 4 + (westIndices.length + southIndices.length + eastIndices.length + northIndices.length) * indexBytes;
  const totalBytes = 88 + vertexSecBytes + alignPad + triBytes + edgeBytes + extBytes;

  const buf = new Uint8Array(totalBytes);
  const dv = new DataView(buf.buffer);
  let off = 0;

  // Header
  dv.setFloat64(0, header.centerX, true);
  dv.setFloat64(8, header.centerY, true);
  dv.setFloat64(16, header.centerZ, true);
  dv.setFloat32(24, header.minHeight, true);
  dv.setFloat32(28, header.maxHeight, true);
  dv.setFloat64(32, header.sphereCenterX, true);
  dv.setFloat64(40, header.sphereCenterY, true);
  dv.setFloat64(48, header.sphereCenterZ, true);
  dv.setFloat64(56, header.sphereRadius, true);
  dv.setFloat64(64, header.horizonOcclusionX, true);
  dv.setFloat64(72, header.horizonOcclusionY, true);
  dv.setFloat64(80, header.horizonOcclusionZ, true);
  off = 88;

  // Vertex count
  dv.setUint32(off, vertexCount, true); off += 4;

  // u, v, h — delta + zigzag
  function writeDeltaZigzag(arr) {
    let prev = 0;
    for (let i = 0; i < vertexCount; i++) {
      let delta = arr[i] - prev;
      // Wrap into signed-16 range if needed (shouldn't happen for valid 0..32767 inputs).
      if (delta > 32767) delta -= 65536; else if (delta < -32768) delta += 65536;
      const zz = zigzagEncode(delta) & 0xffff;
      dv.setUint16(off, zz, true);
      off += 2;
      prev = arr[i];
    }
  }
  writeDeltaZigzag(u);
  writeDeltaZigzag(v);
  writeDeltaZigzag(h);

  if (alignPad) off += alignPad;

  // Triangle count
  dv.setUint32(off, triCount / 3, true); off += 4;

  // Triangle indices (high-water mark)
  let highest = 0;
  for (let i = 0; i < triCount; i++) {
    const idx = triangles[i];
    const code = highest - idx;
    if (code < 0) throw new Error(`triangle index ${idx} > highWaterMark ${highest} — triangle order invalid for HWM encoding`);
    if (big) { dv.setUint32(off, code, true); off += 4; }
    else { dv.setUint16(off, code, true); off += 2; }
    if (code === 0) highest++;
  }

  // Edge indices (raw)
  function writeEdge(arr) {
    dv.setUint32(off, arr.length, true); off += 4;
    for (let i = 0; i < arr.length; i++) {
      if (big) { dv.setUint32(off, arr[i], true); off += 4; }
      else { dv.setUint16(off, arr[i], true); off += 2; }
    }
  }
  writeEdge(westIndices);
  writeEdge(southIndices);
  writeEdge(eastIndices);
  writeEdge(northIndices);

  // Extensions
  for (const ext of extensions) {
    dv.setUint8(off, ext.id); off += 1;
    dv.setUint32(off, ext.data.byteLength, true); off += 4;
    buf.set(ext.data, off);
    off += ext.data.byteLength;
  }

  if (off !== totalBytes) throw new Error(`encode size mismatch: wrote ${off}, expected ${totalBytes}`);
  return buf;
}

/**
 * Re-order triangles so the index order is valid for high-water-mark
 * encoding. The HWM encoder requires each new index to be no greater than
 * the running max-so-far + 1.
 *
 * Algorithm: greedy DFS / max-encountered pass. Walk triangles in input
 * order; if a triangle introduces an index > currentMax + 1, rotate
 * triangles within its set so the earliest unencountered index is bumped
 * one at a time. Simpler approach used here: walk triangles and emit them
 * in their natural index-traversal order, swapping triangle-internal indices
 * so the smallest unseen comes first — this is a known O(n) reordering for
 * QM HWM.
 *
 * Reference: Cesium's `cesium-terrain-tools` packToQuantizedMesh equivalent.
 */
export function reorderTrianglesForHWM(triangles) {
  const out = new Uint32Array(triangles.length);
  // We can simply remap vertex indices to the order they first appear in
  // triangle traversal — this guarantees HWM monotonicity.
  // Build forward map: vertex index -> emit order. Use original index as
  // fallback when we want to keep vertex array order unchanged (caller's
  // job).
  let highest = 0;
  const seen = new Int32Array(triangles.length); seen.fill(-1);
  // Find max index used
  let maxIdx = 0;
  for (let i = 0; i < triangles.length; i++) if (triangles[i] > maxIdx) maxIdx = triangles[i];
  const remap = new Int32Array(maxIdx + 1); remap.fill(-1);
  let nextLabel = 0;
  for (let i = 0; i < triangles.length; i++) {
    const v = triangles[i];
    if (remap[v] === -1) remap[v] = nextLabel++;
    out[i] = remap[v];
  }
  return { triangles: out, remap, vertexCount: nextLabel };
}

/**
 * Recompute edge index arrays from u/v: vertices on each edge are those
 * with the extreme coord (0 or 32767), sorted by the perpendicular coord.
 * The QM spec calls for west/south indices in ascending order and
 * east/north in ascending order too (sort by perpendicular).
 */
export function recomputeEdges(u, v) {
  const n = u.length;
  const west = [], south = [], east = [], north = [];
  for (let i = 0; i < n; i++) {
    if (u[i] === 0) west.push(i);
    if (v[i] === 0) south.push(i);
    if (u[i] === 32767) east.push(i);
    if (v[i] === 32767) north.push(i);
  }
  west.sort((a, b) => v[a] - v[b]);
  east.sort((a, b) => v[a] - v[b]);
  south.sort((a, b) => u[a] - u[b]);
  north.sort((a, b) => u[a] - u[b]);
  return {
    westIndices: new Uint32Array(west),
    southIndices: new Uint32Array(south),
    eastIndices: new Uint32Array(east),
    northIndices: new Uint32Array(north),
  };
}
