import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  MAX_SHADOW_OCCLUDERS,
  SHADOW_FRAG_PARS,
  injectShadowIntoShader,
  makeShadowUniforms,
  selectShadowOccluders,
  type ShadowOccluder,
} from '../EclipseShadow.js';
import { injectAerialPerspectiveIntoShader, makeAerialPerspectiveUniforms } from '../AerialPerspective.js';
import { injectRingShadowIntoShader, makeRingShadowUniforms } from '../RingShadow.js';
import { RingMesh } from '../RingMesh.js';

// Scene units: kilometres × scaleFactor, matching UniverseRenderer's default.
const S = 1e-6;
const km = (v: number) => v * S;
const SUN_RADIUS = km(695700);

const AU = 1.495978707e8;

function v(x: number, y = 0, z = 0) { return new THREE.Vector3(x, y, z); }

/**
 * Sun at the scene origin, receiver out along +X — the geometry the renderer
 * produces when the floating origin sits on the star.
 */
function sunAtOrigin() { return v(0, 0, 0); }

// ---------------------------------------------------------------------------
// Occluder selection
// ---------------------------------------------------------------------------

describe('selectShadowOccluders', () => {
  const earthPos = v(km(AU));
  const earthRadius = km(6378);

  it('picks a moon that is transiting the sun', () => {
    const moon: ShadowOccluder = { pos: v(km(AU - 384400)), radius: km(1737) };
    const got = selectShadowOccluders([moon], earthPos, earthRadius, sunAtOrigin(), SUN_RADIUS);
    expect(got).toEqual([moon]);
  });

  it('drops a moon on the far side of the receiver', () => {
    // Same distance, but anti-sunward: it cannot shadow anything here.
    const moon: ShadowOccluder = { pos: v(km(AU + 384400)), radius: km(1737) };
    expect(selectShadowOccluders([moon], earthPos, earthRadius, sunAtOrigin(), SUN_RADIUS)).toEqual([]);
  });

  it('drops a moon whose penumbra misses the receiver entirely', () => {
    // Sunward, but a full lunar orbit off the sun-receiver line.
    const moon: ShadowOccluder = { pos: v(km(AU - 384400), km(384400)), radius: km(1737) };
    expect(selectShadowOccluders([moon], earthPos, earthRadius, sunAtOrigin(), SUN_RADIUS)).toEqual([]);
  });

  it('ignores an occluder sitting on the sun instead of blacking out the receiver', () => {
    // A barycenter at the star's own position used to pass the cone test with a
    // penumbra as wide as the sun, shadowing every fragment on the receiver.
    const onTheSun: ShadowOccluder = { pos: sunAtOrigin(), radius: km(100) };
    expect(selectShadowOccluders([onTheSun], earthPos, earthRadius, sunAtOrigin(), SUN_RADIUS)).toEqual([]);
  });

  it('never returns more than the shader has slots for', () => {
    const many: ShadowOccluder[] = Array.from({ length: 10 }, (_, i) => ({
      pos: v(km(AU - 200000 - i * 1000), km(i * 50)),
      radius: km(1500),
    }));
    const got = selectShadowOccluders(many, earthPos, earthRadius, sunAtOrigin(), SUN_RADIUS);
    expect(got.length).toBe(MAX_SHADOW_OCCLUDERS);
  });

  it('ranks the transiting moon over a nearer, larger one that is off the sun line', () => {
    const transiting: ShadowOccluder = { pos: v(km(AU - 200000)), radius: km(200) };
    const bigButOffAxis: ShadowOccluder = { pos: v(km(AU - 100000), km(100000)), radius: km(2500) };
    const got = selectShadowOccluders(
      [bigButOffAxis, transiting], earthPos, earthRadius, sunAtOrigin(), SUN_RADIUS,
    );
    expect(got[0]).toEqual(transiting);
  });

  // The regression the ranking change is for: in a moon system, apparent size
  // is essentially fixed by orbital radius, so ordering by it hands the four
  // slots to the same moons every frame — and the close-in fast movers, which
  // transit most often, never get one.
  it('gives a transiting inner moon a slot ahead of non-transiting outer moons', () => {
    const saturnPos = v(km(9.5 * AU));
    const saturnRadius = km(60268);
    // Saturn's system at cassini-soi's radii. Only Mimas is on the sun line.
    const mimas: ShadowOccluder = { pos: v(km(9.5 * AU - 185540)), radius: km(209) };
    // Placed a quarter-orbit away: sunward component zero, fully off-axis.
    const offLine = (orbitKm: number, radiusKm: number): ShadowOccluder => ({
      pos: v(km(9.5 * AU), km(orbitKm)),
      radius: km(radiusKm),
    });
    const candidates = [
      offLine(1221870, 2575), // Titan
      offLine(527070, 764),   // Rhea
      offLine(377420, 562),   // Dione
      offLine(294670, 533),   // Tethys
      mimas,
    ];

    const got = selectShadowOccluders(candidates, saturnPos, saturnRadius, sunAtOrigin(), SUN_RADIUS);
    expect(got).toContainEqual(mimas);

    // Ranking by apparent size — the old behaviour — filled all four of its
    // slots with the outer moons and dropped Mimas. The 4 is the old code's
    // own literal, not MAX_SHADOW_OCCLUDERS: this describes what shipped, so it
    // must not move if the slot count is ever retuned.
    const byApparentSize = [...candidates]
      .sort((a, b) =>
        b.radius / b.pos.distanceTo(saturnPos) - a.radius / a.pos.distanceTo(saturnPos))
      .slice(0, 4);
    expect(byApparentSize).not.toContainEqual(mimas);
  });

  // Real geometry, not a constructed one. Saturn's heliocentric position comes
  // from de440s and the moon positions from TASS17 — the same analytical theory
  // the renderer drives the moons with — at 2023-03-07T23:00Z, an epoch found by
  // scanning 2004-2030 for a tick where exactly one moon's shadow lands on
  // Saturn. Hardcoded so the test needs no kernels.
  //
  // Saturn's sub-solar latitude runs to +-27 degrees, so moon shadows only
  // reach the planet near its equinoxes, and the closer-in a moon orbits the
  // wider its window: Mimas casts whenever |lat| < 19 degrees, Titan only
  // within 2.8. Across that span Mimas accounts for more shadow-on-Saturn time
  // than every other moon combined, and apparent-size ranking put it last.
  it('picks the one moon actually casting on Saturn at a real epoch', () => {
    const saturnPos = v(0, 0, 0); // work in Saturn-centred scene coordinates
    const saturnRadius = km(60268);
    const sun = v(km(-1245747314.05), km(777426994.333), km(36058658.05));
    const moons: Record<string, ShadowOccluder> = {
      Mimas:     { pos: v(km(-159292.5), km(85458.0), km(-26429.7)),    radius: km(209) },
      Enceladus: { pos: v(km(49455.5), km(-207113.9), km(103819.7)),    radius: km(256) },
      Tethys:    { pos: v(km(-64442.1), km(-249338.4), km(143125.7)),   radius: km(536) },
      Dione:     { pos: v(km(-84917.5), km(329543.1), km(-164268.6)),   radius: km(560) },
      Rhea:      { pos: v(km(-298521.1), km(-372758.9), km(223295.3)),  radius: km(764) },
      Titan:     { pos: v(km(-757106.0), km(911316.8), km(-394505.2)),  radius: km(2575) },
      Hyperion:  { pos: v(km(1052586.9), km(932625.7), km(-564215.3)),  radius: km(135) },
      Iapetus:   { pos: v(km(-1874396.6), km(3049916.5), km(-327022.4)), radius: km(718) },
    };
    const names = Object.keys(moons);
    const got = selectShadowOccluders(
      Object.values(moons), saturnPos, saturnRadius, sun, SUN_RADIUS,
    );
    const picked = got.map(o => names.find(n => moons[n].pos === o.pos));
    expect(picked).toEqual(['Mimas']);

    // Apparent-size ranking filled all four of its slots and left out the only
    // moon whose shadow is on the planet. As above, 4 is the old code's literal.
    const byApparentSize = names
      .sort((a, b) =>
        moons[b].radius / moons[b].pos.length() - moons[a].radius / moons[a].pos.length())
      .slice(0, 4);
    expect(byApparentSize).not.toContain('Mimas');
  });

  it('keeps the parent planet when the receiver is its ring system', () => {
    const saturnPos = v(km(9.5 * AU));
    const saturn: ShadowOccluder = { pos: saturnPos, radius: km(60268) };
    // Ring "receiver" is centered on the planet with the outer ring radius.
    const got = selectShadowOccluders(
      [saturn], saturnPos, km(140220), sunAtOrigin(), SUN_RADIUS,
    );
    expect(got).toEqual([saturn]);
  });
});

