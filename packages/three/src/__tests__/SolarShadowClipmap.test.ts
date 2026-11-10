import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  SolarShadowClipmap, gnomonicCoordinates, gnomonicDirection, injectSolarShadowIntoShader, tangentFrame,
  type ClipmapSource, type SolarShadowFrame,
} from '../SolarShadowClipmap.js';

const R = 1737.4;
const DEG = Math.PI / 180;
const datum = { referenceShape: { kind: 'sphere' as const, radiusKm: R }, verticalDatum: 'reference-sphere' as const, heightConvention: 'radial' as const };

/** A body-fixed km position `altKm` above the surface at lat/lon. */
const at = (latDeg: number, lonDeg: number, altKm: number) => {
  const r = R + altKm, c = Math.cos(latDeg * DEG);
  return new THREE.Vector3(r * c * Math.cos(lonDeg * DEG), r * c * Math.sin(lonDeg * DEG), r * Math.sin(latDeg * DEG));
};

function frameAt(latDeg: number, lonDeg: number, altKm: number, sun = new THREE.Vector3(1e8, 0, 0)): SolarShadowFrame {
  const camera = new THREE.PerspectiveCamera();
  camera.position.copy(at(latDeg, lonDeg, altKm));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return { camera, bodyPosition: new THREE.Vector3(), bodyToScene: new THREE.Quaternion(), sunPosition: sun, scaleFactor: 1 };
}

/** A 1 km-high hill of 3 km radius at (-89.5, 0); flat elsewhere; no data east of lon 100 while `holes`. */
function source(opts: { holes?: boolean } = {}): ClipmapSource & { revision: number; holes: boolean } {
  return {
    datum, revision: 0, holes: !!opts.holes,
    elevationKm(lat, lon) {
      if (this.holes && lon > 100) return null;
      const d = Math.abs((lat + 89.5) * DEG * R); // coarse: along the meridian only
      return Math.abs(lon) < 1 && d < 3 ? 1 : 0;
    },
  };
}

const settle = (c: SolarShadowClipmap, f: SolarShadowFrame, t = 0, n = 12) => { for (let i = 0; i < n; i++) c.update(f, t); };

describe('gnomonic clipmap frame (#205)', () => {
  it('round-trips tangent-plane coordinates through body-fixed directions, at the pole too', () => {
    for (const up of [[0, 0, -1], [0, 0, 1], [1, 0, 0], [0.6, 0.8, 0]] as const) {
      const f = tangentFrame([...up]);
      for (const [e, n] of [[0, 0], [30, -12], [-200, 150]]) {
        const d = gnomonicDirection(f, e, n, R);
        const back = gnomonicCoordinates(f, d, R)!;
        expect(back[0]).toBeCloseTo(e, 6);
        expect(back[1]).toBeCloseTo(n, 6);
        expect(Math.hypot(...d)).toBeCloseTo(1, 12);
      }
    }
    expect(gnomonicCoordinates(tangentFrame([0, 0, 1]), [0, 0, -1], R)).toBeNull();
  });
});

