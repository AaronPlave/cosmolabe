import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  LIGHTING_MODES, aimSunLight, applyLightingMode, combineImageryIllumination, createSurfaceAsIsUniforms, declareSurfaceAsIs,
  directTerm, imageryAsIsWeight, incidenceCosine, injectAsIsDisplayIntoShader, injectOverlayAsIsIntoShader,
  isPhysicallyRelit, pickIlluminationReceiver, solarGeometryAt, sunDirectionAt,
} from '../SurfaceIllumination.js';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const deg = (d: number) => d * Math.PI / 180;
const AU = 1.496e8 * 1e-6; // scene units at scaleFactor 1e-6

describe('imagery illumination provenance (#204)', () => {
  it('summarises a stack: shared provenance, or `mixed` when sources differ', () => {
    expect(combineImageryIllumination([])).toBe('unknown');
    expect(combineImageryIllumination([undefined])).toBe('unknown');
    expect(combineImageryIllumination(['reflectance', 'reflectance'])).toBe('reflectance');
    expect(combineImageryIllumination(['baked', 'baked'])).toBe('baked');
    // A summary only: the lighting path is chosen per pixel, never from this.
    expect(combineImageryIllumination(['reflectance', 'baked'])).toBe('mixed');
    expect(combineImageryIllumination(['baked', 'unknown'])).toBe('mixed');
    expect(combineImageryIllumination(['unknown', undefined])).toBe('unknown');
    expect(combineImageryIllumination(['bogus' as never])).toBe('unknown');
  });

  it('weights only baked sources as shown as-is; reflectance and legacy unknown are relit', () => {
    expect(imageryAsIsWeight('baked')).toBe(1);
    expect(imageryAsIsWeight('reflectance')).toBe(0);
    expect(imageryAsIsWeight('unknown')).toBe(0); // legacy behaviour is preserved
    expect(imageryAsIsWeight(undefined)).toBe(0);
  });

  it('asserts physical relighting only for reflectance in natural mode', () => {
    expect(isPhysicallyRelit('reflectance', 'natural')).toBe(true);
    expect(isPhysicallyRelit('unknown', 'natural')).toBe(false);
    expect(isPhysicallyRelit('mixed', 'natural')).toBe(false);
    expect(isPhysicallyRelit('baked', 'natural')).toBe(false);
    expect(isPhysicallyRelit('reflectance', 'shadow')).toBe(false);
    expect(isPhysicallyRelit('reflectance', 'flood')).toBe(false);
  });

  it('injects a per-fragment, uniform-driven as-is display ahead of later injections and fails loudly if the hook moves', () => {
    const uniforms = createSurfaceAsIsUniforms();
    uniforms.surfaceAsIs.value = 1;
    const shader = { fragmentShader: 'void main() {\nvec3 totalDiffuse = vec3(0.0);\n#include <opaque_fragment>\n}', uniforms: {} as Record<string, unknown> };
    injectAsIsDisplayIntoShader(shader, uniforms);
    expect(shader.uniforms.uSurfaceAsIs).toBe(uniforms.surfaceAsIs); // shared by reference: a write needs no recompile
    expect(shader.uniforms.uBakedNightFloor).toBe(uniforms.nightFloor);
    expect(shader.fragmentShader).toContain('uniform float uSurfaceAsIs;');
    expect(shader.fragmentShader).toContain('surfaceAsIs = uSurfaceAsIs;'); // each fragment starts at the uncovered weight
    expect(shader.fragmentShader).toContain('diffuseColor.rgb * surfaceBakedShare * surfaceBakedGate');
    expect(shader.fragmentShader).toContain('totalDiffuse * (1.0 - surfaceBakedShare)'); // relit share lit, baked share as-is
    // A later injection that replaces the same token still lands after ours.
    const later = shader.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight *= eclipse();\n#include <opaque_fragment>');
    expect(later.indexOf('surfaceBakedShare * surfaceBakedGate;')).toBeLessThan(later.indexOf('eclipse()'));
    expect(() => injectAsIsDisplayIntoShader({ fragmentShader: 'nothing' }, uniforms)).toThrow(/hook changed/);
    expect(() => injectAsIsDisplayIntoShader({ fragmentShader: 'void main() {\n#include <opaque_fragment>\n}' }, uniforms)).toThrow(/totalDiffuse/);
  });

  it('declares the per-fragment weight once, whichever compositor or hook comes first', () => {
    const declared = (src: string) => src.split('float surfaceAsIs;').length - 1;
    const a = { fragmentShader: 'void main() {\nvec3 totalDiffuse = vec3(0.0);\n#include <opaque_fragment>\n}', uniforms: {} as Record<string, unknown> };
    declareSurfaceAsIs(a);
    injectAsIsDisplayIntoShader(a, createSurfaceAsIsUniforms());
    declareSurfaceAsIs(a);
    expect(declared(a.fragmentShader)).toBe(1);
    expect(a.fragmentShader.split('surfaceAsIs = uSurfaceAsIs;').length - 1).toBe(1);
    expect(() => declareSurfaceAsIs({ fragmentShader: 'nothing' })).toThrow(/main/);
  });

  it('gates baked imagery on the local horizon only, per lighting mode', () => {
    expect(LIGHTING_MODES.natural.bakedNightFloor).toBeCloseTo(8 / 255, 12);
    expect(LIGHTING_MODES.shadow.bakedNightFloor).toBeCloseTo(0x55 / 255, 12);
    expect(LIGHTING_MODES.flood.bakedNightFloor).toBe(1); // flood is uniform: no gate
    expect(createSurfaceAsIsUniforms('flood').nightFloor.value).toBe(1);
  });
});

