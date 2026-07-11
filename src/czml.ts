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

/**
 * A CZML document with a single positioned entity whose `position` is a time-tagged
 * cartographicDegrees path (lon, lat, height triples interleaved with epoch labels in
 * the CZML "sampled" form using the first sample's epoch as the reference).
 */
export function groundTrackToCzml(name: string, samples: readonly GroundSample[]): string {
  // CZML cartographicDegrees with epoch: [t0, lon, lat, h, t1, lon, lat, h, ...] where
  // each t is seconds from the reference epoch (the first sample).
  const ref = samples[0]?.epoch ?? '';
  const refMs = ref ? Date.parse(ref) : 0;
  const cart: number[] = [];
  for (const s of samples) {
    const t = (Date.parse(s.epoch) - refMs) / 1000;
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