describe('SolarShadowClipmap (#205)', () => {
  it('fills every level from source terrain and reports ready', () => {
    const c = new SolarShadowClipmap(source(), { budgetMs: 1e6 });
    settle(c, frameAt(-89.5, 0, 2));
    expect(c.status.state).toBe('ready');
    expect(c.status.levels.every(l => l.valid && l.unknownFraction === 0)).toBe(true);
    expect(c.uniforms.enabled.value).toBe(1);
    // A hill 1 km high near the anchor appears at its location, flat terrain elsewhere (radius above the anchor sphere).
    const hill = c.heightAt(0, 0)!;
    expect(hill.level).toBe(0);
    expect(hill.heightKm).toBeCloseTo(1, 6);
    expect(c.heightAt(6, 6)!.heightKm).toBeCloseTo(0, 6);
  });

  it('keeps terrain with no source coverage unknown, never a height', () => {
    const c = new SolarShadowClipmap(source({ holes: true }), { budgetMs: 1e6 });
    // Anchor at lon 150, where the source has no data at all.
    settle(c, frameAt(-89.5, 150, 2));
    expect(c.status.state).toBe('partial');
    expect(c.status.levels[0].unknownFraction).toBeGreaterThan(0.5);
    expect(c.heightAt(1, 1)!.heightKm).toBeNull();
  });

  it('leaves terrain whose source is too coarse out of the shadow: final, not waiting for data', () => {
    const coarseEast = { ...source(), cellKm: (_lat: number, lon: number) => (lon > 0 ? 6.8 : 0.01) };
    const c = new SolarShadowClipmap(coarseEast, { budgetMs: 1e6, levels: [{ halfKm: 8, size: 64 }] });
    settle(c, frameAt(-89.5, 0, 2));
    const l = c.status.levels[0];
    expect(l.coarseFraction).toBeGreaterThan(0.3);
    expect(l.coarseFraction).toBeLessThan(0.7);
    expect(l.unknownFraction).toBe(0);
    expect(c.status.state).toBe('ready');
    // Coarse terrain is no height (not shadowing), and a new data revision does not rebuild for it.
    const builds = l.builds;
    coarseEast.revision++;
    settle(c, frameAt(-89.5, 0, 2), 10_000);
    expect(c.status.levels[0].builds).toBe(builds);
    const g = [0, 1, 2, 3, 4, 5, 6, 7].map(k => c.heightAt(-7 + 2 * k, 0)?.heightKm ?? null);
    expect(g.some(h => h === null) && g.some(h => h !== null)).toBe(true);
  });

  it('keeps every level on one site while the view stays within 4 camera altitudes of it, and resets past the anchor limit', () => {
    const c = new SolarShadowClipmap(source(), { budgetMs: 1e6, levels: [{ halfKm: 8, size: 64 }, { halfKm: 24, size: 64 }] });
    settle(c, frameAt(-89.5, 0, 2));
    const builds = () => c.status.levels[0].builds;
    expect(builds()).toBe(1);
    // 6 km at 2 km up (limit 8 km): no level moves, so a ground point keeps its level and its value.
    const g: [number, number] = [5, 0], before = c.heightAt(...g);
    settle(c, frameAt(-89.5 + 6 / R / DEG, 0, 2));
    expect(c.status.levels.map(l => l.builds)).toEqual([1, 1]);
    expect(c.heightAt(...g)).toEqual(before);
    // The same 6 km at 1 km up (limit max(4, 4) km): the site moves there, every level re-centres on it.
    settle(c, frameAt(-89.5 + 6 / R / DEG, 0, 1));
    expect(c.status.siteMoves).toBe(2);
    expect(c.status.levels.map(l => l.builds)).toEqual([2, 2]);
    expect(c.status.levels[0].offsetKm).toEqual(c.status.levels[1].offsetKm);
    // A re-centre samples only the newly exposed strip (6 km = 24 texels of 64) and keeps drawing the old data meanwhile.
    expect(c.status.levels[0].lastReason).toBe('recenter');
    expect(c.status.levels[0].lastSampledTexels).toBe(24 * 64);
    expect(c.status.anchorResets).toBe(1);
    // 12° away resets the anchor, so the level is rebuilt in a new frame.
    settle(c, frameAt(-77.5, 0, 2));
    expect(builds()).toBe(3);
    expect(c.status.anchorResets).toBe(2);
    expect(c.status.siteMoves).toBe(3);
    expect(c.status.levels[0].lastReason).toBe('initial');
  });

  it('stays ready, drawing the current data, while a level re-centres over several frames', () => {
    const c = new SolarShadowClipmap(source(), { budgetMs: 1e6, levels: [{ halfKm: 8, size: 64 }] });
    settle(c, frameAt(-89.5, 0, 2));
    const slow = new SolarShadowClipmap(source(), { budgetMs: 0, levels: [{ halfKm: 8, size: 64 }] });
    for (let i = 0; i < 80; i++) slow.update(frameAt(-89.5, 0, 2));
    expect(slow.status.state).toBe('ready');
    const before = slow.uniforms.tex0.value;
    slow.update(frameAt(-89.5 + 9 / R / DEG, 0, 2)); // starts a re-centre, one row per frame
    expect(slow.status.state).toBe('ready');
    expect(slow.uniforms.tex0.value).toBe(before);
    expect(slow.uniforms.enabled.value).toBe(1);
    expect(c.status.state).toBe('ready');
  });

  it('keeps a re-centred level on its current data until the new strip\'s source tiles load (at most 2 s)', () => {
    // Tiles beyond the first square's corners (11.9 km from its centre) are "in flight" until `loaded`.
    const centre = at(-89.5, 0, 0).normalize();
    const src = { ...source(), loaded: false, elevationKm(lat: number, lon: number) {
      return !this.loaded && Math.acos(Math.min(1, at(lat, lon, 0).normalize().dot(centre))) * R > 11.9 ? null : 0;
    } };
    const c = new SolarShadowClipmap(src, { budgetMs: 1e6, levels: [{ halfKm: 8, size: 64 }] });
    settle(c, frameAt(-89.5, 0, 2), 0);
    const offset = c.status.levels[0].offsetKm;
    expect(c.status.levels[0].unknownFraction).toBe(0);
    const moved = frameAt(-89.5 + 5 / R / DEG, 0, 0.5);
    settle(c, moved, 500);
    expect(c.status.levels[0].offsetKm).toEqual(offset); // still the complete, old placement
    expect(c.status.state).toBe('ready');
    src.loaded = true;
    settle(c, moved, 700);
    expect(c.status.levels[0].offsetKm).not.toEqual(offset);
    expect(c.status.levels[0].unknownFraction).toBe(0);
    // Tiles that never arrive: swapped in, unknown, after the wait.
    src.loaded = false;
    const far = frameAt(-89.5 + 10 / R / DEG, 0, 0.5);
    settle(c, far, 1000);
    const waiting = c.status.levels[0].offsetKm;
    settle(c, far, 3500);
    expect(c.status.levels[0].offsetKm).not.toEqual(waiting);
    expect(c.status.levels[0].unknownFraction).toBeGreaterThan(0);
  });

  it('is off above the maximum altitude and when deactivated', () => {
    const c = new SolarShadowClipmap(source(), { budgetMs: 1e6 });
    settle(c, frameAt(-89.5, 0, 2000));
    expect(c.status.state).toBe('out-of-range');
    expect(c.uniforms.enabled.value).toBe(0);
    settle(c, frameAt(-89.5, 0, 2));
    expect(c.uniforms.enabled.value).toBe(1);
    c.setActive(false);
    c.update(frameAt(-89.5, 0, 2));
    expect(c.uniforms.enabled.value).toBe(0);
  });

  it('rebuilds when resident data change only while coverage is incomplete, and not faster than the throttle', () => {
    const src = source({ holes: true });
    const c = new SolarShadowClipmap(src, { budgetMs: 1e6, levels: [{ halfKm: 8, size: 64 }] });
    const f = frameAt(0, 150, 2); // all unknown: east of lon 100
    settle(c, f, 0);
    expect(c.status.levels[0].builds).toBe(1);
    expect(c.status.levels[0].unknownFraction).toBe(1);
    src.revision++; settle(c, f, 500);   // too soon
    expect(c.status.levels[0].builds).toBe(1);
    src.holes = false; src.revision++; settle(c, f, 3000); // data arrived: rebuild
    expect(c.status.levels[0].builds).toBe(2);
    expect(c.status.levels[0].lastReason).toBe('new-data');
    expect(c.status.levels[0].unknownFraction).toBe(0);
    src.revision++; settle(c, f, 20000); // complete: more data cannot improve it
    expect(c.status.levels[0].builds).toBe(2);
  });

  it('spreads a build over frames within the CPU budget', () => {
    const c = new SolarShadowClipmap(source(), { budgetMs: 0, levels: [{ halfKm: 8, size: 64 }] });
    const f = frameAt(-89.5, 0, 2);
    c.update(f); // budget 0 still does one row: progress without stalling
    expect(c.status.state).toBe('building');
    expect(c.uniforms.enabled.value).toBe(0);
    for (let i = 0; i < 80; i++) c.update(f);
    expect(c.status.state).toBe('ready');
  });

  it('puts the Sun in tangent axes and sizes its disk from the distance', () => {
    const c = new SolarShadowClipmap(source(), { budgetMs: 1e6 });
    // Sun 1 AU along body +X; the anchor at the south pole sees it on the horizon (up is -Z).
    settle(c, frameAt(-89.99, 0, 2, new THREE.Vector3(1.496e8, 0, 0)));
    const s = c.uniforms.sun.value;
    expect(s.length()).toBeCloseTo(1, 6);
    expect(Math.abs(s.z)).toBeLessThan(0.01);
    expect(c.uniforms.sunRad.value).toBeCloseTo(695_700 / 1.496e8, 4);
  });
});

