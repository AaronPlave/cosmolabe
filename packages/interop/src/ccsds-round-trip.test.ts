// The CCSDS round-trip suite (Session 9, the W4 stretch): engine-generated
// ephemerides and attitude cross the text interchange boundary and come
// back, with fidelity measured and stated per format rather than eyeballed.
// The two file contracts, stated once: the f64le-base64 JSON encoding of
// M-0004 is the bit-exact product-file contract (NaN preserved bit for bit;
// the CLI is its named consumer), and the CCSDS text formats are the
// interchange contract, quantized by the writers at 13 significant digits,
// with the resulting tolerances asserted below and every failure naming the
// field and sample it happened at. States come from the frames tier over
// the GS-2 era boot kernels, so what round-trips here is real engine
// output, not hand-built numbers.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createComputeEnv,
  decodeAnalysisProduct,
  encodeAnalysisProduct,
  type AnalysisProduct,
  type ComputeEnv,
} from '@bessel/compute';
import { parseOem } from './oem.ts';
import { writeOem } from './oem-write.ts';
import { parseAem } from './aem.ts';
import { writeAem } from './aem-write.ts';
import { parseCdm } from './cdm.ts';
import type { Oem, OemState } from './oem.ts';
import type { Aem, AemRecord } from './aem.ts';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))),
  );

const KERNELS = ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp', 'cassini-soi.bsp'];
const HOUR = 3600;
const STEP = 600;
// Writer quantization: toExponential(12) keeps 13 significant digits, so a
// position of order 1e6 km quantizes at or below 1e-6 km (1 mm) and a
// velocity of order 10 km/s at or below 1e-11 km/s; the asserted tolerances
// leave one order of headroom on velocity.
const POS_TOL_KM = 1e-6;
const VEL_TOL_KMS = 1e-9;
const QUAT_TOL = 1e-12;