describe('ImageOverlayPlugin overlay compositor hook (#204)', () => {
  // The real upstream shader text, produced by the real wrapOverlaysMaterial. It is an internal module
  // of 3d-tiles-renderer (not exported), so it is loaded from the installed package: an upgrade that
  // moves or reshapes it fails here instead of silently double-lighting baked overlays.
  type Wrap = (material: unknown, previous: unknown) => unknown;
  let wrapOverlaysMaterial: Wrap;
  beforeAll(async () => {
    const file = new URL('../../../../node_modules/3d-tiles-renderer/src/three/plugins/images/overlays/wrapOverlaysMaterial.js', import.meta.url);
    wrapOverlaysMaterial = (await import(/* @vite-ignore */ file.href)).wrapOverlaysMaterial;
  });
  const wrapped = () => {
    const material = { defines: {} as Record<string, unknown>, onBeforeCompile: undefined as unknown };
    wrapOverlaysMaterial(material, undefined);
    const shader = { uniforms: {}, vertexShader: 'void main() {\n}', fragmentShader: 'void main() {\n#include <color_fragment>\n#include <opaque_fragment>\n}' };
    (material.onBeforeCompile as (s: typeof shader) => void)(shader);
    return shader;
  };

  it('adds a per-layer weight to LayerInfo and blends it by the layer alpha', () => {
    const shader = wrapped();
    injectOverlayAsIsIntoShader(shader);
    expect(shader.fragmentShader).toMatch(/struct LayerInfo\s*\{[^}]*float opacity;\s*float asIs;/);
    const blend = shader.fragmentShader.indexOf('diffuseColor = tint + diffuseColor * ( 1.0 - tint.a );');
    const weight = shader.fragmentShader.indexOf('surfaceAsIsLayer( diffuseColor.rgb, tint.rgb, layerInfo[ i ].asIs, tint.a );');
    const premultiplied = shader.fragmentShader.indexOf('tint.rgb *= tint.a;');
    expect(blend).toBeGreaterThan(0);
    // The layer is handed over premultiplied (what the library adds to the colour) and before the colour blend
    // overwrites diffuseColor, which is the colour beneath it.
    expect(premultiplied).toBeGreaterThan(0);
    expect(weight).toBeGreaterThan(premultiplied);
    expect(weight).toBeLessThan(blend);
    expect(shader.fragmentShader).toContain('float surfaceAsIs;');
    // Idempotent.
    const once = shader.fragmentShader;
    injectOverlayAsIsIntoShader(shader);
    expect(shader.fragmentShader).toBe(once);
  });

  it('is a no-op without the compositor, and throws if the compositor changed shape', () => {
    const plain = { fragmentShader: 'void main() {\n#include <opaque_fragment>\n}' };
    injectOverlayAsIsIntoShader(plain);
    expect(plain.fragmentShader).toBe('void main() {\n#include <opaque_fragment>\n}');
    const drifted = wrapped();
    drifted.fragmentShader = drifted.fragmentShader.replace('diffuseColor = tint + diffuseColor * ( 1.0 - tint.a );', 'diffuseColor = blend( tint );');
    expect(() => injectOverlayAsIsIntoShader(drifted)).toThrow(/overlay shader changed/);
  });
});

