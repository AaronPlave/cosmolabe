import type { GeographicFeature, GeographicLayer, JsonValue } from './model.js';

/**
 * Presentation for a geographic layer, kept apart from its data: a small
 * declarative, versioned object with geometry-specific layer defaults, an
 * optional property rule, labels and explicit per-feature overrides. Resolving
 * it never reads or writes source geometry or properties, and nothing here
 * depends on a renderer or UI library. Shared views (#119) can carry this
 * object keyed by stable layer ID instead of the dataset.
 *
 * Every field is optional; an empty style draws exactly as the catalog's
 * `display` defaults do.
 */
export const GEOGRAPHIC_STYLE_VERSION = 1;

export type GeographicPointShape = 'circle' | 'square' | 'diamond';
export type GeographicColorRamp = 'viridis' | 'magma' | 'blues' | 'reds';

export interface GeographicPointStyle { color?: string; opacity?: number; sizePx?: number; shape?: GeographicPointShape; halo?: boolean }
export interface GeographicLineStyle { color?: string; opacity?: number; widthPx?: number; dashed?: boolean; outline?: boolean }
export interface GeographicPolygonStyle {
  fillColor?: string; fillOpacity?: number; hatch?: boolean;
  outlineColor?: string; outlineOpacity?: number; outlineWidthPx?: number;
}
export type GeographicStyleRule =
  /** `colors` is explicit, so a value keeps its colour when the data changes. */
  | { kind: 'categorical'; field: string; colors: { [value: string]: string }; otherColor?: string; missingColor?: string }
  | { kind: 'sequential'; field: string; min: number; max: number; ramp: GeographicColorRamp; missingColor?: string };
export interface GeographicLabelStyle {
  /** Property shown; null labels by feature name. */
  field: string | null;
  sizePx?: number;
  /** At most this many labels at once, after decluttering. */
  maxLabels?: number;
  /** Labels show only while the camera is within this range of the body's surface. */
  maxRangeKm?: number;
  halo?: boolean;
}
export interface GeographicFeatureStyleOverride { color?: string; opacity?: number }

export interface GeographicLayerStyle {
  version: typeof GEOGRAPHIC_STYLE_VERSION;
  /** Multiplies every part's opacity, after the catalog's display opacity. */
  opacity?: number;
  point?: GeographicPointStyle;
  line?: GeographicLineStyle;
  polygon?: GeographicPolygonStyle;
  rule?: GeographicStyleRule | null;
  labels?: GeographicLabelStyle | null;
  /** Explicit exceptions only, keyed by the feature's stable ID. */
  features?: { [featureId: string]: GeographicFeatureStyleOverride };
}

/** What one feature draws with. Colours are `#rrggbb`; sizes are CSS pixels. */
export interface ResolvedGeographicStyle {
  point: { color: string; opacity: number; sizePx: number; shape: GeographicPointShape; halo: boolean };
  line: { color: string; opacity: number; widthPx: number; dashed: boolean; outline: boolean };
  fill: { color: string; opacity: number; hatch: boolean };
  outline: { color: string; opacity: number; widthPx: number };
}

export const GEOGRAPHIC_STYLE_LIMITS = Object.freeze({
  sizePx: [2, 24] as const,
  widthPx: [0.5, 12] as const,
  labelSizePx: [9, 20] as const,
  maxLabels: [1, 200] as const,
  featureOverrides: 512,
  categories: 24,
});

const DEFAULT_COLOR = '#59c5dd';
const MISSING_COLOR = '#8a8f98';
/** Okabe–Ito, then four more distinguishable hues: readable for common colour-vision deficiencies. */
export const GEOGRAPHIC_CATEGORY_PALETTE: readonly string[] = [
  '#e69f00', '#56b4e9', '#009e73', '#f0e442', '#0072b2', '#d55e00', '#cc79a7', '#ffffff',
  '#a6761d', '#7fc97f', '#beaed4', '#fb8072',
];
const RAMPS: Record<GeographicColorRamp, readonly string[]> = {
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  magma: ['#000004', '#51127c', '#b73779', '#fc8961', '#fcfdbf'],
  blues: ['#deebf7', '#9ecae1', '#6baed6', '#3182bd', '#08519c'],
  reds: ['#fee0d2', '#fc9272', '#fb6a4a', '#de2d26', '#a50f15'],
};
export const GEOGRAPHIC_COLOR_RAMPS = Object.keys(RAMPS) as GeographicColorRamp[];

export const isGeographicColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** `#rgb`/`#rrggbb` (any case) to `#rrggbb`; null for anything else, named colours included. */
export function normalizeGeographicColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return null;
}

