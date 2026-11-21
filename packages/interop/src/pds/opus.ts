// OPUS (PDS Ring-Moon Systems Node) → ArchiveObservation. A thin field
// mapping, pure and headless; `fetch` is injected.
//
// OPUS's `api/data.json` answers with one array per observation, its values in
// the order of the `cols` the request named. So the mapping keys on the
// columns *we asked for* rather than on labels the response echoes, and the
// row array is read from `page` or `data` (both appear in OPUS's own docs).
// The API serves `Access-Control-Allow-Origin: *`, so this runs in a browser.
//
// Geometry columns are target-qualified in OPUS and are named by the caller
// (`disk`), not guessed here. A value of `N/A` — what OPUS reports for, e.g.,
// pole clock angles on every spacecraft instrument — reads as absent.

import { ArchiveError, type ArchiveObservation, type FetchLike, type ObservationArchive } from './types.js';

export const OPUS_API = 'https://opus.pds-rings.seti.org/opus/api';

/** OPUS column slugs for disk geometry on the searched target. */
export interface OpusDiskColumns {
  readonly subObsLat: string;
  /** OPUS reports IAU **west** longitude; the adapter converts to east. */
  readonly subObsLonWest: string;
  readonly centerDistance: string;
  /** RA/Dec bounds of the field of view; the box centre is the boresight. */
  readonly raMin?: string;
  readonly raMax?: string;
  readonly decMin?: string;
  readonly decMax?: string;
  readonly phase?: string;
}

export interface OpusQuery {
  /** OPUS search terms, verbatim (`{ instrument: 'Cassini ISS', time1: '2004-07-01' }`). */
  readonly params: Readonly<Record<string, string>>;
  /** Mission column carried, undecoded, as the campaign key (e.g. `CASSINIobsname`). */
  readonly campaignColumn?: string;
  readonly disk?: OpusDiskColumns;
  readonly limit?: number;
  readonly startObs?: number;
  readonly api?: string;
}

const BASE_COLUMNS = ['opusid', 'time1', 'time2', 'target', 'instrument'] as const;

/** Every column the request asks for, in the order rows come back. */
export function opusColumns(query: OpusQuery): string[] {
  const cols: string[] = [...BASE_COLUMNS];
  if (query.campaignColumn) cols.push(query.campaignColumn);
  if (query.disk) {
    for (const c of Object.values(query.disk)) if (c && !cols.includes(c)) cols.push(c);
  }
  return cols;
}

function opusUrl(query: OpusQuery): string {
  const qs = new URLSearchParams(query.params);
  qs.set('cols', opusColumns(query).join(','));
  if (query.limit != null) qs.set('limit', String(query.limit));
  if (query.startObs != null) qs.set('startobs', String(query.startObs));
  return `${query.api ?? OPUS_API}/data.json?${qs}`;
}

function text(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === '' || s.toUpperCase() === 'N/A' ? undefined : s;
}

function num(v: unknown, where: string): number | undefined {
  const s = text(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new ArchiveError(`OPUS ${where}: expected a number, got ${JSON.stringify(v)}`);
  return n;
}

/** Centre of an RA interval in degrees, across the 0/360 seam when min > max. */
function raCentre(min: number, max: number): number {
  const span = max >= min ? max - min : max + 360 - min;
  return (min + span / 2) % 360;
}

function opusParse(body: unknown, query: OpusQuery): ArchiveObservation[] {
  const b = body as { page?: unknown; data?: unknown; error?: unknown } | null;
  if (!b || typeof b !== 'object') throw new ArchiveError('OPUS: response is not a JSON object');
  if (b.error) throw new ArchiveError(`OPUS: ${String(b.error)}`);
  const rows = b.page ?? b.data;
  if (!Array.isArray(rows)) throw new ArchiveError('OPUS: response has no `page` (or `data`) array of rows');
  const cols = opusColumns(query);

  return rows.map((row, i): ArchiveObservation => {
    if (!Array.isArray(row) || row.length < cols.length) {
      throw new ArchiveError(`OPUS row ${i}: expected ${cols.length} values (${cols.join(',')}), got ${JSON.stringify(row)}`);
    }
    const get = (c: string) => row[cols.indexOf(c)];
    const id = text(get('opusid'));
    const startTime = text(get('time1'));
    const where = `row ${i}${id ? ` (${id})` : ''}`;
    if (!id) throw new ArchiveError(`OPUS ${where}: no opusid`);
    if (!startTime) throw new ArchiveError(`OPUS ${where}: no time1`);

    const d = query.disk;
    let disk: ArchiveObservation['disk'];
    if (d) {
      const lat = num(get(d.subObsLat), `${where} ${d.subObsLat}`);
      const lonW = num(get(d.subObsLonWest), `${where} ${d.subObsLonWest}`);
      const dist = num(get(d.centerDistance), `${where} ${d.centerDistance}`);
      if (lat !== undefined && lonW !== undefined && dist !== undefined) {
        const ra = d.raMin && d.raMax ? [num(get(d.raMin), where), num(get(d.raMax), where)] : [];
        const dec = d.decMin && d.decMax ? [num(get(d.decMin), where), num(get(d.decMax), where)] : [];
        const box = ra.length && dec.length && [...ra, ...dec].every((v) => v !== undefined);
        disk = {
          subObsLatDeg: lat,
          subObsLonDeg: (360 - lonW) % 360,
          distanceKm: dist,
          ...(box ? { boresightRaDecDeg: [raCentre(ra[0]!, ra[1]!), (dec[0]! + dec[1]!) / 2] as const } : {}),
        };
      }
    }
    const phaseDeg = d?.phase ? num(get(d.phase), `${where} ${d.phase}`) : undefined;

    const stopTime = text(get('time2'));
    const target = text(get('target'));
    const instrument = text(get('instrument'));
    const campaign = query.campaignColumn ? text(get(query.campaignColumn)) : undefined;
    return {
      archive: 'OPUS',
      id,
      startTime,
      timeSystem: 'UTC',
      ...(stopTime ? { stopTime } : {}),
      ...(target ? { target } : {}),
      ...(instrument ? { instrument } : {}),
      ...(campaign ? { campaign } : {}),
      ...(disk ? { disk } : {}),
      ...(phaseDeg !== undefined ? { illumination: { phaseDeg } } : {}),
    };
  });
}

export const opus: ObservationArchive<OpusQuery> = {
  name: 'OPUS',
  url: opusUrl,
  parse: opusParse,
  async search(query, fetchFn = globalThis.fetch as unknown as FetchLike) {
    const url = opusUrl(query);
    const res = await fetchFn(url);
    if (!res.ok) throw new ArchiveError(`OPUS: HTTP ${res.status} for ${url}`);
    return opusParse(await res.json(), query);
  },
};
