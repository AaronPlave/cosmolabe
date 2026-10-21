import type { GeographicFeature, GeographicLayer } from './model.js';
import { wrapLon } from './coordinates.js';

/** A view of an imported point, retaining the original feature and provenance. */
export interface Place {
  ref: string;
  layer: GeographicLayer;
  feature: GeographicFeature;
  name: string;
  kind: string;
  origin: 'nomenclature' | 'mission/user';
  aliases: string[];
  diameterKm?: number;
  /** Viewer policy, independent of the scientific extent. */
  label: PlaceLabelStyle;
}
export type PlaceLabelClass = 'major' | 'regional' | 'local' | 'site';
export interface PlaceLabelStyle {
  importance: number;
  class: PlaceLabelClass;
  minPixels: number;
}

/** Cartographic defaults, not an authoritative Gazetteer ranking. Catalogs may
 * override these visualization properties without changing source geometry. */
export function placeLabelStyle(kind: string, diameterKm: number | undefined, origin: Place['origin'], p: Record<string, unknown>): PlaceLabelStyle {
  const extent = diameterKm ?? 0;
  let cls: PlaceLabelClass = 'local', importance = 25, minPixels = 70;
  if (origin === 'mission/user') { cls = 'site'; importance = 55; minPixels = 100; }
  else if (/mons|montes|vallis|valles|chasma|chasmata/i.test(kind)) {
    cls = extent >= 100 ? 'major' : 'regional'; importance = cls === 'major' ? 90 : 65; minPixels = cls === 'major' ? 24 : 70;
  } else if (/mare|maria|oceanus|terra|regio|planum|planitia/i.test(kind)) {
    cls = extent >= 1000 ? 'major' : 'regional'; importance = cls === 'major' ? 80 : 60; minPixels = cls === 'major' ? 45 : 100;
  } else if (/crater/i.test(kind) && extent >= 150) { cls = 'regional'; importance = 45; minPixels = 120; }
  const override = p.labelClass;
  if (override === 'major' || override === 'regional' || override === 'local' || override === 'site') cls = override;
  if (typeof p.labelImportance === 'number' && Number.isFinite(p.labelImportance)) importance = Math.max(0, Math.min(100, p.labelImportance));
  if (typeof p.labelMinPixels === 'number' && Number.isFinite(p.labelMinPixels)) minPixels = Math.max(4, Math.min(2000, p.labelMinPixels));
  return { class: cls, importance, minPixels };
}
export const PLACE_LIMIT = 20_000;
export const placeText = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const text = (v: unknown): string => typeof v === 'string' ? v.slice(0, 512) : '';

/** Bounded word-prefix postings and ten-degree spatial cells. Hidden datasets
 * remain searchable; display state never edits scientific source records. */
export class PlaceIndex {
  readonly places: Place[] = [];
  readonly byRef = new Map<string, Place>();
  readonly diagnostics: string[] = [];
  private readonly words = new Map<string, Set<Place>>();
  private readonly cells = new Map<string, Place[]>();
  private vocabulary: string[] = [];