describe('lighting modes (#204)', () => {
  it('keeps shadow and flood nonphysical, and applies one definition to any light pair', () => {
    expect(LIGHTING_MODES.natural.physical).toBe(true);
    expect(LIGHTING_MODES.shadow.physical).toBe(false);
    expect(LIGHTING_MODES.flood.physical).toBe(false);
    const ambient = new THREE.AmbientLight();
    const sun = new THREE.DirectionalLight();
    for (const mode of ['natural', 'shadow', 'flood'] as const) {
      applyLightingMode(mode, ambient, sun);
      expect(ambient.color.getHex()).toBe(LIGHTING_MODES[mode].ambientHex);
      expect(sun.intensity).toBe(LIGHTING_MODES[mode].sunIntensity);
    }
    expect(() => applyLightingMode('natural', null, undefined)).not.toThrow();
  });

  it('flood has no direct term, so it cannot show terminator or slope shading', () => {
    const sunDir = V(0, 0, 1);
    expect(directTerm('flood', V(0, 0, 1), sunDir)).toBe(0);
    expect(directTerm('natural', V(0, 0, 1), sunDir)).toBeGreaterThan(0);
  });
});

describe('receiver-relative Sun direction (#204)', () => {
  it('is the direction from the receiver, not from the scene origin', () => {
    // Origin body at 0; Mars-like receiver 1.5 AU away along +X; Sun at +Y 1 AU.
    const origin = V(0, 0, 0), receiver = V(1.5 * AU, 0, 0), sun = V(0, AU, 0);
    const fromOrigin = sunDirectionAt(origin, sun)!;
    const fromReceiver = sunDirectionAt(receiver, sun)!;
    expect(fromOrigin.distanceTo(V(0, 1, 0))).toBeLessThan(1e-12);
    expect(fromReceiver.angleTo(fromOrigin)).toBeGreaterThan(deg(30));
    const light = new THREE.DirectionalLight();
    expect(aimSunLight(light, sun, receiver)).toBe(true);
    const travel = light.target.position.clone().sub(light.position).normalize();
    expect(travel.dot(fromReceiver)).toBeCloseTo(-1, 12);
  });

  it('refuses degenerate geometry instead of aiming at NaN', () => {
    const light = new THREE.DirectionalLight();
    light.position.set(1, 2, 3);
    expect(sunDirectionAt(V(1, 1, 1), V(1, 1, 1))).toBeNull();
    expect(sunDirectionAt(V(NaN, 0, 0), V(1, 1, 1))).toBeNull();
    expect(aimSunLight(light, V(1, 1, 1), V(1, 1, 1))).toBe(false);
    expect(light.position.toArray()).toEqual([1, 2, 3]);
  });

  it('picks the nearest streamed surface by altitude and ignores distant ones', () => {
    const moon = { name: 'moon', position: V(0, 0, 0), radius: 1.7 };
    const earth = { name: 'earth', position: V(400, 0, 0), radius: 6.4 };
    expect(pickIlluminationReceiver(V(0, 0, 3), [earth, moon])?.name).toBe('moon');
    expect(pickIlluminationReceiver(V(400, 0, 7), [moon, earth])?.name).toBe('earth');
    expect(pickIlluminationReceiver(V(0, 0, 3), [{ ...moon, radius: 0 }])).toBeNull();
    expect(pickIlluminationReceiver(V(0, 0, 1e6), [moon, earth])).toBeNull();
    expect(pickIlluminationReceiver(V(0, 0, 3), [])).toBeNull();
  });
});

