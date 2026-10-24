// ODE (PDS Geosciences Node Orbital Data Explorer) → ArchiveObservation. A thin
// field mapping, pure and headless; `fetch` is injected.
//
// ODE's REST product query (`query=product`, `output=JSON`) returns
// `ODEResults.Products.Product`, one object per product — or a bare object when
// there is exactly one, which is read the same way. Each product carries its
// footprint as WKT lon/lat, which is the point: ODE's coverage is *given*, not
// computed. The API serves `Access-Control-Allow-Origin: *`.
//
// Field names are matched case-insensitively against a short candidate list,
// so a capitalization change upstream is absorbed and a rename is a located
// error naming what was looked for, not a silent empty field.

import { parseWktPolygons, type WktPolygon } from './wkt.js';
import { ArchiveError, type ArchiveObservation, type FetchLike, type ObservationArchive } from './types.js';

export const ODE_API = 'https://oderest.rsl.wustl.edu/live2/';

export interface OdeQuery {
  /** ODE query terms, verbatim (`{ target: 'moon', ihid: 'LRO', iid: 'LROC', pt: 'EDRNAC' }`),
   *  including any `results` selector the ODE REST manual calls for. Only
   *  `query=product` and `output=JSON` are fixed here. */
  readonly params: Readonly<Record<string, string>>;
  readonly limit?: number;
  readonly offset?: number;
  readonly api?: string;
}

/** Candidate field names per quantity, most specific first. The -180..180
 *  (`C0`) footprint is preferred: it needs no seam handling for most targets. */
const FIELDS = {
  id: ['pdsid', 'ode_id'],
  start: ['UTC_start_time', 'Observation_time'],
  stop: ['UTC_stop_time'],
  target: ['Target_name'],
  instrument: ['iid'],
  footprint: ['Footprint_C0_geometry', 'Footprint_geometry', 'Footprint_GL_geometry'],
  incidence: ['Incidence_angle'],
  emission: ['Emission_angle'],
  phase: ['Phase_angle'],
  /** Metres per pixel. */
  resolution: ['Map_resolution'],
  campaign: ['Orbit_number', 'Observation_id'],
} as const;

function odeUrl(query: OdeQuery): string {
  const qs = new URLSearchParams({ ...query.params, query: 'product', output: 'JSON' });
  if (query.limit != null) qs.set('limit', String(query.limit));
  if (query.offset != null) qs.set('offset', String(query.offset));
  return `${query.api ?? ODE_API}?${qs}`;
}

function field(p: Record<string, unknown>, names: readonly string[]): string | undefined {
  const keys = Object.keys(p);
  for (const name of names) {
    const k = keys.find((key) => key.toLowerCase() === name.toLowerCase());
    if (k === undefined) continue;
    const v = p[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s !== '' && s.toUpperCase() !== 'N/A') return s;
  }
  return undefined;
}

function odeParse(body: unknown): ArchiveObservation[] {
  const results = (body as { ODEResults?: Record<string, unknown> } | null)?.ODEResults;
  if (!results) throw new ArchiveError('ODE: response has no ODEResults');
  const status = String(results.Status ?? '');
  if (status.toUpperCase() !== 'SUCCESS') {
    throw new ArchiveError(`ODE: status ${status || '(none)'}${results.Error ? `: ${String(results.Error)}` : ''}`);
  }
  const products = (results.Products as { Product?: unknown } | string | undefined);
  // ODE writes `"Products": "No Products Found"` for an empty result.
  if (!products || typeof products !== 'object' || products.Product == null) return [];
  const list = Array.isArray(products.Product) ? products.Product : [products.Product];

  return list.map((raw, i): ArchiveObservation => {
    const p = raw as Record<string, unknown>;
    const id = field(p, FIELDS.id);
    const where = `product ${i}${id ? ` (${id})` : ''}`;
    if (!id) throw new ArchiveError(`ODE ${where}: none of ${FIELDS.id.join('/')}`);
    const startTime = field(p, FIELDS.start);
    if (!startTime) throw new ArchiveError(`ODE ${where}: none of ${FIELDS.start.join('/')}`);

    const n = (names: readonly string[]) => {
      const s = field(p, names);
      if (s === undefined) return undefined;
      const v = Number(s);
      if (!Number.isFinite(v)) throw new ArchiveError(`ODE ${where}: ${names[0]} is not a number: ${JSON.stringify(s)}`);
      return v;
    };

    const wkt = field(p, FIELDS.footprint);
    let footprint: WktPolygon[] | undefined;
    if (wkt) {
      try {
        footprint = parseWktPolygons(wkt);
      } catch (err) {
        throw new ArchiveError(`ODE ${where}: footprint: ${(err as Error).message}`);
      }
    }
    const illumination = {
      ...(n(FIELDS.phase) !== undefined ? { phaseDeg: n(FIELDS.phase)! } : {}),
      ...(n(FIELDS.incidence) !== undefined ? { incidenceDeg: n(FIELDS.incidence)! } : {}),
      ...(n(FIELDS.emission) !== undefined ? { emissionDeg: n(FIELDS.emission)! } : {}),
    };
    const resolutionM = n(FIELDS.resolution);
    const stopTime = field(p, FIELDS.stop);
    const target = field(p, FIELDS.target);
    const instrument = field(p, FIELDS.instrument);
    const campaign = field(p, FIELDS.campaign);
    return {
      archive: 'ODE',
      id,
      startTime,
      timeSystem: 'UTC',
      ...(stopTime ? { stopTime } : {}),
      ...(target ? { target } : {}),
      ...(instrument ? { instrument } : {}),
      ...(campaign ? { campaign } : {}),
      ...(footprint?.length ? { footprint } : {}),
      ...(Object.keys(illumination).length ? { illumination } : {}),
      ...(resolutionM !== undefined ? { resolutionKm: resolutionM / 1000 } : {}),
    };
  });
}

export const ode: ObservationArchive<OdeQuery> = {
  name: 'ODE',
  url: odeUrl,
  parse: odeParse,
  async search(query, fetchFn = globalThis.fetch as unknown as FetchLike) {
    const url = odeUrl(query);
    const res = await fetchFn(url);
    if (!res.ok) throw new ArchiveError(`ODE: HTTP ${res.status} for ${url}`);
    return odeParse(await res.json());
  },
};
