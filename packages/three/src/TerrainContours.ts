/** Narrow adaptation of 3d-tiles-renderer v0.4.27's example
 * wrapTopoLineMaterial.js (NASA-AMMOS, Apache-2.0): derivative antialiasing.
 * Intervals and index contours are shared with the CPU path labels.
 */
export function injectTerrainContours(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = 'attribute float surfaceGround; varying float vSAContourGround;\n' + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSAContourGround = surfaceGround;');
  shader.fragmentShader = `
varying float vSAContourGround;
uniform vec3 saContourColor; uniform float saContourOpacity, saContourIntervalKm;
float saContourLine(float height, float delta, float spacing, float width) {
  float distanceToLine = abs(height - floor(height / spacing + 0.5) * spacing);
  float line = 1.0 - smoothstep(delta * max(0.0, width - 0.5), delta * (width + 0.5), distanceToLine);
  // Finish fading before the AA support overlaps the entire period; otherwise
  // wide index lines turn an unresolved slope into a solid color wash.
  float limit = spacing / (2.0 * (width + 0.5));
  return line * (1.0 - smoothstep(limit * 0.45, limit * 0.9, delta));
}
` + shader.fragmentShader;
  // Unlit annotation after Sun/hillshade, eclipse and aerial perspective,
  // before output conversion and the existing fog/fade/debug hooks.
  shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
float saDelta = max(length(vec2(dFdx(vSAHeight), dFdy(vSAHeight))), 1e-8);
float saStep = max(saContourIntervalKm, 0.000001);
float saMajorStep = saStep * 5.0;
float saMinor = saContourLine(vSAHeight, saDelta, saStep, 0.55) * 0.55;
float saMajor = saContourLine(vSAHeight, saDelta, saMajorStep, 1.0);
// Filter minor and index lines independently. The old filter extinguished
// both at dense intervals, creating islands of contour coverage on slopes.
// Nested multiples of five retain a resolvable index skeleton at grazing
// angles, without turning subpixel periodic lines into a solid terrain tint.
float saCoarseStep = saMajorStep * pow(5.0, max(0.0, ceil(log(max(1.0, saDelta * 4.0 / saMajorStep)) / log(5.0))));
float saCoarse = saContourLine(vSAHeight, saDelta, saCoarseStep, 1.0);
float saLine = max(saMinor, max(saMajor, saCoarse));
float saFade = smoothstep(1e-8, 1e-7, saDelta);
// Skirts share top vertices with ground. Reject the varying mask on their
// faces so a threshold alone cannot admit a dashed strip at the top edge.
float saGround = step(0.999, vSAContourGround) * (1.0 - step(1e-6, fwidth(vSAContourGround)));
outgoingLight = mix(outgoingLight, saContourColor,
  saLine * saFade * saContourOpacity * saGround);
#include <opaque_fragment>`);
}
