// Cross-engine differential: the heritage adapter (cspice-wasm) against the
// live timecraftjs Spice, over identical kernel bytes.
//
// This is the gate on re-pointing cosmolabe's construction sites. The adapter's
// own conformance suite (heritage-spice.test.ts) checks it against a cspice-wasm
// oracle — the same engine — so it cannot detect a difference between the two
// CSPICE builds. This file is the one that can.
//
// Mode: call parity. Both engines get the same bytes and the same call, and the
// answers must agree to a relative 1e-12 — not "close enough to render", but
// "the same computation". Anything looser would hide exactly the class of bug
// this is here to catch. Time conversions and integer-valued results are
// compared exactly.
//
// This file, and the @cosmolabe/spice devDependency it needs, are meant to be
// deleted together with packages/spice when timecraftjs leaves the tree.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { Spice, type SpiceInstance, type AberrationCorrection } from '@cosmolabe/spice';
import { createHeritageSpice, type HeritageSpice } from './index.js';

const KERNEL_DIR = fileURLToPath(new URL('../../spice/test-kernels/', import.meta.url));

/** Kernel bytes as a standalone ArrayBuffer. readFileSync can hand back a view
 *  into a larger pooled buffer, so slice to this file's own bytes. */
function kernelBytes(rel: string): ArrayBuffer {
  const buf = readFileSync(KERNEL_DIR + rel);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Generic kernels plus the Cassini SOI set. The CK and FK matter: they make
 *  pxform resolve a chain that runs through C-kernel pointing and a
 *  frame-kernel definition, not just analytic PCK rotation. */
const KERNELS = [
  'naif0012.tls',
  'pck00010.tpc',
  'de425s.bsp',
  'cassini/cas00172.tsc',
  'cassini/cas_v43.tf',
  'cassini/cas_iss_v10.ti',
  'cassini/040629AP_SCPSE_04179_04185.bsp',
  'cassini/04183_04185ra.bc',
];

/** Inside the Cassini SOI coverage window (DOY 183-185 of 2004). */
const EPOCH = '2004-07-01T02:00:00';

/** Call-parity tolerance: same computation, not merely a similar answer. */
const REL = 1e-12;

function relClose(actual: number, expected: number, rel = REL): boolean {
  if (Number.isNaN(actual) && Number.isNaN(expected)) return true;
  if (actual === expected) return true;
  const scale = Math.max(Math.abs(actual), Math.abs(expected));
  if (scale === 0) return true;
  return Math.abs(actual - expected) / scale <= rel;
}

/** Compare number trees (scalars, arrays, nested arrays) elementwise. */
function expectNumbersClose(actual: unknown, expected: unknown, path = '', rel = REL): void {
  if (typeof expected === 'number') {
    if (!relClose(actual as number, expected, rel)) {
      throw new Error(
        `${path || 'value'}: heritage ${actual} vs timecraftjs ${expected} ` +
          `(relative delta ${Math.abs((actual as number) - expected) / Math.max(Math.abs(actual as number), Math.abs(expected))})`,
      );
    }
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path}: expected an array`).toBe(true);
    const a = actual as unknown[];
    expect(a.length, `${path}: array length`).toBe(expected.length);
    expected.forEach((v, i) => expectNumbersClose(a[i], v, `${path}[${i}]`, rel));
    return;
  }
  if (expected && typeof expected === 'object') {
    for (const [k, v] of Object.entries(expected)) {
      expectNumbersClose((actual as Record<string, unknown>)[k], v, path ? `${path}.${k}` : k, rel);
    }
    return;
  }
  expect(actual, path).toEqual(expected);
}

describe('cspice-wasm vs timecraftjs: call parity', () => {
  let heritage: HeritageSpice;
  let legacy: SpiceInstance;
  let et: number;

  beforeAll(async () => {
    heritage = await createHeritageSpice();
    legacy = await Spice.init();
    for (const rel of KERNELS) {
      const data = kernelBytes(rel);
      const filename = rel.split('/').pop()!;
      // Each engine gets its own copy: furnish may retain or transfer.
      await heritage.furnish({ type: 'buffer', data: data.slice(0), filename });
      await legacy.furnish({ type: 'buffer', data: data.slice(0), filename });
    }
    et = legacy.str2et(EPOCH);
  }, 120_000);

  it('the adapter satisfies the SpiceInstance interface', () => {
    // Compile-time: the assignment is the assertion. If the adapter ever drifts
    // from the interface cosmolabe's core consumes, this stops compiling.
    const asInstance: SpiceInstance = heritage;
    expect(typeof asInstance.spkezr).toBe('function');
    expect(asInstance.totalLoaded()).toBe(legacy.totalLoaded());
  });

  describe('time', () => {
    it('str2et and utc2et agree exactly', () => {
      expect(heritage.str2et(EPOCH)).toBe(legacy.str2et(EPOCH));
      // utc2et takes the string verbatim on both paths (no trailing-Z strip).
      expect(heritage.utc2et('2004-07-01T02:00:00')).toBe(legacy.utc2et('2004-07-01T02:00:00'));
      for (const s of ['2004 JUL 01 02:00:00', '2004-183 // 02:00:00', 'JD 2453187.5']) {
        expect(heritage.str2et(s), s).toBe(legacy.str2et(s));
      }
    });

    it('et2utc agrees for every format and precision', () => {
      for (const fmt of ['C', 'D', 'J', 'ISOC', 'ISOD'] as const) {
        for (const prec of [0, 3, 6]) {
          expect(heritage.et2utc(et, fmt, prec), `${fmt}/${prec}`).toBe(
            legacy.et2utc(et, fmt, prec),
          );
        }
      }
    });

    it('timout and unitim agree', () => {
      for (const pic of ['YYYY-MM-DDTHR:MN:SC ::UTC', 'YYYY MON DD HR:MN:SC.### ::TDB']) {
        expect(heritage.timout(et, pic), pic).toBe(legacy.timout(et, pic));
      }
      for (const [from, to] of [['TDB', 'TDT'], ['TDB', 'TAI'], ['TDT', 'TDB']] as const) {
        expectNumbersClose(heritage.unitim(et, from, to), legacy.unitim(et, from, to), `${from}->${to}`);
      }
    });

    it('et2lst agrees', () => {
      for (const [body, lon] of [[399, 0], [399, Math.PI / 4], [699, 1.0]] as const) {
        const h = heritage.et2lst(et, body, lon, 'PLANETOCENTRIC');
        const l = legacy.et2lst(et, body, lon, 'PLANETOCENTRIC');
        expect(h.hr, `${body} hr`).toBe(l.hr);
        expect(h.mn, `${body} mn`).toBe(l.mn);
        expect(h.sc, `${body} sc`).toBe(l.sc);
        expect(h.time, `${body} time`).toBe(l.time);
      }
    });
  });

  describe('state', () => {
    const CASES: Array<[string, string, string]> = [
      ['SATURN', 'J2000', 'SUN'],
      ['EARTH', 'ECLIPJ2000', 'SUN'],
      ['MOON', 'J2000', 'EARTH'],
      ['CASSINI', 'J2000', 'SATURN'],
      ['CASSINI', 'ECLIPJ2000', 'SUN'],
      ['TITAN', 'IAU_SATURN', 'CASSINI'],
    ];
    const CORRECTIONS: AberrationCorrection[] = ['NONE', 'LT', 'LT+S', 'CN', 'CN+S', 'XLT+S'];

    it('spkpos agrees across targets, frames and corrections', () => {
      for (const [target, frame, observer] of CASES) {
        for (const abcorr of CORRECTIONS) {
          const label = `${target}/${frame}/${observer}/${abcorr}`;
          const h = heritage.spkpos(target, et, frame, abcorr, observer);
          const l = legacy.spkpos(target, et, frame, abcorr, observer);
          expectNumbersClose(h.position, l.position, `${label} position`);
          expectNumbersClose(h.lightTime, l.lightTime, `${label} lightTime`);
        }
      }
    });

    it('spkezr agrees, velocity included', () => {
      for (const [target, frame, observer] of CASES) {
        for (const abcorr of ['NONE', 'LT+S'] as AberrationCorrection[]) {
          const label = `${target}/${frame}/${observer}/${abcorr}`;
          const h = heritage.spkezr(target, et, frame, abcorr, observer);
          const l = legacy.spkezr(target, et, frame, abcorr, observer);
          expectNumbersClose(h.state, l.state, `${label} state`);
          expectNumbersClose(h.lightTime, l.lightTime, `${label} lightTime`);
        }
      }
    });

    it('agrees across the whole CK coverage window, not just one epoch', () => {
      const t0 = legacy.str2et('2004-07-01T00:30:00');
      const t1 = legacy.str2et('2004-07-02T12:00:00');
      for (let i = 0; i <= 12; i++) {
        const t = t0 + ((t1 - t0) * i) / 12;
        const h = heritage.spkezr('CASSINI', t, 'J2000', 'LT+S', 'SATURN');
        const l = legacy.spkezr('CASSINI', t, 'J2000', 'LT+S', 'SATURN');
        expectNumbersClose(h.state, l.state, `t+${i} state`);
      }
    });
  });

  describe('frames', () => {
    it('pxform agrees for analytic, ecliptic and CK-driven frames', () => {
      const PAIRS: Array<[string, string]> = [
        ['J2000', 'ECLIPJ2000'],
        ['J2000', 'IAU_EARTH'],
        ['J2000', 'IAU_SATURN'],
        ['IAU_SATURN', 'IAU_TITAN'],
        // Through the CK + FK chain.
        ['J2000', 'CASSINI_SC_COORD'],
        ['CASSINI_ISS_NAC', 'J2000'],
      ];
      for (const [from, to] of PAIRS) {
        expectNumbersClose(heritage.pxform(from, to, et), legacy.pxform(from, to, et), `${from}->${to}`);
      }
    });

    it('sxform agrees (6x6, so it exercises the rotation derivative too)', () => {
      for (const [from, to] of [['J2000', 'IAU_EARTH'], ['J2000', 'IAU_SATURN']] as const) {
        expectNumbersClose(heritage.sxform(from, to, et), legacy.sxform(from, to, et), `${from}->${to}`);
      }
    });

    it('frmnam agrees', () => {
      for (const code of [1, 13, 17, 10016, -82000, -82360]) {
        expect(heritage.frmnam(code), `frame ${code}`).toBe(legacy.frmnam(code));
      }
    });
  });

  describe('surface geometry', () => {
    it('subpnt agrees for both computation methods', () => {
      for (const method of ['NEAR POINT/ELLIPSOID', 'INTERCEPT/ELLIPSOID']) {
        for (const [target, fixref, observer] of [
          ['EARTH', 'IAU_EARTH', 'SUN'],
          ['SATURN', 'IAU_SATURN', 'CASSINI'],
        ] as const) {
          const label = `${method}/${target}/${observer}`;
          expectNumbersClose(
            heritage.subpnt(method, target, et, fixref, 'NONE', observer),
            legacy.subpnt(method, target, et, fixref, 'NONE', observer),
            label,
          );
        }
      }
    });

    it('subslr agrees', () => {
      expectNumbersClose(
        heritage.subslr('NEAR POINT/ELLIPSOID', 'EARTH', et, 'IAU_EARTH', 'NONE', 'EARTH'),
        legacy.subslr('NEAR POINT/ELLIPSOID', 'EARTH', et, 'IAU_EARTH', 'NONE', 'EARTH'),
        'subslr',
      );
    });

    it('sincpt agrees, including the no-intercept case', () => {
      // Boresight from Cassini at Saturn: the ray either hits or it does not,
      // and both engines must agree on which.
      const h = heritage.sincpt('ELLIPSOID', 'SATURN', et, 'IAU_SATURN', 'NONE', 'CASSINI', 'J2000',
        heritage.spkpos('SATURN', et, 'J2000', 'NONE', 'CASSINI').position);
      const l = legacy.sincpt('ELLIPSOID', 'SATURN', et, 'IAU_SATURN', 'NONE', 'CASSINI', 'J2000',
        legacy.spkpos('SATURN', et, 'J2000', 'NONE', 'CASSINI').position);
      expect(h.found, 'found').toBe(l.found);
      if (l.found) expectNumbersClose(h, l, 'sincpt');

      // Deliberately pointed away from the body.
      const away = heritage.spkpos('SATURN', et, 'J2000', 'NONE', 'CASSINI').position.map(v => -v) as
        [number, number, number];
      const hMiss = heritage.sincpt('ELLIPSOID', 'SATURN', et, 'IAU_SATURN', 'NONE', 'CASSINI', 'J2000', away);
      const lMiss = legacy.sincpt('ELLIPSOID', 'SATURN', et, 'IAU_SATURN', 'NONE', 'CASSINI', 'J2000', away);
      expect(hMiss.found, 'miss found').toBe(lMiss.found);
    });

    it('ilumin agrees', () => {
      const spoint = legacy.subpnt('NEAR POINT/ELLIPSOID', 'EARTH', et, 'IAU_EARTH', 'NONE', 'SUN').point;
      expectNumbersClose(
        heritage.ilumin('ELLIPSOID', 'EARTH', et, 'IAU_EARTH', 'NONE', 'SUN', spoint),
        legacy.ilumin('ELLIPSOID', 'EARTH', et, 'IAU_EARTH', 'NONE', 'SUN', spoint),
        'ilumin',
      );
    });
  });

  describe('body constants', () => {
    it('bodvrd agrees', () => {
      for (const [body, item] of [
        ['EARTH', 'RADII'],
        ['SATURN', 'RADII'],
        ['MOON', 'RADII'],
        ['EARTH', 'PM'],
        ['SATURN', 'POLE_RA'],
      ] as const) {
        expectNumbersClose(heritage.bodvrd(body, item), legacy.bodvrd(body, item), `${body}/${item}`);
      }
    });

    it('bodvcd agrees', () => {
      for (const [id, item] of [[399, 'RADII'], [699, 'RADII'], [301, 'RADII']] as const) {
        expectNumbersClose(heritage.bodvcd(id, item), legacy.bodvcd(id, item), `${id}/${item}`);
      }
    });
  });

  describe('orbital elements', () => {
    it('oscelt and conics round-trip identically', () => {
      const { state } = legacy.spkezr('MOON', et, 'J2000', 'NONE', 'EARTH');
      // pck00010.tpc carries no BODY*_GM values at all, so bodvrd('EARTH','GM')
      // throws rather than returning empty. Use the IAU/DE-consistent value
      // directly — what matters here is that both engines get the same GM.
      const gm = 398600.435436;
      const hElts = heritage.oscelt(state, et, gm);
      const lElts = legacy.oscelt(state, et, gm);
      expectNumbersClose(hElts, lElts, 'oscelt');
      // Propagate the elements forward and compare the resulting states.
      const later = et + 3600;
      expectNumbersClose(heritage.conics(hElts, later), legacy.conics(lElts, later), 'conics');
    });
  });

  describe('geometry finders', () => {
    it('gfdist agrees on distance extrema', () => {
      const start = legacy.str2et('2004-07-01T00:00:00');
      const end = legacy.str2et('2004-07-02T00:00:00');
      const cnfine = [{ start, end }];
      const h = heritage.gfdist('MOON', 'NONE', 'EARTH', 'LOCMIN', 0, 0, 3600, cnfine);
      const l = legacy.gfdist('MOON', 'NONE', 'EARTH', 'LOCMIN', 0, 0, 3600, cnfine);
      expect(h.length, 'window count').toBe(l.length);
      expectNumbersClose(h, l, 'gfdist windows');
    });

    it('gfoclt agrees on occultation windows', () => {
      const start = legacy.str2et('2004-07-01T00:00:00');
      const end = legacy.str2et('2004-07-03T00:00:00');
      const cnfine = [{ start, end }];
      const h = heritage.gfoclt('ANY', 'TITAN', 'ELLIPSOID', 'IAU_TITAN', 'SATURN', 'ELLIPSOID',
        'IAU_SATURN', 'NONE', 'CASSINI', 300, cnfine);
      const l = legacy.gfoclt('ANY', 'TITAN', 'ELLIPSOID', 'IAU_TITAN', 'SATURN', 'ELLIPSOID',
        'IAU_SATURN', 'NONE', 'CASSINI', 300, cnfine);
      expect(h.length, 'window count').toBe(l.length);
      expectNumbersClose(h, l, 'gfoclt windows');
    });

    it('gfsep agrees on angular separation windows', () => {
      const start = legacy.str2et('2004-07-01T00:00:00');
      const end = legacy.str2et('2004-07-02T00:00:00');
      const cnfine = [{ start, end }];
      const args = ['TITAN', 'SPHERE', 'IAU_TITAN', 'SATURN', 'SPHERE', 'IAU_SATURN', 'NONE',
        'CASSINI', 'LOCMAX', 0, 0, 600, cnfine] as const;
      const h = heritage.gfsep(...args);
      const l = legacy.gfsep(...args);
      expect(h.length, 'window count').toBe(l.length);
      expectNumbersClose(h, l, 'gfsep windows');
    });
  });

  describe('coverage', () => {
    it('spkobj and spkcov agree', () => {
      const file = '040629AP_SCPSE_04179_04185.bsp';
      const hObj = heritage.spkobj(file);
      const lObj = legacy.spkobj(file);
      const ids = [...lObj].sort((a, b) => a - b);
      expect(ids.length, 'the SPK should report objects').toBeGreaterThan(0);
      expect([...hObj].sort((a, b) => a - b)).toEqual(ids);
      // spkcov takes the NAIF id alone and unions that body's segment windows
      // across every furnished SPK — there is no per-file variant on this
      // surface. Cover every id the kernel reports, including Cassini itself.
      for (const id of ids) {
        const h = heritage.spkcov(id);
        const l = legacy.spkcov(id);
        expect(h.length, `spkcov ${id} window count`).toBe(l.length);
        expectNumbersClose(h, l, `spkcov ${id}`);
      }
    });
  });

  describe('vector math', () => {
    const a: [number, number, number] = [1.5, -2.25, 3.125];
    const b: [number, number, number] = [-0.5, 4.0, 2.75];

    it('agrees elementwise', () => {
      const m = legacy.pxform('J2000', 'IAU_EARTH', et);
      expectNumbersClose(heritage.mxv(m, a), legacy.mxv(m, a), 'mxv');
      expectNumbersClose(heritage.mtxv(m, a), legacy.mtxv(m, a), 'mtxv');
      expectNumbersClose(heritage.vcrss(a, b), legacy.vcrss(a, b), 'vcrss');
      expectNumbersClose(heritage.vnorm(a), legacy.vnorm(a), 'vnorm');
      expectNumbersClose(heritage.vdot(a, b), legacy.vdot(a, b), 'vdot');
      expectNumbersClose(heritage.vsep(a, b), legacy.vsep(a, b), 'vsep');
      expectNumbersClose(heritage.vhat(a), legacy.vhat(a), 'vhat');
      expectNumbersClose(heritage.vsub(a, b), legacy.vsub(a, b), 'vsub');
      expectNumbersClose(heritage.vadd(a, b), legacy.vadd(a, b), 'vadd');
    });
  });

  describe('instrument fields of view', () => {
    it('getfov agrees', () => {
      // NAIF ids, not strings: `getfov` takes an integer instrument id. Passed
      // as strings both engines returned the same nothing, so this agreed
      // without exercising either — the failure mode a test typecheck catches.
      for (const inst of [-82360, -82361]) {
        const h = heritage.getfov(inst, 20);
        const l = legacy.getfov(inst, 20);
        // Agreement on nothing is not agreement: pin that a real FOV came
        // back before comparing the two engines' answers.
        expect(['CIRCLE', 'ELLIPSE', 'RECTANGLE', 'POLYGON'], `${inst} shape`).toContain(h.shape);
        expect(h.frame, `${inst} frame is named`).toBeTruthy();
        expect(Math.hypot(...h.boresight), `${inst} boresight is a direction`).toBeGreaterThan(0);
        expect(h.bounds.length, `${inst} has boundary vectors`).toBeGreaterThan(0);

        expect(h.shape, `${inst} shape`).toBe(l.shape);
        expect(h.frame, `${inst} frame`).toBe(l.frame);
        expectNumbersClose(h.boresight, l.boresight, `${inst} boresight`);
        expectNumbersClose(h.bounds, l.bounds, `${inst} bounds`);
      }
    });
  });
});
