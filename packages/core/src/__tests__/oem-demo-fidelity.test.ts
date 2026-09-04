/**
 * The OEM demo catalog's central claim, checked numerically.
 *
 * `apps/viewer/test-catalogs/oem-ingest.json` flies Cassini through Saturn orbit
 * insertion with **no spacecraft SPK loaded at all** — the entire trajectory
 * arrives as a CCSDS text file. The demo is only worth showing if that arc is
 * actually right, which is a numeric claim, so it lives here rather than in
 * whether the picture looks plausible.
 *
 * The file was written out of the SOI kernel (scripts/build-oem-demo.mjs), so
 * this test furnishes that kernel itself and compares the catalog's
 * file-driven body against spkezr directly. An earlier version of the demo put
 * both on screen at once to show them overlaying; that was dropped because two
 * exactly coincident lines just look like one line, and a test measures the
 * agreement far better than a screenshot can suggest it.
 *
 * The comparison is not trivially true. The OEM path loses information three
 * ways, and the two regimes the test separates are each dominated by a
 * different one — which is the interesting part:
 *
 *   - **At a tabulated epoch**, the limit is not the position quantization at
 *     all. The writer keeps 13 significant digits, worth about 0.07 mm on a
 *     7e5 km component, but the *epoch string* is written to microseconds, and
 *     Cassini is doing 29.8 km/s through SOI periapsis. Half a microsecond of
 *     rounding is 14.9 mm of along-track position, and the measured worst node
 *     error is 14.2 mm at 2004-07-01T03:00 — the epoch precision, not the
 *     coordinate precision. For a fast spacecraft the time column is the
 *     binding constraint on a CCSDS ephemeris, which is easy to overlook.
 *     Writing nanoseconds would cut this 1000x; microseconds is what real OEMs
 *     carry, so the demo keeps it and states the consequence.
 *
 *   - **Between epochs**, cubic Hermite reconstruction over the 120 s step
 *     dominates: 27.1 m at worst, again right at periapsis where the
 *     trajectory curves hardest and where this window is centred deliberately.
 *     SPICE evaluates its own Chebyshev polynomials continuously and has no
 *     such error.
 *
 * Both are far below one pixel at the demo's viewing distance (900,000 km
 * across ~1000 px is roughly 900 km per pixel), which is why the two arcs
 * overlay exactly on screen.
 *
 * Guarding the demo generator too: if someone changes the step or window in
 * scripts/build-oem-demo.mjs and regenerates, this notices when the
 * reconstruction stops being good enough to overlay.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHeritageSpice, type HeritageSpice } from '@cosmolabe/frames';
import { parseOem } from '@cosmolabe/interop';
import { CatalogLoader, type CatalogJson } from '../catalog/CatalogLoader.js';
import { furnishKernels, VIEWER_KERNELS } from './_harness/kernels.js';
import type { Body } from '../Body.js';

const VIEWER = fileURLToPath(new URL('../../../../apps/viewer/test-catalogs/', import.meta.url));
const CATALOG: CatalogJson = JSON.parse(readFileSync(`${VIEWER}oem-ingest.json`, 'utf8'));
const OEM_TEXT = readFileSync(`${VIEWER}ephemerides/cassini-soi.oem`, 'utf8');

/** What the demo catalog declares: time and body constants, no spacecraft SPK. */
const CATALOG_KERNELS = ['naif0012.tls', 'pck00011.tpc'];
/** The SPK the OEM was generated from — loaded only here, as the reference. */
const TRUTH_KERNEL = 'cassini/040629AP_SCPSE_04179_04185.bsp';

/**
 * Bounds set from the measured values, with about 2x headroom — tight enough
 * that changing the generator's step or epoch format trips them, loose enough
 * not to flap. Measured 2026-09-02: 14.2 mm at nodes, 27.1 m between.
 *
 * These are deliberately NOT round numbers chosen up front. My first attempt
 * guessed 10 mm and 10 m, both of which failed, and the node figure failing is
 * what surfaced that epoch precision rather than coordinate precision sets the
 * floor there.
 */
const NODE_TOL_KM = 3e-5; // 30 mm
const MIDPOINT_TOL_KM = 6e-2; // 60 m

