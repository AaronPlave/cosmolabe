/** Narrow adaptation of 3d-tiles-renderer v0.4.27's example
 * wrapTopoLineMaterial.js (NASA-AMMOS, Apache-2.0): derivative AA,
 * decade spacing, two blended scales and emphasized tenth lines.
 * Uses SurfaceAppearance's datum-aware heights in km, not upstream's
 * world-space ellipsoid conversion. No cartographic/grid component.
 */
export function injectTerrainContours(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = `attribute float surfaceGround; uniform mat4 saContourLocalToBody;
varying float vSAContourGround; varying vec3 vSAContourPoint;
` + shader.vertexShader;
  // Translation is deliberately excluded: derivatives need only the footprint,
  // and retaining small tile-local values avoids globe/floating-origin jitter.
  shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
vSAContourPoint = mat3(saContourLocalToBody) * position * 0.001;
vSAContourGround = surfaceGround;`);
  shader.fragmentShader = `
varying float vSAContourGround; varying vec3 vSAContourPoint;
uniform vec3 saContourColor; uniform float saContourOpacity, saContourDensity;
float saContourLine(float height, float delta, float spacing) {
  float index = floor(height / spacing + 0.5);
  float major = 1.0 - step(0.5, abs(index - 10.0 * floor(index / 10.0 + 0.5)));
  float distanceToLine = abs(height - index * spacing);
  float width = mix(0.55, 1.0, major);
  float line = 1.0 - smoothstep(delta * max(0.0, width - 0.5), delta * (width + 0.5), distanceToLine);
  // Fade unresolved bands and constant-height plateaus rather than tinting
  // whole faces. smoothstep edges are ordered (unlike upstream's reversed AA).
  return line * mix(0.5, 1.0, major) * (1.0 - smoothstep(spacing * 0.2, spacing * 0.5, delta));
}
` + shader.fragmentShader;
  // An unlit map annotation over the displayed terrain radiance. Compose after
  // Sun/hillshade, eclipse and aerial perspective, before output conversion and
  // the existing fog/fade/debug hooks. No extra draw or depth offset.
  shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
float saFootprint = max(length(dFdx(vSAContourPoint)), length(dFdy(vSAContourPoint)));
float saTarget = max(0.000001, saFootprint * 1.75 / saContourDensity);
float saLogStep = log(saTarget) / log(10.0);
float saStep = pow(10.0, ceil(saLogStep));
float saBlend = 1.0 - smoothstep(0.75, 1.0, fract(saLogStep));
float saDelta = length(vec2(dFdx(vSAHeight), dFdy(vSAHeight)));
float saLine = mix(saContourLine(vSAHeight, max(saDelta, 1e-8), saStep * 10.0),
                   saContourLine(vSAHeight, max(saDelta, 1e-8), saStep), saBlend);
// Spacing already adapts to distance. An absolute footprint cutoff creates
// a circular coverage boundary on otherwise valid, globally loaded terrain.
float saFade = smoothstep(1e-8, 1e-7, saDelta);
outgoingLight = mix(outgoingLight, saContourColor,
  saLine * saFade * saContourOpacity * step(0.999, vSAContourGround));
#include <opaque_fragment>`);
}