// ---------------------------------------------------------------------------
// Shader generation
// ---------------------------------------------------------------------------

/** Minimal stand-in for the chunks three's ShaderLib hands onBeforeCompile. */
function fakeShader() {
  return {
    vertexShader: [
      '#define STANDARD',
      'void main() {',
      '  #include <begin_vertex>',
      '  #include <project_vertex>',
      '}',
    ].join('\n'),
    fragmentShader: [
      '#define STANDARD',
      'void main() {',
      '  vec3 outgoingLight = totalDiffuse + totalSpecular;',
      '  #include <opaque_fragment>',
      '}',
    ].join('\n'),
    uniforms: {} as Record<string, unknown>,
  };
}

describe('injectShadowIntoShader', () => {
  it('declares the varying, writes it, and attenuates outgoingLight', () => {
    const shader = fakeShader();
    injectShadowIntoShader(shader, makeShadowUniforms() as unknown as Record<string, { value: unknown }>);

    expect(shader.vertexShader).toContain('varying vec3 vShadowWorldPos;');
    expect(shader.vertexShader).toContain('vShadowWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    // The write has to land AFTER project_vertex, where `transformed` exists.
    expect(shader.vertexShader.indexOf('#include <project_vertex>'))
      .toBeLessThan(shader.vertexShader.indexOf('vShadowWorldPos ='));

    for (const decl of ['uSunWorldPos', 'uSunRadius', 'uShadowOccluderPos', 'uShadowOccluderRadius', 'uShadowOccluderCount']) {
      expect(shader.fragmentShader).toContain(decl);
      expect(shader.uniforms).toHaveProperty(decl);
    }
    expect(shader.fragmentShader).toContain('float computeEclipseShadow()');
    expect(shader.fragmentShader).toContain('outgoingLight *= computeEclipseShadow();');
    // Attenuation must precede the write to gl_FragColor.
    expect(shader.fragmentShader.indexOf('outgoingLight *= computeEclipseShadow();'))
      .toBeLessThan(shader.fragmentShader.indexOf('#include <opaque_fragment>'));
  });

  it('shares the uniform objects by reference so per-frame updates reach the GPU', () => {
    const shader = fakeShader();
    const su = makeShadowUniforms();
    injectShadowIntoShader(shader, su as unknown as Record<string, { value: unknown }>);
    expect(shader.uniforms.uShadowOccluderPos).toBe(su.uShadowOccluderPos);
    expect(shader.uniforms.uShadowOccluderCount).toBe(su.uShadowOccluderCount);
  });

  // Four consumers carry the shadow uniform block: the body material, the ring
  // material, the atmosphere shell and the sky-view LUT. They are fed from one
  // occluder list, so a setter that caps at its own literal would either write
  // past its uniform array or silently ignore slots the others use.
  it('caps every setter at the number of slots its uniforms actually have', () => {
    const many: ShadowOccluder[] = Array.from({ length: MAX_SHADOW_OCCLUDERS + 3 }, (_, i) => ({
      pos: v(km(1000 * (i + 1))), radius: km(100),
    }));
    const ring = new RingMesh(km(74660), km(140220));
    expect(() => ring.setShadowOccluders(many, v(1), 0.7)).not.toThrow();
    const u = (ring as unknown as { shadowUniforms: ReturnType<typeof makeShadowUniforms> }).shadowUniforms;
    expect(u.uShadowOccluderCount.value).toBe(MAX_SHADOW_OCCLUDERS);
    expect(u.uShadowOccluderPos.value).toHaveLength(MAX_SHADOW_OCCLUDERS);
    expect(u.uShadowOccluderRadius.value).toHaveLength(MAX_SHADOW_OCCLUDERS);
  });

  it('sizes its arrays and its loop to MAX_SHADOW_OCCLUDERS', () => {
    expect(SHADOW_FRAG_PARS).toContain(`uniform vec3  uShadowOccluderPos[${MAX_SHADOW_OCCLUDERS}];`);
    expect(SHADOW_FRAG_PARS).toContain(`for (int i = 0; i < ${MAX_SHADOW_OCCLUDERS}; i++)`);
    expect(makeShadowUniforms().uShadowOccluderPos.value).toHaveLength(MAX_SHADOW_OCCLUDERS);
    expect(makeShadowUniforms().uShadowOccluderRadius.value).toHaveLength(MAX_SHADOW_OCCLUDERS);
  });

  // Saturn takes all three injections; each composes onto the previous one's
  // output the way BodyMesh's enable* methods chain onBeforeCompile.
  it('survives composition with aerial perspective and ring shadow', () => {
    const shader = fakeShader();
    injectShadowIntoShader(shader, makeShadowUniforms() as unknown as Record<string, { value: unknown }>);
    injectAerialPerspectiveIntoShader(shader, makeAerialPerspectiveUniforms() as unknown as Record<string, { value: unknown }>);
    injectRingShadowIntoShader(shader, makeRingShadowUniforms() as unknown as Record<string, { value: unknown }>);

    expect(shader.fragmentShader).toContain('float computeEclipseShadow()');
    expect(shader.fragmentShader).toContain('outgoingLight *= computeEclipseShadow() * computeRingShadow();');
    expect(shader.fragmentShader).toContain('computeAerialPerspective(vAPWorldPos)');
    // Ring shadow reads vShadowWorldPos / uSunWorldPos, so its function must be
    // declared after SHADOW_FRAG_PARS opens but before computeEclipseShadow.
    expect(shader.fragmentShader.indexOf('varying vec3 vShadowWorldPos;'))
      .toBeLessThan(shader.fragmentShader.indexOf('float computeRingShadow()'));
    expect(shader.fragmentShader.indexOf('float computeRingShadow()'))
      .toBeLessThan(shader.fragmentShader.indexOf('float computeEclipseShadow()'));
  });
});

// ---------------------------------------------------------------------------
// Shader math, mirrored on the CPU
// ---------------------------------------------------------------------------

/**
 * Line-for-line port of `computeEclipseShadow()`. Keeps the umbra/penumbra
 * behaviour under test without a GL context; the GLSL above is the source of
 * truth and any edit there belongs here too.
 */
function computeEclipseShadow(
  fragPos: THREE.Vector3,
  sunPos: THREE.Vector3,
  sunRadius: number,
  occluders: readonly ShadowOccluder[],
): number {
  const toSun = sunPos.clone().sub(fragPos);
  const distToSun = toSun.length();
  if (distToSun < 1e-20) return 1;
  const rayDir = toSun.divideScalar(distToSun);
  let shadowFactor = 1;
  for (const occ of occluders.slice(0, MAX_SHADOW_OCCLUDERS)) {
    const toOcc = occ.pos.clone().sub(fragPos);
    const t = toOcc.dot(rayDir);
    if (t < 1e-10 || t > distToSun - sunRadius) continue;
    const closestDist = toOcc.clone().addScaledVector(rayDir, -t).length();
    const penumbra = sunRadius * (t / distToSun);
    const innerR = Math.max(0, occ.radius - penumbra);
    const outerR = occ.radius + penumbra;
    if (outerR <= 0 || closestDist > outerR) continue;
    const x = Math.min(1, Math.max(0, (closestDist - innerR) / (outerR - innerR)));
    shadowFactor *= x * x * (3 - 2 * x);
  }
  return shadowFactor;
}

describe('computeEclipseShadow (CPU mirror of the GLSL)', () => {
  const sun = sunAtOrigin();

  it('darkens the sub-solar point during a Moon -> Earth eclipse', () => {
    const earth = v(km(AU));
    const moon: ShadowOccluder = { pos: v(km(AU - 384400)), radius: km(1737) };
    const subSolar = earth.clone().add(v(-km(6378)));
    expect(computeEclipseShadow(subSolar, sun, SUN_RADIUS, [moon])).toBeLessThan(0.05);
  });

  it('leaves the limb, a full Earth radius off the shadow axis, brighter than the axis', () => {
    const earth = v(km(AU));
    const moon: ShadowOccluder = { pos: v(km(AU - 384400)), radius: km(1737) };
    const axis = earth.clone().add(v(-km(6378)));
    const limb = earth.clone().add(v(0, km(6378)));
    expect(computeEclipseShadow(limb, sun, SUN_RADIUS, [moon]))
      .toBeGreaterThan(computeEclipseShadow(axis, sun, SUN_RADIUS, [moon]));
  });

  it('darkens Saturn under a transiting Mimas', () => {
    const saturn = v(km(9.5 * AU));
    const mimas: ShadowOccluder = { pos: v(km(9.5 * AU - 185540)), radius: km(209) };
    const subMimas = saturn.clone().add(v(-km(60268)));
    expect(computeEclipseShadow(subMimas, sun, SUN_RADIUS, [mimas])).toBeLessThan(0.5);
  });

  it('is unlit-free with no occluders', () => {
    expect(computeEclipseShadow(v(km(AU)), sun, SUN_RADIUS, [])).toBe(1);
  });

  it('does not black out a receiver for an occluder sitting on the sun', () => {
    const earth = v(km(AU));
    const onTheSun: ShadowOccluder = { pos: sun.clone(), radius: km(100) };
    expect(computeEclipseShadow(earth.clone().add(v(-km(6378))), sun, SUN_RADIUS, [onTheSun])).toBe(1);
  });
});
