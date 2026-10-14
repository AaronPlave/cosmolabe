/**
 * Every key a catalog writes must be one the code reads (issue #10).
 *
 * A key nobody reads is silently dropped and the scene still renders, just
 * without what the key asked for: `axes` for `sequence` left a body with no
 * attitude, `visible` inside `trajectory` instead of `trajectoryPlot` drew a
 * 1-AU orbit line across a lunar-surface scene. `validateCatalog` reports each
 * one at the node that owns it; the loader prints those reports.
 *
 * The shipped catalogs must produce none, and the names that have actually
 * been written by mistake must each be caught with the right fix.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { validateCatalog } from '../catalog/CatalogSchema.js';
import { CatalogLoader, type CatalogJson } from '../catalog/CatalogLoader.js';

const REPO = join(__dirname, '../../../..');
const CATALOG_ROOTS = [
  join(REPO, 'apps/viewer/test-catalogs'),
  join(REPO, 'packages/core/src/builtin-catalogs'),
];

function jsonFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.json')) out.push(full);
    }
  };
  try {
    walk(dir);
  } catch {
    /* a catalog root that isn't checked out is not a failure here */
  }
  return out.sort();
}

/** Catalogs only: the trees also hold GeoJSON, the catalog index, and data. */
function shippedCatalogs(): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const file of CATALOG_ROOTS.flatMap(jsonFilesUnder)) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (doc && typeof doc === 'object' && Array.isArray((doc as { items?: unknown }).items)) {
      out.push([relative(REPO, file), doc]);
    }
  }
  return out;
}

/** A one-item catalog, for checking a single node. */
const withItem = (item: Record<string, unknown>) => ({ name: 't', items: [{ name: 'Probe', ...item }] });

