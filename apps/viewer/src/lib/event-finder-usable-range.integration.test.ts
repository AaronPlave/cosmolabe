/**
 * The suggested range against real CSPICE (issue #106).
 *
 * The claim the Event Finder's "Available for …" line makes is that a search
 * over an offered window runs. `event-coverage.test.ts` pins the derivation
 * over synthetic segment lists; this holds it against the thing it models.
 * The kernels are written here, segment by segment, so each case can be built
 * exactly: the reported Mars/Earth failure (Mars given relative to a
 * barycenter nothing carries), a barycenter with a gap in its coverage, and a
 * light-time-corrected search at a window edge.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSpiceBindings, type SpiceBindings } from 'cspice-wasm';
import { createHeritageSpice, type HeritageSpice } from '@cosmolabe/frames';
import {
  EventSearch,
  assessEventCoverage,
  builtinEventKinds,
  eventGeometry,
  type EtInterval,
  type EventQuery,
} from '@cosmolabe/core';
import { spiceCoverageSource, spiceGeometryFinder } from './event-finder.svelte';

const fixture = (name: string): ArrayBuffer => {
  const buf = readFileSync(fileURLToPath(new URL(`../../../../kernels/fixtures/${name}`, import.meta.url)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

const DAY = 86_400;
const registry = builtinEventKinds();

/** A body on a slow straight line, sampled hourly: enough for Hermite, and for GF. */
function line(
  writer: SpiceBindings,
  file: string,
  body: number,
  center: number,
  start: number,
  end: number,
  origin: [number, number, number],
  velocity: [number, number, number],
): ArrayBuffer {
  const count = Math.floor((end - start) / 3600) + 1;
  const epochs = new Float64Array(count);
  const states = new Float64Array(count * 6);
  for (let i = 0; i < count; i++) {
    const t = i === count - 1 ? end : start + i * 3600;
    const dt = t - start;
    epochs[i] = t;
    states.set([
      origin[0] + velocity[0] * dt, origin[1] + velocity[1] * dt, origin[2] + velocity[2] * dt,
      ...velocity,
    ], i * 6);
  }
  writer.writeSpkType13(file, body, center, 'J2000', file, 3, epochs, states);
  const bytes = writer.readKernelBytes(file);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function scene(kernels: Record<string, ArrayBuffer>): Promise<HeritageSpice> {
  const spice = await createHeritageSpice();
  await spice.furnish({ type: 'buffer', data: fixture('naif0012.tls'), filename: 'naif0012.tls' });
  await spice.furnish({ type: 'buffer', data: fixture('pck00011.tpc'), filename: 'pck00011.tpc' });
  for (const [filename, data] of Object.entries(kernels)) {
    await spice.furnish({ type: 'buffer', data, filename });
  }
  return spice;
}

function query(window: EtInterval, abcorr?: string): EventQuery {
  return {
    id: 'q',
    kind: 'distance-range',
    bodies: { observer: 'MARS', target: 'EARTH' },
    window,
    step: 6 * 3600,
    params: { relation: '<', distanceKm: 1e12 },
    ...(abcorr ? { abcorr } : {}),
  };
}

function assess(spice: HeritageSpice, q: EventQuery) {
  const geometry = eventGeometry(q, registry.get(q.kind)!)!;
  return assessEventCoverage(geometry, spiceCoverageSource(spice));
}

async function search(spice: HeritageSpice, q: EventQuery) {
  return new EventSearch({ registry, provider: spiceGeometryFinder(spice) }).run(q);
}

describe('usable range against real SPICE', () => {
  let t0: number;
  let earth: Record<string, ArrayBuffer>;
  let mars: ArrayBuffer;
  let barycenterA: ArrayBuffer;
  let barycenterB: ArrayBuffer;

  beforeAll(async () => {
    const writer = await createSpiceBindings();
    writer.furnsh('naif0012.tls', new Uint8Array(fixture('naif0012.tls')));
    t0 = writer.str2et('2020-01-01T00:00:00');
    const end = t0 + 60 * DAY;
    earth = {
      'earth-bary.bsp': line(writer, 'earth-bary.bsp', 3, 0, t0, end, [1.5e8, 0, 0], [0, 30, 0]),
      'earth.bsp': line(writer, 'earth.bsp', 399, 3, t0, end, [4000, 0, 0], [0, 0.01, 0]),
    };
    mars = line(writer, 'mars.bsp', 499, 4, t0, end, [1, 0, 0], [0, 0, 0]);
    // The Mars barycenter in two pieces with a ten-day gap between them.
    barycenterA = line(writer, 'mars-bary-a.bsp', 4, 0, t0, t0 + 20 * DAY, [2.2e8, 0, 0], [0, 24, 0]);
    barycenterB = line(writer, 'mars-bary-b.bsp', 4, 0, t0 + 30 * DAY, end, [2.2e8, 0, 0], [0, 24, 0]);
  });

  it('reports no usable range when Mars is relative to a barycenter nothing carries', async () => {
    const spice = await scene({ ...earth, 'mars.bsp': mars });
    const window = { start: t0 + DAY, end: t0 + 10 * DAY };

    const assessment = assess(spice, query(window));
    expect(assessment.status).toBe('none');
    expect(assessment.problems.join('\n')).toMatch(/MARS BARYCENTER \(4\)/);

    // And SPICE agrees: this is the failure the old "kernel coverage" invited.
    const result = await search(spice, query(window));
    expect(result.ok).toBe(false);
  });

  it('offers each side of a coverage gap separately, and each one searches', async () => {
    const spice = await scene({
      ...earth, 'mars.bsp': mars, 'mars-bary-a.bsp': barycenterA, 'mars-bary-b.bsp': barycenterB,
    });
    const assessment = assess(spice, query({ start: t0, end: t0 + DAY }));
    expect(assessment.status).toBe('available');
    expect(assessment.exact).toBe(true);
    expect(assessment.windows).toHaveLength(2);
    expect(assessment.windows[0]!.end).toBeLessThan(t0 + 20 * DAY);
    expect(assessment.windows[1]!.start).toBeGreaterThan(t0 + 30 * DAY);

    for (const window of assessment.windows) {
      const result = await search(spice, query(window));
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }

    // The envelope across the gap is exactly what must not be offered.
    const envelope = {
      start: assessment.windows[0]!.start,
      end: assessment.windows[1]!.end,
    };
    expect((await search(spice, query(envelope))).ok).toBe(false);
  });

  it('holds at a window edge: the offered edge searches, a step past coverage does not', async () => {
    const spice = await scene({ ...earth, 'mars.bsp': mars, 'mars-bary-a.bsp': barycenterA });
    const [window] = assess(spice, query({ start: t0, end: t0 + DAY })).windows;
    expect(window).toBeDefined();

    const lastDay = { start: window!.end - DAY, end: window!.end };
    expect((await search(spice, query(lastDay))).ok).toBe(true);

    const past = { start: window!.end - DAY, end: window!.end + 60 };
    expect((await search(spice, query(past))).ok).toBe(false);
  });

  it('insets a light-time-corrected window by the light time, and it searches', async () => {
    const spice = await scene({ ...earth, 'mars.bsp': mars, 'mars-bary-a.bsp': barycenterA });
    const geometric = assess(spice, query({ start: t0, end: t0 + DAY })).windows[0]!;
    const corrected = assess(spice, query({ start: t0, end: t0 + DAY }, 'LT')).windows[0]!;

    // Earth is ~7e7 km from Mars here: roughly four minutes of light time.
    expect(corrected.start - geometric.start).toBeGreaterThan(200);
    expect((await search(spice, query({ start: corrected.start, end: corrected.start + DAY }, 'LT'))).ok).toBe(true);
    // Starting at the geometric edge reads Earth before its coverage begins.
    expect((await search(spice, query({ start: geometric.start, end: geometric.start + DAY }, 'LT'))).ok).toBe(false);
  });
});
