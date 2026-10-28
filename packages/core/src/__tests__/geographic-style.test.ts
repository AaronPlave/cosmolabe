import { describe, it, expect } from 'vitest';
import {
  parseGeographicGeoJson, resolveGeographicStyle, validateGeographicLayerStyle, geographicStyleIsDefault,
  geographicCategoricalRule, geographicSequentialRule, geographicStyleLegend, geographicRampColor, normalizeGeographicColor,
  GEOGRAPHIC_CATEGORY_PALETTE, GEOGRAPHIC_STYLE_LIMITS, type GeographicLayer, type GeographicLayerStyle,
} from '../geographic/index.js';

function layer(properties: (Record<string, unknown> | null)[], display?: { color?: string; opacity?: number }): GeographicLayer {
  const features = properties.map((p, i) => ({ type: 'Feature', id: `f${i}`, properties: p, geometry: { type: 'Point', coordinates: [i, 0] } }));
  return parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features }), {
    id: 'l', name: 'L', body: 'Mars', source: 'l.geojson', display,
    coordinates: { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 3389.5 } },
  }, { kind: 'catalog', identity: 'l.geojson' });
}
const v1 = (s: Omit<GeographicLayerStyle, 'version'>): GeographicLayerStyle => ({ version: 1, ...s });

describe('resolving a feature style', () => {
  const data = layer([{ kind: 'rock', sol: 10 }, { kind: 'soil', sol: 30 }, { sol: 'n/a' }, null], { color: '#ffcc00', opacity: 0.5 });

  it('matches the catalog display defaults with no style', () => {
    const r = resolveGeographicStyle(data, null, data.features[0]);
    expect(r.point).toEqual({ color: '#ffcc00', opacity: 0.5, sizePx: 7, shape: 'circle', halo: false });
    expect(r.line).toMatchObject({ color: '#ffcc00', opacity: 0.5, widthPx: 2, dashed: false });
    expect(r.fill).toMatchObject({ color: '#ffcc00', hatch: false });
    expect(r.fill.opacity).toBeCloseTo(0.07, 12);
    expect(r.outline).toEqual({ color: '#ffcc00', opacity: 0.5, widthPx: 2 });
  });

  it('applies geometry defaults, multiplies opacities, and lets an explicit feature override win', () => {
    const style = v1({ opacity: 0.5, point: { color: '#112233', opacity: 0.8, sizePx: 12, shape: 'diamond', halo: true },
      polygon: { fillColor: '#00ff00', outlineColor: '#0000ff' }, features: { 'string:f1': { color: '#ff0000', opacity: 0.5 } } });
    const plain = resolveGeographicStyle(data, style, data.features[0]);
    expect(plain.point).toEqual({ color: '#112233', opacity: 0.5 * 0.5 * 0.8, sizePx: 12, shape: 'diamond', halo: true });
    expect(plain.fill.color).toBe('#00ff00');
    expect(plain.outline.color).toBe('#0000ff');
    const overridden = resolveGeographicStyle(data, style, data.features[1]);
    expect(overridden.point.color).toBe('#ff0000');
    expect(overridden.outline.color).toBe('#ff0000');
    expect(overridden.point.opacity).toBeCloseTo(0.5 * 0.5 * 0.8 * 0.5, 12);
  });

  it('colours by category with explicit colours, other and missing values', () => {
    const rule = geographicCategoricalRule(data, 'kind');
    expect(rule.colors).toEqual({ rock: GEOGRAPHIC_CATEGORY_PALETTE[0], soil: GEOGRAPHIC_CATEGORY_PALETTE[1] });
    const style = v1({ rule: { ...rule, colors: { rock: '#010101' }, otherColor: '#020202', missingColor: '#030303' } });
    expect(data.features.map(f => resolveGeographicStyle(data, style, f).point.color)).toEqual(['#010101', '#020202', '#030303', '#030303']);
    // The outline follows the rule colour unless the polygon sets its own.
    expect(resolveGeographicStyle(data, style, data.features[0]).outline.color).toBe('#010101');
  });

  it('colours by number along a ramp, clamping outside min–max and marking non-numbers missing', () => {
    const rule = geographicSequentialRule(data, 'sol')!;
    expect(rule).toMatchObject({ min: 10, max: 30, ramp: 'viridis' });
    const colors = data.features.map(f => resolveGeographicStyle(data, v1({ rule }), f).point.color);
    expect(colors[0]).toBe(geographicRampColor('viridis', 0));
    expect(colors[1]).toBe(geographicRampColor('viridis', 1));
    expect(colors[2]).toBe(rule.missingColor);
    expect(geographicSequentialRule(data, 'kind')).toBeNull();
    expect(resolveGeographicStyle(data, v1({ rule: { ...rule, max: 20 } }), data.features[1]).point.color).toBe(geographicRampColor('viridis', 1));
  });

  it('never touches source properties or geometry', () => {
    const before = JSON.stringify(data.features);
    resolveGeographicStyle(data, v1({ rule: geographicCategoricalRule(data, 'kind'), features: { 'string:f0': { color: '#000000' } } }), data.features[0]);
    expect(JSON.stringify(data.features)).toBe(before);
  });
});