describe('injectSolarShadowIntoShader (#205)', () => {
  const stub = () => ({
    uniforms: {} as Record<string, unknown>,
    fragmentShader: 'void main() {\n#include <lights_fragment_end>\n#include <opaque_fragment>\n}',
  });
  it('attenuates only the direct terms and registers its uniforms', () => {
    const c = new SolarShadowClipmap(source());
    const shader = stub();
    injectSolarShadowIntoShader(shader, c.uniforms);
    expect(shader.fragmentShader).toContain('reflectedLight.directDiffuse *= solarVis');
    expect(shader.fragmentShader).toContain('reflectedLight.directSpecular *= solarVis');
    expect(shader.fragmentShader).not.toContain('indirect');
    expect(Object.keys(shader.uniforms)).toContain('uSsTex2');
    // Idempotent on a second pass.
    const once = shader.fragmentShader;
    injectSolarShadowIntoShader(shader, c.uniforms);
    expect(shader.fragmentShader).toBe(once);
  });
  it('fails loudly if the Three.js hooks change', () => {
    const c = new SolarShadowClipmap(source());
    expect(() => injectSolarShadowIntoShader({ fragmentShader: 'void main() {}' }, c.uniforms)).toThrow(/hook changed/);
  });
});

describe('SolarShadowClipmap.sunFractionAt (#205)', () => {
  // A north-south ridge 1 km high and 2 km wide, 6 km east of (0, 0); the Sun 2° above the eastern horizon there.
  const ridge: ClipmapSource = { datum, revision: 0, elevationKm: (_lat, lon) => (Math.abs(lon - 0.2) * DEG * R < 1 ? 1 : 0) };
  const el = 2 * DEG, sun = new THREE.Vector3(Math.sin(el), Math.cos(el), 0).multiplyScalar(1.5e8);
  const make = () => {
    const c = new SolarShadowClipmap(ridge, { budgetMs: 1e6 });
    settle(c, frameAt(0, 0, 2, sun));
    return c;
  };

  it('shadows a vehicle behind the ridge, lights one flying above its shadow, and one past the ridge', () => {
    const c = make();
    expect(c.sunFractionAt(at(0, 0, 0.002))).toBe(0);
    expect(c.sunFractionAt(at(0, 0, 2))).toBe(1);
    expect(c.sunFractionAt(at(0, 0.3, 0.002))).toBe(1);
    // A point below the clipmap surface marches from the surface, not from inside the ground.
    expect(c.sunFractionAt(at(0, 0.3, -0.05))).toBe(1);
  });

  it('is 1 (no dimming) when the shadows are off', () => {
    const c = make();
    c.setActive(false);
    expect(c.sunFractionAt(at(0, 0, 0.002))).toBe(1);
  });
});
