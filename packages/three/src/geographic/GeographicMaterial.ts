import * as THREE from 'three';
import { GeographicIndex, VECTOR_CELL_LIMIT, VECTOR_GRID, VECTOR_DETAIL_GRIDS, VECTOR_PADDING_DEG, VECTOR_SHAPE_STEP, VECTOR_HALO_PX } from './GeographicIndex.js';

const DETAIL_LEVELS = VECTOR_DETAIL_GRIDS.length + 1;
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
        vectorLocalToBody: { value: new THREE.Matrix4() },
        vectorShape: { value: new THREE.Vector2(equatorialKm, polarKm) },
        vectorSelected: { value: -1 }, vectorHovered: { value: -1 },
        vectorPixelRatio: { value: 1 }, vectorPage: { value: 0 }, vectorHighlight: { value: 0 },
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
        uniform mat4 vectorLocalToBody;
        uniform vec3 vectorDisplacement;
        uniform sampler2D vectorDisplacementMap;
        uniform mat3 vectorDisplacementTransform;
        varying vec3 vectorBody;
        void main() {
          #include <begin_vertex>
          if (vectorDisplacement.x > 0.5) {
            vec2 mapUv = (vectorDisplacementTransform * vec3(uv, 1.0)).xy;
            transformed += normalize(normal) * (texture2D(vectorDisplacementMap, mapUv).x * vectorDisplacement.y + vectorDisplacement.z);
          }
          vectorBody = (vectorLocalToBody * vec4(transformed, 1.0)).xyz;
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
        uniform float vectorPage;
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
        varying vec3 vectorBody;
        vec4 vectorTexel(sampler2D tex, vec2 size, float i) {
          return texture2D(tex, (vec2(mod(i, size.x), floor(i / size.x)) + 0.5) / size);
        }
        vec2 vectorChart(vec2 ll, float chart, float anchor) {
          if (chart == 0.0) return vec2(anchor + mod(ll.x - anchor + 180.0, 360.0) - 180.0, ll.y);
          float r = 90.0 - chart * ll.y;
          return r * vec2(cos(radians(ll.x)), sin(radians(ll.x)));
        }
        float vectorCross(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
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
          // solve's cost, which every covered fragment pays.
          float p = length(vectorBody.xy);
          float equatorial = vectorShape.x, polar = vectorShape.y;
          float e2 = 1.0 - (polar * polar) / (equatorial * equatorial), ep2 = (equatorial * equatorial) / (polar * polar) - 1.0;
          float beta = atan(vectorBody.z * equatorial, p * polar);
          float sb = sin(beta), cb = cos(beta);
          float latitude = atan(vectorBody.z + ep2 * polar * sb * sb * sb, p - e2 * equatorial * cb * cb * cb);
          vec2 ll = degrees(vec2(atan(vectorBody.y, vectorBody.x), latitude));
          // Differentiate Cartesian positions first: longitude itself is
          // discontinuous at the seam. The differential of atan2 is continuous.
          vec3 bx = dFdx(vectorBody), by = dFdy(vectorBody);
          float longitudeDenominator = max(dot(vectorBody.xy, vectorBody.xy), 1e-20);
          vec2 dx = vec2(degrees(vectorCross(vectorBody.xy, bx.xy) / longitudeDenominator), dFdx(ll.y));
          vec2 dy = vec2(degrees(vectorCross(vectorBody.xy, by.xy) / longitudeDenominator), dFdy(ll.y));
          vec2 north = vectorChart(ll, 1.0, 0.0), south = vectorChart(ll, -1.0, 0.0);
          vec2 ndx = dFdx(north), ndy = dFdy(north), sdx = dFdx(south), sdy = dFdy(south);
          vec2 cell = clamp(floor((ll + vec2(180.0, 90.0)) / vec2(360.0, 180.0) * vec2(${VECTOR_GRID})), vec2(0.0), vec2(${VECTOR_GRID[0] - 1}.0, ${VECTOR_GRID[1] - 1}.0));
          vec4 range = vec4(0.0);
          // The largest styled mark decides how far a candidate can reach this fragment.
          vec2 footprint = vectorReach * vectorPixelRatio * (abs(dx) + abs(dy));
          bool detailed = false;
          for (int level = 0; level < ${DETAIL_LEVELS}; level++) {
            if (vectorDetailStep[level].x <= 0.0 || any(greaterThan(footprint, vectorDetailStep[level]))) continue;
            vec4 grid = vectorDetailGrid[level];
            if (vectorPage >= grid.z) discard;
            vec2 detailCell = floor((ll - vectorDetailBounds[level].xy) / vectorDetailStep[level]);
            if (vectorDetailBounds[level].z - vectorDetailBounds[level].x == 360.0) {
              detailCell.x = mod(detailCell.x, grid.x);
              detailCell.y = clamp(detailCell.y, 0.0, grid.w - 1.0);
            }
            if (any(lessThan(detailCell, vec2(0.0))) || any(greaterThanEqual(detailCell, vec2(grid.x, grid.w)))) discard;
            range = vectorTexel(vectorDetailCells, vectorDetailCellSize, grid.y + vectorPage * grid.x * grid.w + detailCell.y * grid.x + detailCell.x);
            detailed = true;
            break;
          }
          if (!detailed) range = vectorTexel(vectorCells, vectorCellSize, vectorPage * ${VECTOR_GRID[0] * VECTOR_GRID[1]}.0 + cell.y * ${VECTOR_GRID[0]}.0 + cell.x);
          vec4 result = vec4(0.0);
          float bestRank = -1.0;
          float bestCoverage = 0.0;
          for (int j = 0; j < ${VECTOR_CELL_LIMIT}; j++) {
            if (float(j) >= range.y) break;
            vec4 reference = vectorTexel(vectorReferences, vectorReferenceSize, range.x + float(j));
            float id = reference.x * 4.0;
            vec4 ab = vectorTexel(vectorRecords, vectorRecordSize, id);
            vec2 q = vectorChart(ll, reference.z, reference.w);
            vec2 jx = reference.z == 0.0 ? dx : (reference.z > 0.0 ? ndx : sdx);
            vec2 jy = reference.z == 0.0 ? dy : (reference.z > 0.0 ? ndy : sdy);
            // Most candidates in a padded cell are far outside this fragment's
            // few-pixel mark. Reject them before extra texture reads/matrix work.
            vec2 padding = vectorReach * vectorPixelRatio * (abs(jx) + abs(jy));
            // A grazing footprint outside the index padding is unresolved.
            // Partial MSAA coverage must not stretch a hidden stroke over it.
            if (reference.y < 2.0 && any(greaterThan(padding, vec2(${VECTOR_PADDING_DEG}.0)))) continue;
            if (reference.y < 2.0 && (any(lessThan(q, min(ab.xy, ab.zw) - padding)) || any(greaterThan(q, max(ab.xy, ab.zw) + padding)))) continue;
            if (abs(vectorCross(jx, jy)) < 1e-18) continue;
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
            if (reference.y == 2.0) {
              vec4 ck = vectorTexel(vectorRecords, vectorRecordSize, id + 1.0);
              vec3 signs = vec3(vectorCross(ab.zw - ab.xy, q - ab.xy), vectorCross(ck.xy - ab.zw, q - ab.zw), vectorCross(ab.xy - ck.xy, q - ck.xy));
              if (all(greaterThanEqual(signs, vec3(0.0))) || all(lessThanEqual(signs, vec3(0.0)))) {
                alpha = 1.0;
                // Diagonal screen-space stripes, 8 CSS px apart.
                if (hatch) alpha = mod((gl_FragCoord.x + gl_FragCoord.y) / vectorPixelRatio, 8.0) < 2.0 ? 4.0 : 0.35;
              }
            } else {
              vec2 a = vectorPixel(ab.xy - q, jx, jy), b = vectorPixel(ab.zw - q, jx, jy);
              vec2 v = b - a;
              float t = reference.y == 0.0 ? 0.0 : clamp(-dot(a, v) / max(dot(v, v), 1e-20), 0.0, 1.0);
              vec2 offset = (a + t * v) / vectorPixelRatio;
              // Squares and diamonds use their own distance; equal radius keeps them the same size.
              float distancePx = reference.y != 0.0 || shape == 0.0 ? length(offset)
                : shape == 1.0 ? max(abs(offset.x), abs(offset.y)) : (abs(offset.x) + abs(offset.y)) * 0.7071;
              bool emphasized = identity.x == vectorSelected || identity.x == vectorHovered;
              float radius = identity.z + (reference.y == 1.0 && emphasized ? 0.75 : 0.0);
              core = 1.0 - smoothstep(radius - 0.5, radius + 0.5, distancePx);
              float outer = halo ? radius + ${VECTOR_HALO_PX} : radius;
              alpha = 1.0 - smoothstep(outer - 0.5, outer + 0.5, distancePx);
              // 6 on, 4 off along each segment, in CSS pixels.
              if (dashed && mod(t * length(v) / vectorPixelRatio, 10.0) > 6.0) alpha = 0.0;
              core = halo ? core / max(alpha, 1e-6) : 1.0;
            }
            float rank = 2.0 - reference.y;
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
          if (result.a == 0.0 || vectorFadedOut()) discard;
          gl_FragColor = result;
          #include <logdepthbuf_fragment>
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.pages = packed.pages;
    this.textures = packed.detail ? [records, cells, references, detailCells] : [records, cells, references];
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