describe('validating stored styles', () => {
  it('keeps valid fields, clamps ranges and explains what it dropped', () => {
    const { style, warnings } = validateGeographicLayerStyle({
      version: 1, opacity: 2,
      point: { color: '#ABC', sizePx: 100, shape: 'star', halo: 'yes' },
      line: { color: 'red', widthPx: 0.1, dashed: true },
      polygon: { fillOpacity: -1 },
      rule: { kind: 'sequential', field: 'sol', min: 5, max: 1, ramp: 'viridis' },
      labels: { field: 'name', sizePx: 4, maxLabels: 1e6 },
      features: { a: { color: '#000000' }, b: { color: 'javascript:alert(1)' } },
    });
    expect(style).toEqual({
      version: 1, opacity: 1,
      point: { color: '#aabbcc', sizePx: GEOGRAPHIC_STYLE_LIMITS.sizePx[1] },
      line: { widthPx: GEOGRAPHIC_STYLE_LIMITS.widthPx[0], dashed: true },
      polygon: { fillOpacity: 0 },
      labels: { field: 'name', sizePx: GEOGRAPHIC_STYLE_LIMITS.labelSizePx[0], maxLabels: GEOGRAPHIC_STYLE_LIMITS.maxLabels[1] },
      features: { a: { color: '#000000' } },
    });
    expect(warnings).toEqual(expect.arrayContaining([
      'point.shape must be circle, square or diamond', 'point.halo must be true or false', 'line.color must be a #rrggbb colour',
      'rule needs min ≤ max', 'features.b.color must be a #rrggbb colour',
    ]));
  });

  it('bounds feature overrides and categories, and survives garbage', () => {
    const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`f${i}`, { opacity: 0.5 }]));
    expect(Object.keys(validateGeographicLayerStyle({ version: 1, features: many }).style.features!)).toHaveLength(GEOGRAPHIC_STYLE_LIMITS.featureOverrides);
    const colors = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`v${i}`, '#123456']));
    const rule = validateGeographicLayerStyle({ version: 1, rule: { kind: 'categorical', field: 'k', colors } }).style.rule;
    expect(Object.keys(rule!.kind === 'categorical' ? rule!.colors : {})).toHaveLength(GEOGRAPHIC_STYLE_LIMITS.categories);
    expect(validateGeographicLayerStyle('nope')).toEqual({ style: { version: 1 }, warnings: ['Style must be an object; using defaults'] });
    expect(validateGeographicLayerStyle({ version: 7 }).warnings[0]).toMatch(/Unknown style version 7/);
  });

  it('round-trips a full style through JSON unchanged', () => {
    const data = layer([{ kind: 'a' }]);
    const style = v1({ opacity: 0.8, point: { sizePx: 9, shape: 'square', halo: true }, line: { dashed: true, outline: true, widthPx: 3 },
      polygon: { hatch: true, outlineWidthPx: 1 }, rule: geographicCategoricalRule(data, 'kind'), labels: { field: 'kind', maxRangeKm: 500, halo: true },
      features: { f0: { opacity: 0.3 } } });
    expect(validateGeographicLayerStyle(JSON.parse(JSON.stringify(style)))).toEqual({ style, warnings: [] });
  });

  it('recognises a style that changes nothing', () => {
    expect(geographicStyleIsDefault(null)).toBe(true);
    expect(geographicStyleIsDefault({ version: 1, features: {}, rule: null })).toBe(true);
    expect(geographicStyleIsDefault({ version: 1, opacity: 0.5 })).toBe(false);
  });

  it('normalizes only hex colours', () => {
    expect(normalizeGeographicColor('#FfF')).toBe('#ffffff');
    expect(normalizeGeographicColor('red')).toBeNull();
    expect(normalizeGeographicColor('#12345')).toBeNull();
  });
});

describe('legends from actual values', () => {
  it('lists categories in stable order with counts, Other and Missing, and warns on cardinality', () => {
    const data = layer([{ k: 'b' }, { k: 'a' }, { k: 'a' }, { k: 3 }, {}, { k: [1] }]);
    const rule = { ...geographicCategoricalRule(data, 'k'), colors: { a: '#000001', b: '#000002' } };
    const legend = geographicStyleLegend(data, rule);
    expect(legend.entries.map(e => [e.label, e.count])).toEqual([['a', 2], ['b', 1], ['Other', 1], ['Missing', 2]]);
    expect(legend.warnings).toEqual(expect.arrayContaining(['1 of 6 features have no “k”', '1 values are objects or lists and count as missing', '3 distinct values; 1 share “Other”']));
  });

  it('flags an identifier-like field', () => {
    const data = layer(Array.from({ length: 60 }, (_, i) => ({ id: `x${i}` })));
    expect(geographicStyleLegend(data, geographicCategoricalRule(data, 'id')).warnings.join(' ')).toMatch(/identifier/);
  });

  it('bins numbers to the nearest of five ramp stops and counts non-numbers as missing', () => {
    const data = layer([{ v: 0 }, { v: 25 }, { v: 50 }, { v: 100 }, { v: 'x' }, {}]);
    const legend = geographicStyleLegend(data, geographicSequentialRule(data, 'v')!);
    expect(legend.entries.map(e => [e.label, e.count])).toEqual([['0', 1], ['25', 1], ['50', 1], ['75', 0], ['100', 1], ['Missing', 2]]);
    expect(legend.warnings).toEqual(expect.arrayContaining(['1 values are not numbers and draw as missing']));
  });

  it('warns when no feature has the field', () => {
    const data = layer([{}, {}]);
    expect(geographicStyleLegend(data, { kind: 'categorical', field: 'z', colors: {} }).warnings[0]).toBe('No feature has “z”');
  });
});