/** Interpolate a ramp at t in [0, 1]. */
export function geographicRampColor(ramp: GeographicColorRamp, t: number): string {
  const stops = RAMPS[ramp];
  const x = clamp(Number.isFinite(t) ? t : 0, [0, 1]) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = parseInt(stops[i].slice(1), 16), b = parseInt(stops[i + 1].slice(1), 16);
  const channel = (shift: number) => Math.round(((a >> shift) & 255) * (1 - f) + ((b >> shift) & 255) * f);
  return `#${[16, 8, 0].map(s => channel(s).toString(16).padStart(2, '0')).join('')}`;
}

/** The key a categorical rule matches: strings as is, numbers and booleans as text; null for missing. */
export function geographicCategoryKey(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null || typeof value === 'object') return null;
  return String(value);
}

function ruleColor(rule: GeographicStyleRule, feature: GeographicFeature, base: string): string {
  const value = feature.properties?.[rule.field];
  if (rule.kind === 'categorical') {
    const key = geographicCategoryKey(value);
    if (key === null) return rule.missingColor ?? MISSING_COLOR;
    return rule.colors[key] ?? rule.otherColor ?? base;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return rule.missingColor ?? MISSING_COLOR;
  const span = rule.max - rule.min;
  return geographicRampColor(rule.ramp, span > 0 ? (value - rule.min) / span : 0.5);
}

/**
 * The style one feature draws with: catalog display defaults, then the layer
 * style's geometry defaults, then its rule, then this feature's explicit
 * override. Opacities multiply: catalog × layer × part × feature.
 */
export function resolveGeographicStyle(layer: GeographicLayer, style: GeographicLayerStyle | null | undefined, feature: GeographicFeature): ResolvedGeographicStyle {
  const display = layer.definition.display ?? {};
  const base = normalizeGeographicColor(display.color) ?? DEFAULT_COLOR;
  const layerOpacity = (display.opacity ?? 1) * (style?.opacity ?? 1);
  const override = style?.features?.[feature.id];
  const ruled = style?.rule ? ruleColor(style.rule, feature, base) : null;
  const pick = (explicit?: string) => override?.color ?? ruled ?? explicit ?? base;
  const alpha = (part = 1) => layerOpacity * part * (override?.opacity ?? 1);
  const p = style?.point ?? {}, l = style?.line ?? {}, g = style?.polygon ?? {};
  const fill = pick(g.fillColor);
  return {
    point: { color: pick(p.color), opacity: alpha(p.opacity), sizePx: p.sizePx ?? 7, shape: p.shape ?? 'circle', halo: p.halo ?? false },
    line: { color: pick(l.color), opacity: alpha(l.opacity), widthPx: l.widthPx ?? 2, dashed: l.dashed ?? false, outline: l.outline ?? false },
    fill: { color: fill, opacity: alpha(g.fillOpacity ?? 0.14), hatch: g.hatch ?? false },
    // An outline follows the fill unless it has its own colour; a feature override still wins.
    outline: { color: override?.color ?? g.outlineColor ?? fill, opacity: alpha(g.outlineOpacity), widthPx: g.outlineWidthPx ?? 2 },
  };
}

/**
 * Accept a stored or shared style: keep valid fields, drop the rest with a
 * reason, and clamp numbers into their ranges. Never throws.
 */
export function validateGeographicLayerStyle(raw: unknown): { style: GeographicLayerStyle; warnings: string[] } {
  const warnings: string[] = [];
  const style: GeographicLayerStyle = { version: GEOGRAPHIC_STYLE_VERSION };
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(raw)) return { style, warnings: ['Style must be an object; using defaults'] };
  if (raw.version !== GEOGRAPHIC_STYLE_VERSION) warnings.push(`Unknown style version ${String(raw.version)}; reading it as version ${GEOGRAPHIC_STYLE_VERSION}`);
  const num = (v: unknown, path: string, range?: readonly [number, number]): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) { warnings.push(`${path} must be a number`); return undefined; }
    return range ? clamp(v, range) : v;
  };
  const color = (v: unknown, path: string): string | undefined => {
    if (v === undefined) return undefined;
    const c = normalizeGeographicColor(v);
    if (!c) warnings.push(`${path} must be a #rrggbb colour`);
    return c ?? undefined;
  };
  const bool = (v: unknown, path: string): boolean | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') { warnings.push(`${path} must be true or false`); return undefined; }
    return v;
  };
  const prune = <T extends object>(o: T): T | undefined => {
    const kept = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
    return Object.keys(kept).length ? kept : undefined;
  };
  const opacity = [0, 1] as const;
  style.opacity = num(raw.opacity, 'opacity', opacity);
  if (object(raw.point)) {
    const shape = raw.point.shape;
    if (shape !== undefined && !['circle', 'square', 'diamond'].includes(String(shape))) warnings.push('point.shape must be circle, square or diamond');
    style.point = prune({
      color: color(raw.point.color, 'point.color'), opacity: num(raw.point.opacity, 'point.opacity', opacity),
      sizePx: num(raw.point.sizePx, 'point.sizePx', GEOGRAPHIC_STYLE_LIMITS.sizePx),
      shape: ['circle', 'square', 'diamond'].includes(String(shape)) ? shape as GeographicPointShape : undefined,
      halo: bool(raw.point.halo, 'point.halo'),
    });
  }
  if (object(raw.line)) style.line = prune({
    color: color(raw.line.color, 'line.color'), opacity: num(raw.line.opacity, 'line.opacity', opacity),
    widthPx: num(raw.line.widthPx, 'line.widthPx', GEOGRAPHIC_STYLE_LIMITS.widthPx),
    dashed: bool(raw.line.dashed, 'line.dashed'), outline: bool(raw.line.outline, 'line.outline'),
  });
  if (object(raw.polygon)) style.polygon = prune({
    fillColor: color(raw.polygon.fillColor, 'polygon.fillColor'), fillOpacity: num(raw.polygon.fillOpacity, 'polygon.fillOpacity', opacity),
    hatch: bool(raw.polygon.hatch, 'polygon.hatch'),
    outlineColor: color(raw.polygon.outlineColor, 'polygon.outlineColor'), outlineOpacity: num(raw.polygon.outlineOpacity, 'polygon.outlineOpacity', opacity),
    outlineWidthPx: num(raw.polygon.outlineWidthPx, 'polygon.outlineWidthPx', GEOGRAPHIC_STYLE_LIMITS.widthPx),
  });
  const rule = raw.rule;
  if (object(rule)) {
    if (typeof rule.field !== 'string' || !rule.field) warnings.push('rule.field must name a property');
    else if (rule.kind === 'categorical' && object(rule.colors)) {
      const colors: Record<string, string> = {};
      for (const [key, value] of Object.entries(rule.colors).slice(0, GEOGRAPHIC_STYLE_LIMITS.categories)) {
        const c = color(value, `rule.colors.${key}`);
        if (c) colors[key] = c;
      }
      if (Object.keys(rule.colors).length > GEOGRAPHIC_STYLE_LIMITS.categories) warnings.push(`rule.colors keeps the first ${GEOGRAPHIC_STYLE_LIMITS.categories} categories`);
      style.rule = { kind: 'categorical', field: rule.field, colors,
        ...prune({ otherColor: color(rule.otherColor, 'rule.otherColor'), missingColor: color(rule.missingColor, 'rule.missingColor') }) };
    } else if (rule.kind === 'sequential') {
      const min = num(rule.min, 'rule.min'), max = num(rule.max, 'rule.max');
      const ramp = GEOGRAPHIC_COLOR_RAMPS.includes(rule.ramp as GeographicColorRamp) ? rule.ramp as GeographicColorRamp : 'viridis';
      if (min === undefined || max === undefined || max < min) warnings.push('rule needs min ≤ max');
      else style.rule = { kind: 'sequential', field: rule.field, min, max, ramp,
        ...prune({ missingColor: color(rule.missingColor, 'rule.missingColor') }) };
    } else warnings.push('rule.kind must be categorical (with colors) or sequential');
  } else if (rule !== undefined && rule !== null) warnings.push('rule must be an object');
  const labels = raw.labels;
  if (object(labels)) {
    if (labels.field !== null && typeof labels.field !== 'string') warnings.push('labels.field must be a property name or null');
    else style.labels = { field: labels.field as string | null, ...prune({
      sizePx: num(labels.sizePx, 'labels.sizePx', GEOGRAPHIC_STYLE_LIMITS.labelSizePx),
      maxLabels: num(labels.maxLabels, 'labels.maxLabels', GEOGRAPHIC_STYLE_LIMITS.maxLabels),
      maxRangeKm: num(labels.maxRangeKm, 'labels.maxRangeKm', [0.001, 1e9]),
      halo: bool(labels.halo, 'labels.halo'),
    }) };
  }
  if (object(raw.features)) {
    const entries = Object.entries(raw.features);
    if (entries.length > GEOGRAPHIC_STYLE_LIMITS.featureOverrides) warnings.push(`Keeping the first ${GEOGRAPHIC_STYLE_LIMITS.featureOverrides} feature overrides`);
    const features: Record<string, GeographicFeatureStyleOverride> = {};
    for (const [id, value] of entries.slice(0, GEOGRAPHIC_STYLE_LIMITS.featureOverrides)) {
      if (!object(value)) continue;
      const kept = prune({ color: color(value.color, `features.${id}.color`), opacity: num(value.opacity, `features.${id}.opacity`, opacity) });
      if (kept) features[id] = kept;
    }
    if (Object.keys(features).length) style.features = features;
  }
  for (const key of ['opacity', 'point', 'line', 'polygon'] as const) if (style[key] === undefined) delete style[key];
  return { style, warnings };
}