describe('OEM demo fidelity: the file-driven arc matches SPICE truth', () => {
  let spice: HeritageSpice;
  let oemCassini: Body;
  let epochs: number[];

  /** SPICE truth for the same query the generator issued. */
  const truth = (et: number): [number, number, number] => {
    const { state } = spice.spkezr('CASSINI', et, 'J2000', 'NONE', 'SATURN');
    return [state[0], state[1], state[2]];
  };

  beforeAll(async () => {
    spice = await createHeritageSpice();
    // Through the shared harness rather than a local readFileSync: it slices the
    // Buffer by its own offset (see kernelArrayBuffer) and refuses a git-lfs
    // pointer loudly. The truth SPK here is LFS-routed, and furnishing an
    // unsmudged pointer loads nothing silently — the resulting failure is a
    // SPICE(NOLOADEDFILES) from the first spkezr, 40 lines away from the cause.
    await furnishKernels(spice, [...CATALOG_KERNELS, TRUTH_KERNEL], VIEWER_KERNELS);

    const { bodies } = new CatalogLoader({
      spice,
      // The demo's OEM source path, resolved the way the viewer's pre-fetch does.
      resolveFile: (source) => (source.endsWith('cassini-soi.oem') ? OEM_TEXT : undefined),
    }).load(CATALOG);

    oemCassini = bodies.find((b) => b.name === 'Cassini')!;
    expect(oemCassini, 'Cassini missing from the demo catalog').toBeDefined();

    // The file's own epochs, so "at a node" means what the file says it means.
    const oem = parseOem(OEM_TEXT);
    epochs = oem.states.map((s) => spice.str2et(`${s.epoch.replace('T', ' ')} UTC`));
  }, 180_000);

  it('the demo catalog really does use the OEM path', () => {
    // Guards against the body silently degrading to a FixedPoint, which is what
    // happens if the source cannot be resolved. The scene would still load,
    // with the spacecraft parked at Saturn's centre and no arc.
    const a = oemCassini.trajectory.stateAt(epochs[0]!);
    const b = oemCassini.trajectory.stateAt(epochs[Math.floor(epochs.length / 2)]!);
    const moved = Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]);
    expect(moved, 'the OEM body should actually move').toBeGreaterThan(1000);
    // And it should cover the window the file declares.
    expect(oemCassini.trajectory.startTime).toBeCloseTo(epochs[0]!, 6);
    expect(oemCassini.trajectory.endTime).toBeCloseTo(epochs[epochs.length - 1]!, 6);
  });

  it('agrees with SPICE at every tabulated epoch (epoch-precision limited)', () => {
    let worst = 0;
    let worstAt = '';
    for (const et of epochs) {
      const a = truth(et);
      const b = oemCassini.trajectory.stateAt(et);
      const d = Math.hypot(a[0] - b.position[0], a[1] - b.position[1], a[2] - b.position[2]);
      if (d > worst) {
        worst = d;
        worstAt = spice.et2utc(et, 'ISOC', 3);
      }
    }
    console.log(`\n  at nodes:     worst ${(worst * 1e6).toFixed(4)} mm at ${worstAt}\n`);
    expect(worst, `worst node delta at ${worstAt} (km)`).toBeLessThan(NODE_TOL_KM);
  });

  it('agrees with SPICE between epochs (Hermite reconstruction error)', () => {
    let worst = 0;
    let worstAt = '';
    // Midpoints are where a cubic reconstruction is furthest from the truth.
    for (let i = 0; i + 1 < epochs.length; i++) {
      const et = (epochs[i]! + epochs[i + 1]!) / 2;
      const a = truth(et);
      const b = oemCassini.trajectory.stateAt(et);
      const d = Math.hypot(a[0] - b.position[0], a[1] - b.position[1], a[2] - b.position[2]);
      if (d > worst) {
        worst = d;
        worstAt = spice.et2utc(et, 'ISOC', 3);
      }
    }
    console.log(`\n  between nodes: worst ${(worst * 1e3).toFixed(4)} m at ${worstAt}\n`);
    expect(worst, `worst midpoint delta at ${worstAt} (km)`).toBeLessThan(MIDPOINT_TOL_KM);
  });

  it('declares a frame that matches the catalog, so no warning is warranted', () => {
    // The demo would be a poor advertisement for the frame check if it tripped
    // it. REF_FRAME=J2000 and trajectoryFrame="J2000" agree.
    const oem = parseOem(OEM_TEXT);
    expect(oem.metadata.refFrame).toBe('J2000');
    expect(oem.metadata.timeSystem).toBe('UTC');
    expect(oem.metadata.centerName).toBe('SATURN');
  });
});
