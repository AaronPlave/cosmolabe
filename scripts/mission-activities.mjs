/** Explicit semantic importers. No trajectory geometry or sample access. */
import { hoppers } from './moonfall-schedule.mjs';
export function ingenuityActivities(index) {
  return index.map(f => ({ version: 1, id: `ingenuity:flight:${f.flight}`, name: `Flight ${f.flight}`,
    kind: 'flight', vehicle: 'Ingenuity', body: 'Mars', mission: 'Mars 2020', temporality: 'interval',
    timeSystem: 'ET', start: f.etStart, end: f.etEnd, site: f.toAirfld,
    provenance: { source: 'https://mars.nasa.gov/maps/location/?mission=M20', version: 'pinned-MMGIS-flights-index-v1',
      authority: 'estimated', timing: 'estimated',
      limitations: 'Original MMGIS event epochs retained as approximate J2000 seconds; clock drift uncalibrated. Observed horizontal path with estimated 3D playback, not precise flight telemetry.' },
    references: { trajectory: 'Ingenuity', sourceSegment: f.file } }));
}
export function moonfallActivities() {
  return hoppers.flatMap(h => h.flights.flatMap((f, i) => {
    const end = new Date(Date.parse(f.epoch) + f.waypoints.at(-1).t * 1000).toISOString();
    const base = { version: 1, vehicle: h.name, body: 'Moon', mission: 'MoonFall demonstration',
      timeSystem: 'UTC', provenance: { source: 'scripts/moonfall-schedule.mjs', version: 'authored-sorties-v1',
        authority: 'authored', timing: 'exact', limitations: 'Authored catalog demonstration; not mission-provided operational plans, observations or predicted flight operations. UTC epochs from the existing demo; no coordinates or lunar frames changed.' } };
    return [{ ...base, id: `moonfall:${h.name}:hop:${i+1}`, name: f.label, kind: 'hop', temporality: 'interval', start: f.epoch, end },
      { ...base, id: `moonfall:${h.name}:landing:${i+1}`, name: `Landing after ${f.label}`, kind: 'landing', temporality: 'instant', start: end, end }];
  }));
}
export function curiosityActivities() {
  const source = 'https://www.nasa.gov/missions/mars-science-laboratory/curiosity-rover/nasas-curiosity-drives-on-after-crossing-martian-dune/';
  return [
    ['dingo-crossing', 'Dingo Gap dune crossing (Sol 535)', '2014-02-05', '2014-02-08'],
    ['westward-drive', 'West of Dingo Gap: 41.1 m drive (Sol 538)', '2014-02-08', '2014-02-11'],
  ].map(([id, name, day, next]) => ({ version: 1, id: `curiosity:${id}`, name, kind: 'drive', vehicle: 'Curiosity', body: 'Mars',
    mission: 'Mars Science Laboratory', site: 'Dingo Gap', temporality: 'interval', timeSystem: 'UTC',
    start: `${day}T00:00:00Z`, end: `${next}T00:00:00Z`,
    provenance: { source, version: 'NASA-release-2014-02-11', authority: 'authored', timing: 'bounded',
      limitations: 'Curated from NASA-reported Earth dates and sols. UTC discovery window extends one day before/after the reported calendar date because its time zone is unspecified; actual start/end and drive duration are unknown. Not a SPICE-derived operation interval; poses do not establish activity timing.' } }));
}