/** True when the style changes nothing about how the layer draws. */
export function geographicStyleIsDefault(style: GeographicLayerStyle | null | undefined): boolean {
  if (!style) return true;
  const { version: _version, ...rest } = style;
  return Object.values(rest).every(v => v === undefined || v === null || (typeof v === 'object' && !Object.keys(v).length));
}

export interface GeographicLegendEntry { label: string; color: string; count: number }
export interface GeographicLegend { entries: GeographicLegendEntry[]; warnings: string[] }

/** Values of a field across a layer, for building rules and legends. */
function fieldValues(layer: GeographicLayer, field: string) {
  let missing = 0, invalid = 0;
  const counts = new Map<string, number>();
  const numbers: number[] = [];
  for (const feature of layer.features) {
    const value = feature.properties?.[field];
    const key = geographicCategoryKey(value);
    if (key === null) { if (value === undefined || value === null) missing++; else invalid++; continue; }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (typeof value === 'number' && Number.isFinite(value)) numbers.push(value);
  }
  return { counts, numbers, missing, invalid };
}

/**
 * A categorical rule over `field` with an explicit colour per value, in sorted
 * order so the same data always gets the same colours. Values past the palette
 * share `otherColor`.
 */
export function geographicCategoricalRule(layer: GeographicLayer, field: string): Extract<GeographicStyleRule, { kind: 'categorical' }> {
  const values = [...fieldValues(layer, field).counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const colors: Record<string, string> = {};
  values.slice(0, GEOGRAPHIC_CATEGORY_PALETTE.length).forEach((value, i) => { colors[value] = GEOGRAPHIC_CATEGORY_PALETTE[i]; });
  return { kind: 'categorical', field, colors, otherColor: MISSING_COLOR, missingColor: '#4b5059' };
}

/** A sequential rule over `field` spanning its finite values; null when it has none. */
export function geographicSequentialRule(layer: GeographicLayer, field: string, ramp: GeographicColorRamp = 'viridis'): Extract<GeographicStyleRule, { kind: 'sequential' }> | null {
  const { numbers } = fieldValues(layer, field);
  if (!numbers.length) return null;
  return { kind: 'sequential', field, min: Math.min(...numbers), max: Math.max(...numbers), ramp, missingColor: '#4b5059' };
}

/** Legend entries from the layer's actual values, with warnings about missing, invalid or too many values. */
export function geographicStyleLegend(layer: GeographicLayer, rule: GeographicStyleRule): GeographicLegend {
  const { counts, numbers, missing, invalid } = fieldValues(layer, rule.field);
  const warnings: string[] = [];
  const total = layer.features.length;
  if (missing === total) warnings.push(`No feature has “${rule.field}”`);
  else if (missing) warnings.push(`${missing} of ${total} features have no “${rule.field}”`);
  const entries: GeographicLegendEntry[] = [];
  if (rule.kind === 'categorical') {
    let other = 0;
    const sorted = [...counts].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    for (const [value, count] of sorted) {
      const color = rule.colors[value];
      if (color) entries.push({ label: value, color, count }); else other += count;
    }
    if (invalid) warnings.push(`${invalid} values are objects or lists and count as missing`);
    if (counts.size > Object.keys(rule.colors).length) {
      warnings.push(`${counts.size} distinct values; ${counts.size - entries.length} share “Other”${counts.size > 50 ? '. This field may be an identifier rather than a category' : ''}`);
    }
    if (other) entries.push({ label: 'Other', color: rule.otherColor ?? layer.definition.display?.color ?? DEFAULT_COLOR, count: other });
  } else {
    const nonNumeric = total - missing - numbers.length;
    if (nonNumeric) warnings.push(`${nonNumeric} values are not numbers and draw as missing`);
    if (rule.max === rule.min) warnings.push('min equals max: every value draws mid-ramp');
    // Five stops; each value counts toward its nearest stop (values outside min–max clamp to the ends).
    const bins = [0, 0, 0, 0, 0];
    const span = rule.max - rule.min;
    for (const n of numbers) bins[Math.round(clamp(span > 0 ? (n - rule.min) / span : 0.5, [0, 1]) * 4)]++;
    bins.forEach((count, i) => {
      const value = rule.min + span * i / 4;
      entries.push({ label: Number(value.toPrecision(4)).toString(), color: geographicRampColor(rule.ramp, i / 4), count });
    });
  }
  const missingTotal = rule.kind === 'categorical' ? missing + invalid : total - numbers.length;
  if (missingTotal) entries.push({ label: 'Missing', color: rule.missingColor ?? MISSING_COLOR, count: missingTotal });
  return { entries, warnings };
}
