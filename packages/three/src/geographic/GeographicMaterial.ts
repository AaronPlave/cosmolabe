import * as THREE from 'three';
import { GeographicIndex, VECTOR_CELL_LIMIT, VECTOR_RENDER_PAGE_LIMIT, VECTOR_GRID, VECTOR_DETAIL_GRIDS, VECTOR_PADDING_DEG, VECTOR_SHAPE_STEP, VECTOR_HALO_PX } from './GeographicIndex.js';

const DETAIL_LEVELS = VECTOR_DETAIL_GRIDS.length + 1;
/** How many times a pixel's footprint on the ellipsoid's tangent plane a derivative may be before it is taken for a silhouette. */
const SILHOUETTE = 2;
/** How much farther a mark may reach along a pixel's long ground footprint than across it (grazing views). */
const ANISOTROPY = 12;
const detailSlots = Array.from({ length: DETAIL_LEVELS });

function texture(data: Float32Array, width = Math.min(1024, Math.max(1, data.length / 4))): THREE.DataTexture {
  const height = Math.max(1, Math.ceil(data.length / 4 / width));
  const padded = new Float32Array(width * height * 4);
  padded.set(data);
  const result = new THREE.DataTexture(padded, width, height, THREE.RGBAFormat, THREE.FloatType);
  result.minFilter = result.magFilter = THREE.NearestFilter;
  result.needsUpdate = true;
  return result;
}

/** Projection onto the actual drawn triangles, with no resampling of imagery,
 * invented elevation, depth bias, or extra silhouette. One program per body. */