describe('shipped catalogs', () => {
  const catalogs = shippedCatalogs();

  it('finds catalogs to check (guards against a vacuous pass)', () => {
    expect(catalogs.length).toBeGreaterThan(40);
  });

  it('carry no key the code does not read', () => {
    const problems = catalogs.flatMap(([file, doc]) =>
      validateCatalog(doc).map((d) => `${file}: ${d.message}`),
    );
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('validateCatalog', () => {
  it('names the key, the node, the path and the fix for a misspelled field', () => {
    const [d, ...rest] = validateCatalog(withItem({
      trajectory: { type: 'Keplerian', semiMajorAxis: 7000, eccentrcity: 0.01 },
    }));
    expect(rest).toEqual([]);
    expect(d.key).toBe('eccentrcity');
    expect(d.path).toBe('$.items[0].trajectory.eccentrcity');
    expect(d.node).toBe('Keplerian trajectory of "Probe"');
    expect(d.suggestion).toBe('eccentricity');
    expect(d.message).toContain('Did you mean "eccentricity"');
  });

  // The names that motivated the issue, each written in good faith and dropped.
  it.each([
    ['longitudeOfAscendingNode', { trajectory: { type: 'Keplerian', longitudeOfAscendingNode: 40 } }, 'ascendingNode'],
    ['FixedEuler axes', { rotationModel: { type: 'FixedEuler', axes: 'XYZ', angles: [1, 2, 3] } }, 'sequence'],
    ['Interpolated samples', { rotationModel: { type: 'Interpolated', samples: [] } }, 'records'],
    ['Spice trajectory frame', { trajectory: { type: 'Spice', target: 'X', frame: 'J2000' } }, 'trajectoryFrame'],
    ['Spice rotation frame', { rotationModel: { type: 'Spice', frame: 'CASSINI_SC_COORD' } }, 'bodyFrame'],
    ['Composite startEt', { trajectory: { type: 'Composite', arcs: [{ startEt: 0, trajectory: { type: 'FixedPoint' } }] } }, 'startTime'],
    ['LinearCombination terms', { trajectory: { type: 'LinearCombination', terms: [] } }, 'trajectories'],
    ['visible in trajectory', { trajectory: { type: 'Builtin', name: 'Earth', visible: false } }, 'visible'],
  ])('catches %s', (_label, item, fix) => {
    const ds = validateCatalog(withItem(item));
    expect(ds).toHaveLength(1);
    expect(ds[0].suggestion).toBe(fix);
  });

  it('points a misplaced key at the node it belongs in', () => {
    const [d] = validateCatalog(withItem({ trajectory: { type: 'Builtin', name: 'Earth', visible: false } }));
    expect(d.message).toContain('"visible" in trajectoryPlot');
  });

  it('reports a viewpoint field on a body, and a body field on a viewpoint', () => {
    expect(validateCatalog(withItem({ distance: 500 }))[0].message).toContain('in a Viewpoint');
    const vp = { name: 't', items: [{ name: 'V', type: 'Viewpoint', center: 'Earth', trajectory: { type: 'FixedPoint' } }] };
    expect(validateCatalog(vp).map((d) => d.key)).toEqual(['trajectory']);
  });

  it('checks nested geometry objects, down to terrain imagery', () => {
    const ds = validateCatalog(withItem({
      geometry: {
        type: 'Globe',
        radius: 3396,
        terrain: { type: 'imagery', imagery: [{ url: 'x', levles: 8 }] },
      },
    }));
    expect(ds.map((d) => d.path)).toEqual(['$.items[0].geometry.terrain.imagery[0].levles']);
    expect(ds[0].suggestion).toBe('levels');
  });

  it('reports an unknown trajectory or rotation type, and its nearest spelling', () => {
    const ds = validateCatalog(withItem({
      trajectory: { type: 'Keplerain' },
      rotationModel: { type: 'Uniformm' },
    }));
    expect(ds.map((d) => [d.key, d.suggestion])).toEqual([['Keplerain', 'Keplerian'], ['Uniformm', 'Uniform']]);
  });

  it('leaves custom-factory and plugin types alone', () => {
    const ds = validateCatalog(withItem({
      trajectory: { type: 'MyPropagator', anything: 1 },
      rotationModel: { type: 'MyAttitude', whatever: 2 },
      geometry: { type: 'MyPluginGeometry', foo: 3 },
    }), { trajectoryTypes: ['MyPropagator'], rotationTypes: ['MyAttitude'] });
    expect(ds).toEqual([]);
  });

  it('checks every nesting level: children, arcs, spkImport defaults', () => {
    const ds = validateCatalog({
      name: 't',
      items: [{
        name: 'Sun',
        items: [{ name: 'Child', arcs: [{ trajectory: { type: 'FixedPoint', postion: [0, 0, 0] } }] }],
      }],
      spkImport: [{ kernel: 'k.bsp', center: 'SUN', defaults: { labl: {} } }],
    });
    expect(ds.map((d) => d.path)).toEqual([
      '$.items[0].items[0].arcs[0].trajectory.postion',
      '$.spkImport[0].defaults.labl',
    ]);
  });
});

describe('CatalogLoader', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns on load, once per unknown key, naming the catalog', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new CatalogLoader().load({
      name: 'Typos',
      items: [{ name: 'Probe', trajectory: { type: 'FixedPoint', position: [1, 2, 3], positon: [0, 0, 0] } }],
    } as unknown as CatalogJson);
    const messages = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('unknown key'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('catalog "Typos"');
    expect(messages[0]).toContain('"positon"');
  });

  it('reads Keplerian period, so a center with no built-in GM still orbits', () => {
    const { bodies } = new CatalogLoader().load({
      name: 't',
      items: [{
        name: 'Moonlet',
        center: 'Didymos',
        trajectory: { type: 'Keplerian', semiMajorAxis: 1.2, eccentricity: 0, period: '11.92h' },
      }],
    });
    const body = bodies[0];
    const p0 = body.stateAt(0).position;
    const pHalf = body.stateAt(11.92 * 3600 / 2).position;
    // Half a period later the moonlet is on the far side of a 1.2 km orbit.
    expect(Math.hypot(p0[0] + pHalf[0], p0[1] + pHalf[1], p0[2] + pHalf[2])).toBeLessThan(1e-6);
    expect(Math.hypot(...p0)).toBeCloseTo(1.2, 9);
  });

  it('reads the mm and cm distance suffixes rather than treating them as km', () => {
    const { bodies } = new CatalogLoader().load({
      name: 't',
      items: [{ name: 'A', center: 'Didymos', trajectory: { type: 'Keplerian', semiMajorAxis: '120000cm', period: 1 } }],
    });
    expect(Math.hypot(...bodies[0].stateAt(0).position)).toBeCloseTo(1.2, 9);
  });
});
