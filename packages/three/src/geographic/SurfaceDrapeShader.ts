/** Keep draped overlays on the same projected triangles and fade pixels. */
export const SURFACE_DRAPE_VERTEX = `
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
      `;

export const SURFACE_DRAPE_FADE = `
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
`;