describe('synthetic neutral-albedo sloped plane and ridge (#204)', () => {
  // A flat plane tilted by `slope` about the Y axis (normal leans toward +X),
  // lit by a Sun at elevation e above the +X horizon. Neutral albedo means the
  // direct term is exactly intensity × cos(incidence).
  const sunAt = (elevationDeg: number) => V(Math.cos(deg(elevationDeg)), 0, Math.sin(deg(elevationDeg)));
  const normalTilted = (slopeDeg: number) => V(Math.sin(deg(slopeDeg)), 0, Math.cos(deg(slopeDeg)));

  it('matches cos(incidence) analytically for a range of slopes and Sun elevations', () => {
    for (const slope of [-40, -10, 0, 10, 40]) {
      for (const el of [5, 20, 45, 80]) {
        const expected = Math.max(0, Math.cos(deg(90 - el - slope)));
        expect(incidenceCosine(normalTilted(slope), sunAt(el))).toBeCloseTo(expected, 12);
        expect(directTerm('natural', normalTilted(slope), sunAt(el))).toBeCloseTo(2 * expected, 12);
      }
    }
  });

  it('brightens sun-facing slopes, darkens back-facing ones, and is dark past the terminator', () => {
    const el = 10, sun = sunAt(el);
    const facing = directTerm('natural', normalTilted(30), sun);
    const flat = directTerm('natural', normalTilted(0), sun);
    const away = directTerm('natural', normalTilted(-30), sun);
    expect(facing).toBeGreaterThan(flat);
    expect(flat).toBeGreaterThan(away);
    // A 30° back slope under a 10° Sun is tilted 20° beyond grazing: no direct light.
    expect(away).toBe(0);
  });

  it('gives a ridge pair opposite responses and no residual light on the lee side while the Sun is up', () => {
    // Ridge: +X-facing flank at +25°, -X-facing flank at -25°; Sun 15° above +X.
    const sun = sunAt(15);
    const windward = directTerm('natural', normalTilted(25), sun);
    const lee = directTerm('natural', normalTilted(-25), sun);
    expect(windward).toBeCloseTo(2 * Math.cos(deg(90 - 15 - 25)), 12);
    expect(lee).toBe(0); // the Sun is globally up, the receiver's own incidence is negative
    // Flood leaves both flanks identical (and zero direct), clearly nonphysical.
    expect(directTerm('flood', normalTilted(25), sun)).toBe(directTerm('flood', normalTilted(-25), sun));
  });

  it('puts the terminator at zero elevation and responds monotonically to elevation', () => {
    const up = V(0, 0, 1);
    let previous = -1;
    for (const el of [-10, 0, 1, 10, 30, 60, 90]) {
      const value = directTerm('natural', up, sunAt(el));
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(directTerm('natural', up, sunAt(0))).toBeCloseTo(0, 12);
    expect(directTerm('natural', up, sunAt(-10))).toBe(0);
  });
});

describe('Sun elevation and azimuth at a surface point (#204)', () => {
  const R = 1737.4 * 1e-6; // Moon radius in scene units
  const identity = new THREE.Quaternion();
  const body = V(0, 0, 0);

  it('is 90° with the Sun overhead and 0° at the terminator', () => {
    const sun = V(AU, 0, 0);
    expect(solarGeometryAt(body, identity, sun, R, 0, 0)!.elevationDeg).toBeCloseTo(90, 6);
    expect(solarGeometryAt(body, identity, sun, R, 0, 90)!.elevationDeg).toBeCloseTo(0, 2); // finite-distance parallax ≈ 7e-4°
    expect(solarGeometryAt(body, identity, sun, R, 0, 180)!.cosIncidence).toBeLessThan(-0.999);
  });

  it('reports azimuth clockwise from north', () => {
    // Observer at lon 0, lat 0: up=+X, east=+Y, north=+Z.
    const sunEast = solarGeometryAt(body, identity, V(0, AU, 0), R, 0, 0)!;
    const sunNorth = solarGeometryAt(body, identity, V(0, 0, AU), R, 0, 0)!;
    const sunSouth = solarGeometryAt(body, identity, V(0, 0, -AU), R, 0, 0)!;
    expect(sunEast.azimuthDeg).toBeCloseTo(90, 3);
    expect(sunNorth.azimuthDeg).toBeCloseTo(0, 3);
    expect(sunSouth.azimuthDeg).toBeCloseTo(180, 3);
  });

  it('gives a polar site a grazing Sun at the Moon-like 1.5° axial tilt', () => {
    // South pole, Sun 1.5° above the equatorial plane: ~1.5° elevation, never overhead.
    const sun = V(AU * Math.cos(deg(1.5)), 0, AU * Math.sin(deg(1.5)));
    const south = solarGeometryAt(body, identity, sun, R, -90, 0)!;
    const north = solarGeometryAt(body, identity, sun, R, 90, 0)!;
    expect(south.elevationDeg).toBeCloseTo(-1.5, 2);
    expect(north.elevationDeg).toBeCloseTo(1.5, 2);
  });

  it('follows a rotating body, a moving Sun, and a time seek, with no hidden state', () => {
    const lat = 10, lon = 0;
    const at = (hours: number, sunAngleDeg: number) => {
      // Body spin about Z: 360° per 24 h. Sun on a slow circle in the XY plane.
      const q = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), deg(15 * hours));
      const sun = V(AU * Math.cos(deg(sunAngleDeg)), AU * Math.sin(deg(sunAngleDeg)), 0);
      return solarGeometryAt(body, q, sun, R, lat, lon)!;
    };
    // Spin the body a quarter turn: a point under the Sun at hour 0 is at the terminator at hour 6.
    expect(at(0, 0).elevationDeg).toBeCloseTo(80, 3);
    expect(at(6, 0).elevationDeg).toBeCloseTo(0, 2);
    expect(at(12, 0).elevationDeg).toBeLessThan(-79);
    // Moving the Sun by the same angle the body rotated restores the geometry.
    expect(at(6, 90).elevationDeg).toBeCloseTo(at(0, 0).elevationDeg, 9);
    expect(at(6, 90).azimuthDeg).toBeCloseTo(at(0, 0).azimuthDeg, 9);
    // Seeking forward, back and forward again is order independent.
    const first = at(3.3, 12), seek = at(17, 80), again = at(3.3, 12);
    expect(seek.elevationDeg).not.toBeCloseTo(first.elevationDeg, 1);
    expect(again).toEqual(first);
  });

  it('is invariant to the camera-relative origin shift: only the Sun-to-body vector matters', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), deg(33));
    const sunRel = V(AU, 0.2 * AU, -0.1 * AU);
    const a = solarGeometryAt(body, q, sunRel, R, -45, 70)!;
    const shift = V(123.4, -56.7, 8.9);
    const b = solarGeometryAt(body.clone().add(shift), q, sunRel.clone().add(shift), R, -45, 70)!;
    expect(b.elevationDeg).toBeCloseTo(a.elevationDeg, 9);
    expect(b.azimuthDeg).toBeCloseTo(a.azimuthDeg, 9);
  });

  it('returns null when the Sun is at the surface point', () => {
    expect(solarGeometryAt(body, identity, V(R, 0, 0), R, 0, 0)).toBeNull();
  });
});