export class GeographicMaterial extends THREE.ShaderMaterial {
  readonly pages: number;
  readonly textures: THREE.DataTexture[];
  constructor(index: GeographicIndex, equatorialKm: number, polarKm: number) {
    const packed = index.pack();
    const records = texture(packed.records), cells = texture(packed.cells), references = texture(packed.references);
    const detailCells = packed.detail ? texture(packed.detail.cells) : cells;
    super({
      transparent: true, depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
      side: THREE.FrontSide,
      uniforms: {
        vectorRecords: { value: records }, vectorCells: { value: cells }, vectorReferences: { value: references },
        vectorRecordSize: { value: new THREE.Vector2(records.image.width, records.image.height) },
        vectorReferenceSize: { value: new THREE.Vector2(references.image.width, references.image.height) },
        // Positions are offsets from an anchor near the camera (see setAnchor):
        // absolute body-fixed float32 steps ~0.25 m at Mars radius, which turns
        // close-range fills and strokes into speckle.
        vectorLocalToAnchor: { value: new THREE.Matrix4() },
        vectorAnchor: { value: new THREE.Vector3() },
        vectorAnchorLL: { value: new THREE.Vector4() },
        vectorAnchorNorth: { value: new THREE.Vector4() }, vectorAnchorSouth: { value: new THREE.Vector4() },
        vectorShape: { value: new THREE.Vector2(equatorialKm, polarKm) },
        vectorSelected: { value: -1 }, vectorHovered: { value: -1 },
        vectorPixelRatio: { value: 1 }, vectorPages: { value: packed.pages }, vectorHighlight: { value: 0 },
        // The cross-fade of the tile this proxy copies (1, 0 when it is not fading).
        vectorFadeIn: { value: 1 }, vectorFadeOut: { value: 0 },
        vectorReach: { value: index.reachPx },
        vectorCellSize: { value: new THREE.Vector2(cells.image.width, cells.image.height) },
        vectorDetailCells: { value: detailCells },
        vectorDetailCellSize: { value: new THREE.Vector2(detailCells.image.width, detailCells.image.height) },
        vectorDetailBounds: { value: detailSlots.map((_, i) => new THREE.Vector4(...(packed.detail?.levels[i]?.bounds ?? [0, 0, 0, 0]))) },
        vectorDetailStep: { value: detailSlots.map((_, i) => new THREE.Vector2(...(packed.detail?.levels[i]?.step ?? [0, 0]))) },
        vectorDetailGrid: { value: detailSlots.map((_, i) => {
          const level = packed.detail?.levels[i]; return new THREE.Vector4(level?.size ?? 0, level?.offset ?? 0, level?.pages ?? 0, level?.height ?? level?.size ?? 0);
        }) },
        vectorDisplacement: { value: new THREE.Vector3() },
        vectorDisplacementMap: { value: null }, vectorDisplacementTransform: { value: new THREE.Matrix3() },
      },
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        uniform mat4 vectorLocalToAnchor;
        uniform vec3 vectorDisplacement;
        uniform sampler2D vectorDisplacementMap;
        uniform mat3 vectorDisplacementTransform;
        varying vec3 vectorOffset;
        void main() {
          #include <begin_vertex>
          if (vectorDisplacement.x > 0.5) {
            vec2 mapUv = (vectorDisplacementTransform * vec3(uv, 1.0)).xy;
            transformed += normalize(normal) * (texture2D(vectorDisplacementMap, mapUv).x * vectorDisplacement.y + vectorDisplacement.z);
          }
          vectorOffset = (vectorLocalToAnchor * vec4(transformed, 1.0)).xyz;
          #include <project_vertex>
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform sampler2D vectorRecords;
        uniform sampler2D vectorCells;
        uniform sampler2D vectorReferences;
        uniform vec2 vectorRecordSize;
        uniform vec2 vectorReferenceSize;
        uniform vec2 vectorShape;
        uniform float vectorSelected;
        uniform float vectorHovered;
        uniform float vectorPixelRatio;
        uniform float vectorPages;
        uniform float vectorHighlight;
        uniform float vectorFadeIn;
        uniform float vectorFadeOut;
        uniform float vectorReach;
        uniform vec2 vectorCellSize;
        uniform sampler2D vectorDetailCells;
        uniform vec2 vectorDetailCellSize;
        uniform vec4 vectorDetailBounds[${DETAIL_LEVELS}];
        uniform vec2 vectorDetailStep[${DETAIL_LEVELS}];
        uniform vec4 vectorDetailGrid[${DETAIL_LEVELS}];
        uniform vec3 vectorAnchor;
        uniform vec4 vectorAnchorLL, vectorAnchorNorth, vectorAnchorSouth;
        varying vec3 vectorOffset;
        vec4 vectorTexel(sampler2D tex, vec2 size, float i) {
          return texture2D(tex, (vec2(mod(i, size.x), floor(i / size.x)) + 0.5) / size);
        }
        float vectorCross(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
        // point − (base + delta) for a base given as whole units (xy) and the
        // rest (zw). Fast-math GPU compilers (ANGLE on Metal) reorder float
        // sums, which here would round to the step at ±180° (~1 m on Mars), so
        // whole units are subtracted in integers and only small floats are added.
        vec2 vectorRelative(vec2 point, vec4 base, vec2 delta) {
          vec2 whole = floor(point);
          return vec2(ivec2(whole) - ivec2(base.xy)) + ((fract(point) - base.zw) - delta);
        }
        // A polar chart point minus the anchor's, from the anchor's longitude
        // (radians), the longitude and latitude differences and the anchor's radius.
        vec2 vectorPolarDelta(float lon0, float dLon, float dRadius, float radius0) {
          float halfSin = sin(0.5 * dLon), mid = lon0 + 0.5 * dLon;
          return dRadius * vec2(cos(lon0 + dLon), sin(lon0 + dLon)) + radius0 * 2.0 * halfSin * vec2(-sin(mid), cos(mid));
        }
        // During an LOD cross-fade a parent tile and its children both draw,
        // each keeping complementary pixels of a 4×4 Bayer pattern
        // (3d-tiles-renderer's TilesFadePlugin, wrapFadeMaterial). A proxy keeps
        // exactly the pixels its tile kept, so the overlay is blended once.
        float vectorBayer2(vec2 v) { return mod(3.0 * v.y + 2.0 * v.x, 4.0); }
        float vectorBayer4(vec2 v) { return 4.0 * vectorBayer2(mod(v, 2.0)) + vectorBayer2(floor(0.5 * mod(v, 4.0))); }
        bool vectorFadedOut() {
          float dither = (0.5 + vectorBayer4(floor(mod(gl_FragCoord.xy, 4.0)))) / 16.0;
          return dither >= vectorFadeIn || dither < vectorFadeOut;
        }
        // Convert coordinate deltas into framebuffer pixels with the local
        // surface Jacobian. Derivatives are evaluated outside divergent loops.
        vec2 vectorPixel(vec2 delta, vec2 dx, vec2 dy) {
          float determinant = vectorCross(dx, dy);
          return vec2(dy.y * delta.x - dy.x * delta.y, dx.x * delta.y - dx.y * delta.x) / determinant;
        }
        void main() {
          // Geodetic latitude in closed form (Bowring): exact to well below
          // float precision near the surface, at a fraction of an iterative
          // solve's cost, which every covered fragment pays. Evaluated as the
          // exact difference from the anchor's, so nothing near the camera is
          // rounded at planetary magnitude.
          vec3 anchor = vectorAnchor, offset = vectorOffset;
          vec3 body = anchor + offset;
          float equatorial = vectorShape.x, polar = vectorShape.y;
          float e2 = 1.0 - (polar * polar) / (equatorial * equatorial), ep2 = (equatorial * equatorial) / (polar * polar) - 1.0;
          float dLon = atan(vectorCross(anchor.xy, offset.xy), dot(anchor.xy, anchor.xy) + dot(anchor.xy, offset.xy));
          float p0 = length(anchor.xy), p = length(body.xy);
          float dp = (2.0 * dot(anchor.xy, offset.xy) + dot(offset.xy, offset.xy)) / max(p + p0, 1e-20);
          float beta0 = atan(anchor.z * equatorial, p0 * polar);
          float dBeta = atan(equatorial * polar * (p0 * offset.z - anchor.z * dp), p0 * p * polar * polar + anchor.z * body.z * equatorial * equatorial);
          float sb0 = sin(beta0), cb0 = cos(beta0), halfSin = sin(0.5 * dBeta), mid = beta0 + 0.5 * dBeta;
          float dsb = 2.0 * cos(mid) * halfSin, dcb = -2.0 * sin(mid) * halfSin, sb = sb0 + dsb, cb = cb0 + dcb;
          float x0 = p0 - e2 * equatorial * cb0 * cb0 * cb0, y0 = anchor.z + ep2 * polar * sb0 * sb0 * sb0;
          float dX = dp - e2 * equatorial * dcb * (cb * cb + cb * cb0 + cb0 * cb0);
          float dY = offset.z + ep2 * polar * dsb * (sb * sb + sb * sb0 + sb0 * sb0);
          float dLat = atan(x0 * dY - y0 * dX, x0 * (x0 + dX) + y0 * (y0 + dY));
          vec2 dll = degrees(vec2(dLon, dLat));
          // Coarse absolute coordinates choose index cells and seam shifts only.
          vec2 llRaw = vectorAnchorLL.xy + vectorAnchorLL.zw + dll;
          vec2 ll = vec2(mod(llRaw.x + 180.0, 360.0) - 180.0, llRaw.y);
          // Differentiate Cartesian offsets: longitude itself is discontinuous
          // at the seam. The differential of atan2 is continuous.
          vec3 bx = dFdx(offset), by = dFdy(offset);
          float longitudeDenominator = max(dot(body.xy, body.xy), 1e-20);
          vec2 dx = vec2(degrees(vectorCross(body.xy, bx.xy) / longitudeDenominator), dFdx(dll.y));
          vec2 dy = vec2(degrees(vectorCross(body.xy, by.xy) / longitudeDenominator), dFdy(dll.y));
          float lon0 = radians(vectorAnchorLL.x + vectorAnchorLL.z), lat0 = vectorAnchorLL.y + vectorAnchorLL.w;
          vec2 north = vectorPolarDelta(lon0, dLon, -dll.y, 90.0 - lat0), south = vectorPolarDelta(lon0, dLon, dll.y, 90.0 + lat0);
          vec2 ndx = dFdx(north), ndy = dFdy(north), sdx = dFdx(south), sdy = dFdy(south);
          // A 2×2 quad straddling a silhouette (a ridge and the ground far
          // behind it, at low angles) differences two surfaces: its
          // derivatives are far larger than a pixel's footprint, and strokes
          // would cover fragments nowhere near them. The anchor is the camera,
          // so the offset is the view ray, whose step to the next pixel is
          // continuous. Its footprint on the ellipsoid's tangent plane bounds a
          // real slope's (one inclined more than SILHOUETTE times as much from
          // the view is barely visible); larger derivatives are scaled down to it.
          vec3 ray = normalize(offset), up = normalize(vec3(body.xy / (equatorial * equatorial), body.z / (polar * polar)));
          vec3 rayX = ray + dFdx(ray), rayY = ray + dFdy(ray);
          float height = dot(up, offset);
          float planeX = length(height / dot(up, rayX) * rayX - offset), planeY = length(height / dot(up, rayY) * rayY - offset);
          float kx = min(1.0, ${SILHOUETTE}.0 * planeX / max(length(bx), 1e-30)), ky = min(1.0, ${SILHOUETTE}.0 * planeY / max(length(by), 1e-30));
          dx *= kx; ndx *= kx; sdx *= kx; dy *= ky; ndy *= ky; sdy *= ky;
          vec2 northCoarse = vectorAnchorNorth.xy + vectorAnchorNorth.zw + north, southCoarse = vectorAnchorSouth.xy + vectorAnchorSouth.zw + south;
          vec2 cell = clamp(floor((ll + vec2(180.0, 90.0)) / vec2(360.0, 180.0) * vec2(${VECTOR_GRID})), vec2(0.0), vec2(${VECTOR_GRID[0] - 1}.0, ${VECTOR_GRID[1] - 1}.0));
          // The finest grid whose padding covers this fragment's marks, else the coarse one.
          vec4 grid = vec4(${VECTOR_GRID[0]}.0, 0.0, vectorPages, ${VECTOR_GRID[1]}.0);
          vec2 gridCell = cell;
          // The largest styled mark decides how far a candidate can reach this fragment.
          vec2 footprint = vectorReach * vectorPixelRatio * (abs(dx) + abs(dy));
          bool detailed = false;
          for (int level = 0; level < ${DETAIL_LEVELS}; level++) {
            if (vectorDetailStep[level].x <= 0.0 || any(greaterThan(footprint, vectorDetailStep[level]))) continue;
            vec4 bounds = vectorDetailBounds[level], levelGrid = vectorDetailGrid[level];
            vec2 levelCell = floor((ll - bounds.xy) / vectorDetailStep[level]);
            if (bounds.z - bounds.x == 360.0) {
              levelCell.x = mod(levelCell.x, levelGrid.x);
              // A global level spanning every latitude holds the poles' rounding;
              // a band (the fine level, clear of polar charts) defers to the next level.
              bool band = bounds.y > -90.0 || bounds.w < 90.0;
              if (band && (levelCell.y < 0.0 || levelCell.y >= levelGrid.w)) continue;
              levelCell.y = clamp(levelCell.y, 0.0, levelGrid.w - 1.0);
            }
            if (any(lessThan(levelCell, vec2(0.0))) || any(greaterThanEqual(levelCell, vec2(levelGrid.x, levelGrid.w)))) discard;
            grid = levelGrid; gridCell = levelCell;
            detailed = true;
            break;
          }
          // Every page in one draw (separate draws re-ran all of the above per
          // page), composited in order with page 0 lowest, as blending would.
          // Composited in linear colour and converted once: converting each
          // page inside the loop made the shader twice as slow on Metal.
          vec4 total = vec4(0.0);
          for (int page = 0; page < ${VECTOR_RENDER_PAGE_LIMIT}; page++) {
            if (float(page) >= grid.z) break;
            float slot = grid.y + float(page) * grid.x * grid.w + gridCell.y * grid.x + gridCell.x;
            vec4 range = detailed ? vectorTexel(vectorDetailCells, vectorDetailCellSize, slot) : vectorTexel(vectorCells, vectorCellSize, slot);
            vec4 result = vec4(0.0);
            float bestRank = -1.0;
            float bestCoverage = 0.0;
            for (int j = 0; j < ${VECTOR_CELL_LIMIT}; j++) {
              if (float(j) >= range.y) break;
              vec4 reference = vectorTexel(vectorReferences, vectorReferenceSize, range.x + float(j));
              float id = reference.x * 4.0;
              // Kind 3: this cell lies wholly inside the fill's polygon, so there is nothing to test.
              bool covered = reference.y == 3.0;
              float kind = min(reference.y, 2.0);
              vec4 ab = vectorTexel(vectorRecords, vectorRecordSize, id);
              vec4 ck = reference.y == 2.0 ? vectorTexel(vectorRecords, vectorRecordSize, id + 1.0) : vec4(ab.xy, 0.0, 0.0);
              vec2 jx = reference.z == 0.0 ? dx : (reference.z > 0.0 ? ndx : sdx);
              vec2 jy = reference.z == 0.0 ? dy : (reference.z > 0.0 ? ndy : sdy);
              // Most candidates in a padded cell are far outside this fragment's
              // few-pixel mark (or its triangle). Reject them on coarse coordinates,
              // with a margin over their rounding, before the exact arithmetic.
              vec2 padding = kind < 2.0 ? vectorReach * vectorPixelRatio * (abs(jx) + abs(jy)) : vec2(0.0);
              // A grazing footprint outside the index padding is unresolved.
              // Partial MSAA coverage must not stretch a hidden stroke over it.
              if (any(greaterThan(padding, vec2(${VECTOR_PADDING_DEG}.0)))) continue;
              vec2 q = reference.z == 0.0 ? vec2(reference.w + mod(ll.x - reference.w + 180.0, 360.0) - 180.0, ll.y) : (reference.z > 0.0 ? northCoarse : southCoarse);
              vec2 low = min(min(ab.xy, ab.zw), ck.xy) - padding - 1e-4, high = max(max(ab.xy, ab.zw), ck.xy) + padding + 1e-4;
              if (!covered && (any(lessThan(q, low)) || any(greaterThan(q, high)))) continue;
              if (abs(vectorCross(jx, jy)) < 1e-18) continue;
              // Index coordinates minus this fragment's, exactly: anchor-relative,
              // so the tiny differences near the camera are not rounded away.
              vec4 base = reference.z == 0.0 ? vectorAnchorLL : (reference.z > 0.0 ? vectorAnchorNorth : vectorAnchorSouth);
              vec2 delta = reference.z == 0.0 ? dll : (reference.z > 0.0 ? north : south);
              // Equirectangular references wrap near their own anchor longitude.
              vec2 shift = vec2(reference.z == 0.0 ? 360.0 * floor((q.x - llRaw.x) / 360.0 + 0.5) : 0.0, 0.0);
              vec2 ra = vectorRelative(ab.xy - shift, base, delta), rb = vectorRelative(ab.zw - shift, base, delta);
              vec4 identity = vectorTexel(vectorRecords, vectorRecordSize, id + 3.0);
              // Separate sparse highlight passes follow every ordinary page.
              if (vectorHighlight == 0.0 && reference.y == 1.0 && (identity.x == vectorSelected || identity.x == vectorHovered)) continue;
              // Style flags: dashed, halo/outline, hatch, then the point shape.
              float flags = identity.w;
              bool dashed = mod(flags, 2.0) >= 1.0;
              bool halo = mod(floor(flags / 2.0), 2.0) >= 1.0;
              bool hatch = mod(floor(flags / 4.0), 2.0) >= 1.0;
              float shape = floor(flags / ${VECTOR_SHAPE_STEP}.0);
              float alpha = 0.0;
              // Coverage of the mark itself; the rest of alpha is the halo around it.
              float core = 1.0;
              if (kind == 2.0) {
                vec2 rc = vectorRelative(ck.xy - shift, base, delta);
                vec3 signs = vec3(vectorCross(rb - ra, -ra), vectorCross(rc - rb, -rb), vectorCross(ra - rc, -rc));
                if (covered || all(greaterThanEqual(signs, vec3(0.0))) || all(lessThanEqual(signs, vec3(0.0)))) {
                  alpha = 1.0;
                  // Diagonal screen-space stripes, 8 CSS px apart.
                  if (hatch) alpha = mod((gl_FragCoord.x + gl_FragCoord.y) / vectorPixelRatio, 8.0) < 2.0 ? 4.0 : 0.35;
                }
              } else {
                vec2 a = vectorPixel(ra, jx, jy), b = vectorPixel(rb, jx, jy);
                vec2 v = b - a;
                float t = reference.y == 0.0 ? 0.0 : clamp(-dot(a, v) / max(dot(v, v), 1e-20), 0.0, 1.0);
                vec2 offset = (a + t * v) / vectorPixelRatio;
                // Squares and diamonds use their own distance; equal radius keeps them the same size.
                float distancePx = reference.y != 0.0 || shape == 0.0 ? length(offset)
                  : shape == 1.0 ? max(abs(offset.x), abs(offset.y)) : (abs(offset.x) + abs(offset.y)) * 0.7071;
                // Seen nearly edge-on, a pixel spans far more ground in depth than
                // across, so a mark a few pixels wide would reach kilometres past
                // its line, onto ground behind a ridge it is drawn in front of.
                // Its reach is held to ANISOTROPY times the narrow footprint.
                vec2 metric = reference.z == 0.0 ? vec2(cos(radians(ll.y)), 1.0) : vec2(1.0);
                vec2 mx = jx * metric, my = jy * metric;
                float narrow = abs(vectorCross(mx, my)) / max(max(length(mx), length(my)), 1e-30);
                distancePx = max(distancePx, length((ra + t * (rb - ra)) * metric) / max(narrow, 1e-30) / vectorPixelRatio / ${ANISOTROPY}.0);
                bool emphasized = identity.x == vectorSelected || identity.x == vectorHovered;
                float radius = identity.z + (reference.y == 1.0 && emphasized ? 0.75 : 0.0);
                core = 1.0 - smoothstep(radius - 0.5, radius + 0.5, distancePx);
                float outer = halo ? radius + ${VECTOR_HALO_PX} : radius;
                alpha = 1.0 - smoothstep(outer - 0.5, outer + 0.5, distancePx);
                // 6 on, 4 off along each segment, in CSS pixels.
                if (dashed && mod(t * length(v) / vectorPixelRatio, 10.0) > 6.0) alpha = 0.0;
                core = halo ? core / max(alpha, 1e-6) : 1.0;
              }
              float rank = 2.0 - kind;
              // Union round segments at joints: an earlier segment's faint
              // AA fringe must not mask the next segment's opaque coverage.
              if (alpha > 0.0 && (rank > bestRank || (rank == bestRank && alpha > bestCoverage))) {
                vec4 style = vectorTexel(vectorRecords, vectorRecordSize, id + 2.0);
                vec3 color = identity.x == vectorSelected ? vec3(1.0, 0.78, 0.28) : (identity.x == vectorHovered ? vec3(1.0) : style.rgb);
                // A halo is a dark rim that keeps light marks readable on light terrain.
                color = mix(vec3(0.03, 0.05, 0.08), color, clamp(core, 0.0, 1.0));
                result = vec4(color, clamp(alpha * style.a, 0.0, 1.0));
                bestRank = rank;
                bestCoverage = alpha;
              }
            }
            if (result.a == 0.0) continue;
            total = vec4(result.rgb * result.a, result.a) + (1.0 - result.a) * total;
          }
          if (total.a == 0.0 || vectorFadedOut()) discard;
          gl_FragColor = vec4(total.rgb / total.a, total.a);
          #include <logdepthbuf_fragment>
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.pages = packed.pages;
    this.textures = packed.detail ? [records, cells, references, detailCells] : [records, cells, references];
  }
  /** Anchor the shader's coordinates at `bodyKm` (body-fixed, ideally the
   * camera): its geodetic position goes up in double-float pairs, and the
   * fragment shader works with exact differences from it. */
  setAnchor(bodyKm: THREE.Vector3): void {
    const u = this.uniforms;
    const [x, y, z] = [Math.fround(bodyKm.x), Math.fround(bodyKm.y), Math.fround(bodyKm.z)];
    u.vectorAnchor.value.set(x, y, z);
    const [a, b] = (u.vectorShape.value as THREE.Vector2).toArray();
    const e2 = 1 - (b * b) / (a * a), ep2 = (a * a) / (b * b) - 1, p = Math.hypot(x, y);
    const beta = Math.atan2(z * a, p * b);
    const lat = Math.atan2(z + ep2 * b * Math.sin(beta) ** 3, p - e2 * a * Math.cos(beta) ** 3) * 180 / Math.PI;
    const lon = Math.atan2(y, x), r = 90 - lat, s = 90 + lat;
    // Whole units and the remainder, as vectorRelative takes them.
    const pair = (v: THREE.Vector4, p0: number, p1: number) => v.set(Math.floor(p0), Math.floor(p1), p0 - Math.floor(p0), p1 - Math.floor(p1));
    pair(u.vectorAnchorLL.value, lon * 180 / Math.PI, lat);
    pair(u.vectorAnchorNorth.value, r * Math.cos(lon), r * Math.sin(lon));
    pair(u.vectorAnchorSouth.value, s * Math.cos(lon), s * Math.sin(lon));
  }
  /** Re-upload the primitive records after `GeographicIndex.restyle`; the same texture, no new program. */
  restyle(index: GeographicIndex): void {
    const records = this.textures[0];
    index.packRecords(records.image.data as Float32Array);
    records.needsUpdate = true;
    this.uniforms.vectorReach.value = index.reachPx;
  }
  override dispose(): void { this.textures.forEach(t => t.dispose()); super.dispose(); }
}