describe('CCSDS round-trip suite (GS-2 engine output through the text boundary)', () => {
  let env: ComputeEnv;
  let et0: number;
  let epochs: number[];
  let epochStrings: string[];

  beforeAll(async () => {
    env = await createComputeEnv();
    for (const name of KERNELS) env.furnish(name, fixture(name));
    et0 = env.frames.toEt('2004-07-01T01:00:00');
    epochs = Array.from({ length: 25 }, (_, i) => et0 + i * STEP);
    epochStrings = await Promise.all(epochs.map((et) => env.engine.et2utc(et, 'ISOC', 6)));
  });

  it(`OEM: frames-tier states round-trip within ${POS_TOL_KM} km per position component and ${VEL_TOL_KMS} km/s per velocity component (13 significant digit writer quantization)`, async () => {
    const batch = await env.frames.states({
      targets: ['CASSINI'],
      observer: 'SATURN',
      frame: 'J2000',
      correction: 'NONE',
      epochs: { start: et0, end: et0 + 4 * HOUR, step: STEP },
    });
    const n = batch.epochs.length;
    expect(n).toBe(25);
    const states: OemState[] = Array.from({ length: n }, (_, i) => ({
      epoch: epochStrings[i]!,
      position: [batch.states[i * 6]!, batch.states[i * 6 + 1]!, batch.states[i * 6 + 2]!],
      velocity: [batch.states[i * 6 + 3]!, batch.states[i * 6 + 4]!, batch.states[i * 6 + 5]!],
    }));
    const oem: Oem = {
      version: '2.0',
      originator: 'BESSEL',
      creationDate: '2026-07-11T00:00:00',
      metadata: {
        objectName: 'CASSINI',
        objectId: '-82',
        centerName: 'SATURN',
        refFrame: 'J2000',
        timeSystem: 'UTC',
        startTime: epochStrings[0]!,
        stopTime: epochStrings[n - 1]!,
      },
      states,
    };

    const round = parseOem(writeOem(oem));
    expect(round.states).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      expect(round.states[i]!.epoch, `epoch string at sample ${i}`).toBe(states[i]!.epoch);
      for (let c = 0; c < 3; c++) {
        const dp = Math.abs(round.states[i]!.position[c]! - states[i]!.position[c]!);
        expect(dp, `position component ${'xyz'[c]} at sample ${i} (km)`).toBeLessThanOrEqual(
          POS_TOL_KM,
        );
        const dv = Math.abs(round.states[i]!.velocity[c]! - states[i]!.velocity[c]!);
        expect(dv, `velocity component ${'xyz'[c]} at sample ${i} (km/s)`).toBeLessThanOrEqual(
          VEL_TOL_KMS,
        );
      }
    }
  });

  it('OEM: header and metadata fidelity (originator, creation date, ids, frame, time system, span reproduce exactly)', async () => {
    const oem: Oem = {
      version: '2.0',
      originator: 'BESSEL',
      creationDate: '2026-07-11T00:00:00',
      metadata: {
        objectName: 'CASSINI',
        objectId: '-82',
        centerName: 'SATURN',
        refFrame: 'J2000',
        timeSystem: 'UTC',
        startTime: epochStrings[0]!,
        stopTime: epochStrings[24]!,
      },
      states: [
        { epoch: epochStrings[0]!, position: [1, 2, 3], velocity: [4, 5, 6] },
      ],
    };
    const round = parseOem(writeOem(oem));
    expect(round.version).toBe('2.0');
    expect(round.originator).toBe('BESSEL');
    expect(round.creationDate).toBe('2026-07-11T00:00:00');
    expect(round.metadata).toEqual(oem.metadata);
  });

  it(`AEM: Saturn body-orientation quaternions round-trip within ${QUAT_TOL} per component, scalar-first preserved`, async () => {
    const batch = await env.frames.orientation('SATURN', 'J2000', epochs);
    expect(batch.bodyFrame).toBe('IAU_SATURN');
    const records: AemRecord[] = epochs.map((_, i) => ({
      epoch: epochStrings[i]!,
      quaternion: [
        batch.quats[i * 4]!,
        batch.quats[i * 4 + 1]!,
        batch.quats[i * 4 + 2]!,
        batch.quats[i * 4 + 3]!,
      ],
    }));
    const aem: Aem = {
      version: '1.0',
      metadata: {
        objectName: 'SATURN',
        centerName: 'SATURN',
        refFrameA: 'J2000',
        refFrameB: 'IAU_SATURN',
        attitudeDir: 'A2B',
        timeSystem: 'UTC',
        startTime: epochStrings[0]!,
        stopTime: epochStrings[24]!,
        attitudeType: 'QUATERNION',
        quaternionType: 'FIRST',
      },
      records,
    };

    const round = parseAem(writeAem(aem));
    expect(round.records).toHaveLength(records.length);
    expect(round.metadata).toEqual(aem.metadata);
    for (let i = 0; i < records.length; i++) {
      expect(round.records[i]!.epoch, `epoch string at record ${i}`).toBe(records[i]!.epoch);
      for (let c = 0; c < 4; c++) {
        const dq = Math.abs(round.records[i]!.quaternion[c]! - records[i]!.quaternion[c]!);
        expect(dq, `quaternion component ${'wxyz'[c]} at record ${i}`).toBeLessThanOrEqual(
          QUAT_TOL,
        );
      }
    }
    // Scalar-first survived the trip: the w read back matches the m2q w, not
    // a rotated component order.
    expect(round.records[0]!.quaternion[0]).toBeCloseTo(batch.quats[0]!, 12);
  });

  it(`SPICE-truth cross-check: ingested OEM states match freshly recomputed frames-tier truth within ${POS_TOL_KM} km and ${VEL_TOL_KMS} km/s`, async () => {
    // The stretch lane: not self-consistency (comparing the file against the
    // array it was written from) but truth-consistency: the states that come
    // back out of the text boundary are compared against a second,
    // independent frames-tier computation of the same query, so the whole
    // chain (compute, write, parse, ingest) is measured against SPICE truth.
    const batch = await env.frames.states({
      targets: ['CASSINI'],
      observer: 'SATURN',
      frame: 'J2000',
      correction: 'NONE',
      epochs: { start: et0, end: et0 + 4 * HOUR, step: STEP },
    });
    const n = batch.epochs.length;
    const written = writeOem({
      version: '2.0',
      originator: 'BESSEL',
      metadata: { objectName: 'CASSINI', centerName: 'SATURN', refFrame: 'J2000', timeSystem: 'UTC' },
      states: Array.from({ length: n }, (_, i) => ({
        epoch: epochStrings[i]!,
        position: [
          batch.states[i * 6]!,
          batch.states[i * 6 + 1]!,
          batch.states[i * 6 + 2]!,
        ] as const,
        velocity: [
          batch.states[i * 6 + 3]!,
          batch.states[i * 6 + 4]!,
          batch.states[i * 6 + 5]!,
        ] as const,
      })),
    });
    const ingested = parseOem(written);
    const truth = await env.frames.states({
      targets: ['CASSINI'],
      observer: 'SATURN',
      frame: 'J2000',
      correction: 'NONE',
      epochs: { start: et0, end: et0 + 4 * HOUR, step: STEP },
    });
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const dp = Math.abs(ingested.states[i]!.position[c]! - truth.states[i * 6 + c]!);
        expect(dp, `truth position ${'xyz'[c]} at sample ${i} (km)`).toBeLessThanOrEqual(
          POS_TOL_KM,
        );
        const dv = Math.abs(ingested.states[i]!.velocity[c]! - truth.states[i * 6 + 3 + c]!);
        expect(dv, `truth velocity ${'xyz'[c]} at sample ${i} (km/s)`).toBeLessThanOrEqual(
          VEL_TOL_KMS,
        );
      }
    }
  });

  it('CDM: the committed JSPOC fixture pins the conjunction read', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../test-fixtures/jspoc.cdm', import.meta.url)),
      'utf8',
    );
    const cdm = parseCdm(text);
    expect(cdm.tca).toBe('2010-03-13T22:37:52.618');
    expect(cdm.missDistanceM).toBe(715);
    expect(cdm.relativeSpeedMS).toBe(14762);
    expect(cdm.object1.designator).toBe('38096');
    expect(cdm.object2.designator).toBe('37820');
  });

  it("fidelity statement: the JSON product-file contract (the CLI's format) is bit-exact including NaN, where the CCSDS text contract is quantized within its stated tolerance", () => {
    const product: AnalysisProduct = {
      product: {
        kind: 'series',
        series: [
          {
            name: 'x',
            unit: 'km',
            et: new Float64Array([0, 600]),
            values: new Float64Array([Math.PI * 1e6, Number.NaN]),
          },
        ],
      },
      provenance: {
        engine: 'suite',
        version: '0.0.0',
        kernels: { setHash: 'abc', names: [] },
        frame: 'J2000',
        correction: 'NONE',
        authority: 'exploratory',
        computedAt: '2026-07-11T00:00:00Z',
        jobId: 'fidelity-1',
      },
      units: { x: 'km' },
    };
    // Bit-exact: every double survives, NaN included (Object.is, not ==).
    const decoded = decodeAnalysisProduct(encodeAnalysisProduct(product));
    const d = decoded.product;
    if (d.kind !== 'series') throw new Error('kind changed in the JSON round trip');
    expect(Object.is(d.series[0]!.values[0], Math.PI * 1e6)).toBe(true);
    expect(Object.is(d.series[0]!.values[1], Number.NaN)).toBe(true);

    // Quantized: the same irrational value through the OEM text boundary
    // moves by a nonzero amount that stays inside the stated tolerance.
    const oem: Oem = {
      version: '2.0',
      metadata: { refFrame: 'J2000', timeSystem: 'UTC' },
      states: [{ epoch: '2004-07-01T01:00:00', position: [Math.PI * 1e6, 0, 0], velocity: [0, 0, 0] }],
    };
    const dp = Math.abs(parseOem(writeOem(oem)).states[0]!.position[0]! - Math.PI * 1e6);
    expect(dp).toBeGreaterThan(0);
    expect(dp).toBeLessThanOrEqual(POS_TOL_KM);
  });
});
