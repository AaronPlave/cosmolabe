import * as THREE from 'three';
import { GeographicIndex, VECTOR_CELL_LIMIT, VECTOR_GRID, VECTOR_DETAIL_GRIDS } from './GeographicIndex.js';

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
        vectorPixelRatio: { value: 1 }, vectorPage: { value: 0 },
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
        // Convert coordinate deltas into framebuffer pixels with the local
        // surface Jacobian. Derivatives are evaluated outside divergent loops.
        vec2 vectorPixel(vec2 delta, vec2 dx, vec2 dy) {
          float determinant = vectorCross(dx, dy);
          return vec2(dy.y * delta.x - dy.x * delta.y, dx.x * delta.y - dx.y * delta.x) / determinant;
        }
        void main() {
          float p = length(vectorBody.xy);
          float e2 = 1.0 - pow(vectorShape.y / vectorShape.x, 2.0);
          float latitude = atan(vectorBody.z, p * (1.0 - e2));
          for (int j = 0; j < 5; j++) {
            float n = vectorShape.x / sqrt(1.0 - e2 * pow(sin(latitude), 2.0));
            latitude = atan(vectorBody.z + e2 * n * sin(latitude), p);
          }
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
          vec2 footprint = 4.5 * vectorPixelRatio * (abs(dx) + abs(dy));
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
            vec2 padding = 4.5 * vectorPixelRatio * (abs(jx) + abs(jy));
            if (reference.y < 2.0 && (any(lessThan(q, min(ab.xy, ab.zw) - padding)) || any(greaterThan(q, max(ab.xy, ab.zw) + padding)))) continue;
            if (abs(vectorCross(jx, jy)) < 1e-18) continue;
            vec4 identity = vectorTexel(vectorRecords, vectorRecordSize, id + 3.0);
            float alpha = 0.0;
            if (reference.y == 2.0) {
              vec4 ck = vectorTexel(vectorRecords, vectorRecordSize, id + 1.0);
              vec3 signs = vec3(vectorCross(ab.zw - ab.xy, q - ab.xy), vectorCross(ck.xy - ab.zw, q - ab.zw), vectorCross(ab.xy - ck.xy, q - ck.xy));
              if (all(greaterThanEqual(signs, vec3(0.0))) || all(lessThanEqual(signs, vec3(0.0)))) alpha = 0.14;
            } else {
              vec2 a = vectorPixel(ab.xy - q, jx, jy), b = vectorPixel(ab.zw - q, jx, jy);
              vec2 v = b - a;
              float t = reference.y == 0.0 ? 0.0 : clamp(-dot(a, v) / max(dot(v, v), 1e-20), 0.0, 1.0);
              float distancePx = length(a + t * v) / vectorPixelRatio;
              bool emphasized = identity.x == vectorSelected || identity.x == vectorHovered;
              float radius = reference.y == 0.0 ? 3.5 : (emphasized ? 1.75 : 1.0);
              alpha = 1.0 - smoothstep(radius - 0.5, radius + 0.5, distancePx);
            }
            float rank = 2.0 - reference.y;
            if (alpha > 0.0 && rank > bestRank) {
              vec4 style = vectorTexel(vectorRecords, vectorRecordSize, id + 2.0);
              vec3 color = identity.x == vectorSelected ? vec3(1.0, 0.78, 0.28) : (identity.x == vectorHovered ? vec3(1.0) : style.rgb);
              result = vec4(color, alpha * style.a);
              bestRank = rank;
            }
          }
          if (result.a == 0.0) discard;
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
  override dispose(): void { this.textures.forEach(t => t.dispose()); super.dispose(); }
}
