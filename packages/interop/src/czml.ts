// Minimal CZML export for analysis products (Cesium/CZML 1.0). Pure and dependency-
// free: the caller supplies ISO-8601 epoch labels (ET -> UTC is a SPICE concern) so
// this stays a string transform. Today it emits an availability document for interval
// windows and a cartographic path for a ground track. (STK_PARITY_SPEC §4.12.)

/** An interval as ISO-8601 start/stop strings. */
export interface IsoInterval {
  readonly start: string;
  readonly stop: string;
}

/** A CZML document packet is always first; version is fixed at 1.0. */
function documentPacket(name: string): Record<string, unknown> {
  return { id: 'document', name, version: '1.0' };
}

/**
 * A CZML document whose single entity is available exactly over the given intervals
 * (a Cesium timeline reads `availability` as one or more "start/stop" strings).
 */
export function intervalsToCzml(name: string, intervals: readonly IsoInterval[]): string {
  const availability = intervals.map((iv) => `${iv.start}/${iv.stop}`);
  const entity: Record<string, unknown> = { id: name, name };
  if (availability.length === 1) entity.availability = availability[0];
  else if (availability.length > 1) entity.availability = availability;
  return JSON.stringify([documentPacket(name), entity], null, 2);
}

/** One ground-track sample: an epoch label and a geodetic position. */
export interface GroundSample {
  readonly epoch: string;
  readonly lonDeg: number;
  readonly latDeg: number;
  readonly heightM?: number;
}

/** An explicit UTC designator or numeric offset at the end of the string. */
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Milliseconds for an epoch label, reading an offset-less one as UTC.
 *
 * Not `Date.parse` directly: ES reads a date-time carrying no offset as LOCAL
 * time. Here that leaks in exactly one place, which is why it survived — the
 * sample times below are *differences*, so a constant local offset cancels and
 * the output is right. It is only the DST discontinuity that does not cancel: a
 * track straddling one emits relative times an hour wrong. Measured on a run of
 * 2024-03-10T01:30 to 04:30 under America/Los_Angeles, `Date.parse` reports the
 * span as 2 hours instead of 3.
 *
 * Duplicated from @cosmolabe/core's `utcMsFromCalendarString` rather than
 * imported: this package has no runtime dependencies by design (the module note
 * above — ET to UTC is the caller's concern), and taking one on core to reach a
 * four-line function would be the wrong trade.
 */
function utcMs(label: string): number {
  const t = label.trim();
  if (HAS_OFFSET.test(t)) return Date.parse(t);
  // A date-only form is already UTC per spec; only a time component needs pinning.
  return Date.parse(t.includes(':') ? `${t}Z` : t);
}

/**
 * A CZML document with a single positioned entity whose `position` is a time-tagged
 * cartographicDegrees path (lon, lat, height triples interleaved with epoch labels in
 * the CZML "sampled" form using the first sample's epoch as the reference).
 */
export function groundTrackToCzml(name: string, samples: readonly GroundSample[]): string {
  // CZML cartographicDegrees with epoch: [t0, lon, lat, h, t1, lon, lat, h, ...] where
  // each t is seconds from the reference epoch (the first sample).
  const ref = samples[0]?.epoch ?? '';
  const refMs = ref ? utcMs(ref) : 0;
  const cart: number[] = [];
  for (const s of samples) {
    const t = (utcMs(s.epoch) - refMs) / 1000;
    cart.push(t, s.lonDeg, s.latDeg, s.heightM ?? 0);
  }
  const entity: Record<string, unknown> = {
    id: name,
    name,
    position: { epoch: ref, cartographicDegrees: cart },
    path: { material: { solidColor: { color: { rgba: [0, 255, 255, 200] } } } },
  };
  return JSON.stringify([documentPacket(name), entity], null, 2);
}