  constructor(layers: readonly GeographicLayer[]) {
    layers: for (const layer of layers) for (const feature of layer.features) {
      if (feature.geometry.type !== 'Point') continue;
      const p = feature.properties ?? {};
      const name = text(p.name) || text(p.Name) || text(p.NAME);
      if (!name) continue;
      if (this.places.length >= PLACE_LIMIT) { this.diagnostics.push(`Place index limit (${PLACE_LIMIT}) reached; remaining points are unavailable in search`); break layers; }
      const fields = p.sourceFields && typeof p.sourceFields === 'object' && !Array.isArray(p.sourceFields) ? p.sourceFields : {};
      const aliases = [...(Array.isArray(p.aliases) ? p.aliases.slice(0, 16).map(text) : []), text(fields.clean_name)].filter(Boolean);
      const ref = text(p.placeRef) || JSON.stringify([layer.id, feature.id]);
      if (this.byRef.has(ref)) {
        if (this.diagnostics.length < 32) this.diagnostics.push(`Duplicate place reference ${ref}`);
        continue;
      }
      const diameter = Number(p.diameterKm ?? fields.diameter);
      const kind = text(p.featureClass) || text(p.type) || 'Site';
      const origin = p.placeKind === 'nomenclature' ? 'nomenclature' as const : 'mission/user' as const;
      const diameterKm = Number.isFinite(diameter) && diameter > 0 ? diameter : undefined;
      const place: Place = { ref, layer, feature, name, aliases,
        kind, origin, diameterKm, label: placeLabelStyle(kind, diameterKm, origin, p) };
      this.places.push(place); this.byRef.set(ref, place);
      for (const word of new Set([name, ...aliases].flatMap(s => placeText(s).split(' ')).slice(0, 64))) {
        if (!word) continue;
        if (!this.words.has(word)) this.words.set(word, new Set());
        this.words.get(word)!.add(place);
      }
      const pos = feature.geometry.coordinates;
      const key = this.cell(layer.body, pos.lonDeg, pos.latDeg);
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key)!.push(place);
    }
    this.vocabulary = [...this.words.keys()].sort();
    for (const cell of this.cells.values()) cell.sort(placePriority);
  }

  search(query: string, opts: { body?: string; kind?: string; activeBody?: string; limit?: number } = {}): Place[] {
    const tokens = placeText(query).split(' ').filter(Boolean).slice(0, 8);
    let candidates: Set<Place> | undefined;
    for (const token of tokens) {
      let lo = 0, hi = this.vocabulary.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.vocabulary[mid] < token) lo = mid + 1; else hi = mid; }
      const matches = new Set<Place>();
      for (let i = lo; i < this.vocabulary.length && this.vocabulary[i].startsWith(token); i++)
        for (const place of this.words.get(this.vocabulary[i])!) matches.add(place);
      candidates = candidates ? new Set([...candidates].filter(p => matches.has(p))) : matches;
      if (!candidates.size) return [];
    }
    const exact = placeText(query);
    return [...(candidates ?? this.places)].filter(p => (!opts.body || p.layer.body === opts.body) && (!opts.kind || p.kind === opts.kind))
      .sort((a, b) => Number(b.layer.body === opts.activeBody) - Number(a.layer.body === opts.activeBody)
        || Number(placeText(b.name) === exact) - Number(placeText(a.name) === exact) || placePriority(a, b))
      .slice(0, Math.max(0, Math.min(opts.limit ?? 30, 100)));
  }

  /** All intersecting cells are ranked together before applying a limit.
   * Longitude cells wrap and polar caps expand to all longitudes. */
  nearby(body: string, lon: number, lat: number, radiusDeg: number, limit = 512): Place[] {
    const radius = Math.max(0, Math.min(180, radiusDeg));
    const span = Math.abs(lat) + radius >= 90 ? 180 : Math.min(180, radius / Math.max(0.01, Math.cos((Math.abs(lat) + radius) * Math.PI / 180)));
    const bins: Place[][] = [];
    const seen = new Set<string>();
    for (let y = Math.min(17, Math.max(0, Math.floor((lat - radius + 90) / 10))); y <= Math.min(17, Math.floor((lat + radius + 90) / 10)); y++)
      for (let x = Math.floor((lon - span + 180) / 10); x <= Math.floor((lon + span + 180) / 10); x++) {
        const key = `${body}:${((x % 36) + 36) % 36}:${y}`;
        if (!seen.has(key)) { seen.add(key); const cell = this.cells.get(key); if (cell) bins.push(cell); }
      }
    return bins.flat().sort(placePriority).slice(0, Math.max(0, Math.min(limit, PLACE_LIMIT)));
  }

  private cell(body: string, lon: number, lat: number): string {
    return `${body}:${Math.floor((wrapLon(lon) + 180) / 10)}:${Math.min(17, Math.floor((lat + 90) / 10))}`;
  }
}

export const placePriority = (a: Place, b: Place): number => b.label.importance - a.label.importance || (b.diameterKm ?? 0) - (a.diameterKm ?? 0) || a.ref.localeCompare(b.ref);
