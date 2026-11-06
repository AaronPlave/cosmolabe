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
  it('recognizes the parsed surface plot frame, sampling and timeline settings', () => {
    expect(validateCatalog(withItem({ trajectoryPlot: {
      frame: 'BodyFixed', sampleInterval: '0.05s', timelineLabel: 'Flight',
    } }))).toEqual([]);
  });
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

  // A catalog `type` is arbitrary text; a plain table lookup of these finds
  // Object.prototype's members, which used to crash the check.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'reports, rather than crashes on, a %s type on every node kind',
    (type) => {
      const ds = validateCatalog({
        name: 't',
        items: [{
          name: 'Probe',
          trajectory: JSON.parse(`{"type": ${JSON.stringify(type)}}`),
          rotationModel: JSON.parse(`{"type": ${JSON.stringify(type)}}`),
          geometry: JSON.parse(`{"type": ${JSON.stringify(type)}}`),
        }],
      });
      expect(ds.map((d) => d.path)).toEqual(['$.items[0].trajectory.type', '$.items[0].rotationModel.type']);
    },
  );

  it('does not take a prototype member for a known alias', () => {
    const [d] = validateCatalog(withItem({ trajectory: { type: 'Keplerian', constructor: 1 } }));
    expect(d.key).toBe('constructor');
    expect(d.suggestion).toBeUndefined();
  });

  it('checks inline state and orientation records, once per key', () => {
    const ds = validateCatalog(withItem({
      trajectory: {
        type: 'InterpolatedStates',
        samples: [
          { et: 0, positon: [1, 0, 0], velocity: [0, 1, 0] },
          { et: 60, positon: [1, 0, 0], velocity: [0, 1, 0] },
        ],
      },
      rotationModel: { type: 'Interpolated', records: [{ et: 0, quat: [1, 0, 0, 0] }] },
    }));
    expect(ds.map((d) => [d.path, d.suggestion])).toEqual([
      ['$.items[0].trajectory.samples[0].positon', 'position'],
      ['$.items[0].rotationModel.records[0].quat', undefined],
    ]);
  });

  it('checks the object form of spiceKernels, at the catalog and on items', () => {
    const ds = validateCatalog({
      name: 't',
      spiceKernels: ['naif0012.tls', { url: 'de440s.bsp', lable: 'DE440s' }],
      items: [{ name: 'Probe', spiceKernels: [{ url: 'p.bsp', sise: 10 }] }],
    });
    expect(ds.map((d) => [d.path, d.suggestion])).toEqual([
      ['$.spiceKernels[1].lable', 'label'],
      ['$.items[0].spiceKernels[0].sise', 'size'],
    ]);
  });

  it('accepts semantic viewpoints and checks their direction objects by kind', () => {
    const ok = {
      name: 't',
      items: [
        { name: 'Beyond', type: 'Viewpoint', center: 'Cassini', lookAt: 'Saturn', distance: 50,
          from: { kind: 'toward', body: 'Saturn', negate: true }, up: { kind: 'axis', axis: '+z', frame: 'ECLIPJ2000' } },
        { name: 'Behind', type: 'Viewpoint', center: 'Cassini', distance: 50, epoch: 1e8,
          from: { kind: 'velocity', negate: true, relativeTo: 'Saturn' }, up: [0, 0, 1] },
      ],
    };
    expect(validateCatalog(ok)).toEqual([]);
    const typo = {
      name: 't',
      items: [{ name: 'V', type: 'Viewpoint', center: 'Cassini', distance: 50,
        from: { kind: 'velocity', relativTo: 'Saturn' }, up: { kind: 'toward', body: 'Sun', negat: true } }],
    };
    expect(validateCatalog(typo).map((d) => [d.path, d.suggestion])).toEqual([
      ['$.items[0].from.relativTo', 'relativeTo'],
      ['$.items[0].up.negat', 'negate'],
    ]);
  });

  it('reports a geometry type a letter or two from a built-in one, unless a plugin claims it', () => {
    const catalog = withItem({ geometry: { type: 'Globee', radius: 1 } });
    const [d, ...rest] = validateCatalog(catalog);
    expect(rest).toEqual([]);
    expect([d.key, d.suggestion]).toEqual(['Globee', 'Globe']);
    expect(validateCatalog(catalog, { geometryTypes: ['Globee'] })).toEqual([]);
    // A plugin type nowhere near a built-in one is left alone.
    expect(validateCatalog(withItem({ geometry: { type: 'PlumeCloud', density: 3 } }))).toEqual([]);
  });

  // Without a type the loader falls back silently (a body fixed at its
  // parent's origin, no orientation, a placeholder), and none of the node's
  // other fields can be checked, so the missing type itself is reported.
  it.each([
    ['trajectory', { trajectory: { tyep: 'Keplerian', semiMajorAxis: 7000 } }],
    ['rotationModel', { rotationModel: { tpye: 'Uniform', period: 1 } }],
    ['geometry', { geometry: { Type: 'Globe', radius: 1 } }],
  ])('reports a misspelled type on %s, naming the misspelling', (node, item) => {
    const ds = validateCatalog(withItem(item));
    expect(ds).toHaveLength(1);
    const misspelled = Object.keys((item as Record<string, Record<string, unknown>>)[node])[0];
    expect(ds[0].path).toBe(`$.items[0].${node}.${misspelled}`);
    expect([ds[0].key, ds[0].suggestion]).toEqual([misspelled, 'type']);
    expect(ds[0].message).toContain('Did you mean "type"');
  });

  it.each([
    ['trajectory', { trajectory: { semiMajorAxis: 7000 } }],
    ['rotationModel', { rotationModel: { period: 1 } }],
    ['geometry', { geometry: { radius: 1 } }],
  ])('reports a missing type on %s', (node, item) => {
    const ds = validateCatalog(withItem(item));
    expect(ds.map((d) => [d.path, d.key, d.suggestion])).toEqual([[`$.items[0].${node}.type`, 'type', undefined]]);
    expect(ds[0].message).toContain('has no "type"');
  });

  it.each(['trajectory', 'rotationModel', 'geometry'])('reports a non-string type on %s', (node) => {
    const ds = validateCatalog(withItem({ [node]: { type: 42 } }));
    expect(ds.map((d) => [d.path, d.key])).toEqual([[`$.items[0].${node}.type`, 'type']]);
    expect(ds[0].message).toContain('must be a string');
  });

  it('reports a TimeSwitched entry geometry type it cannot draw, with the nearest one', () => {
    const ds = validateCatalog(withItem({
      geometry: {
        type: 'TimeSwitched',
        sequence: [
          { geometry: { type: 'Mehs', source: 'a.glb' } },
          { geometry: { type: 'Globe', radius: 1 } },
          { geometry: { source: 'c.glb' } },
          { geometry: { type: 'dsk', source: 'd.bds' } },
        ],
      },
    }));
    expect(ds.map((d) => [d.path, d.key, d.suggestion])).toEqual([
      ['$.items[0].geometry.sequence[0].geometry.type', 'Mehs', 'Mesh'],
      ['$.items[0].geometry.sequence[1].geometry.type', 'Globe', undefined],
      ['$.items[0].geometry.sequence[2].geometry.type', 'type', undefined],
    ]);
  });

  it('accepts Cosmographia\'s "DSK" spelling, and checks TimeSwitched entries', () => {
    expect(validateCatalog(withItem({ geometry: { type: 'DSK', kernel: 'shape.bds', color: [1, 1, 1] } }))).toEqual([]);
    const ds = validateCatalog(withItem({
      geometry: {
        type: 'TimeSwitched',
        sequence: [
          { endTime: '2014-01-01T00:00:00Z', geometry: { type: 'Mesh', source: 'a.glb', bumpMapType: 'normal' } },
          { startTime: '2014-01-01T00:00:00Z', geometry: { type: 'Dsk', source: 'b.bds', colour: [1, 0, 0] } },
          { strtTime: '2015-01-01T00:00:00Z', geometry: { type: 'Mesh', source: 'c.glb' } },
        ],
      },
    }));
    expect(ds.map((d) => [d.path, d.suggestion])).toEqual([
      ['$.items[0].geometry.sequence[1].geometry.colour', 'color'],
      ['$.items[0].geometry.sequence[2].strtTime', 'startTime'],
    ]);
  });

  it('checks geographic layers, but not their free-form provenance', () => {
    const ds = validateCatalog({
      name: 't',
      geographicCoordinates: { latitude: 'planetocentric', referenceShape: { kind: 'sphere', radiusKm: 3396 } },
      geographicLayers: [{
        id: 'craters', body: 'Mars', source: 'craters.geojson',
        display: { visible: true, colour: '#fff' },
        coordinates: { height: { unit: 'm', datm: 'areoid' } },
        provenance: { anything: 'goes', here: 1 },
      }],
      items: [],
    });
    expect(ds.map((d) => [d.path, d.suggestion])).toEqual([
      ['$.geographicLayers[0].coordinates.height.datm', 'datum'],
      ['$.geographicLayers[0].display.colour', 'color'],
    ]);
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

  it('states a Uniform, Fixed or FixedEuler rotation in the item-level bodyFrame', () => {
    const { bodies } = new CatalogLoader().load({
      name: 't',
      items: [
        { name: 'U', bodyFrame: 'EclipticJ2000', rotationModel: { type: 'Uniform', period: 1 } },
        { name: 'F', bodyFrame: 'EclipticJ2000', rotationModel: { type: 'Fixed', quaternion: [1, 0, 0, 0] } },
        { name: 'E', bodyFrame: 'EclipticJ2000', rotationModel: { type: 'FixedEuler', sequence: 'Z', angles: [0] } },
        // The rotation's own inertialFrame still wins, and without either the default stands.
        { name: 'Own', bodyFrame: 'EclipticJ2000', rotationModel: { type: 'Fixed', quaternion: [1, 0, 0, 0], inertialFrame: 'ICRF' } },
        { name: 'None', rotationModel: { type: 'Fixed', quaternion: [1, 0, 0, 0] } },
      ],
    } as unknown as CatalogJson);
    expect(bodies.map((b) => b.rotation?.sourceFrame)).toEqual([
      'EclipticJ2000', 'EclipticJ2000', 'EclipticJ2000', 'ICRF', 'EquatorJ2000',
    ]);
  });

  it('ends the last arc at the item-level endTime', () => {
    const loader = new CatalogLoader();
    const { bodies } = loader.load({
      name: 't',
      items: [{
        name: 'Probe',
        endTime: '2030-01-01T00:00:00Z',
        arcs: [
          { startTime: '2029-01-01T00:00:00Z', trajectory: { type: 'FixedPoint', position: [1, 0, 0] } },
          { startTime: '2029-06-01T00:00:00Z', trajectory: { type: 'FixedPoint', position: [2, 0, 0] } },
        ],
      }],
    });
    const end = loader.parseEpochValue('2030-01-01T00:00:00Z');
    const start = loader.parseEpochValue('2029-01-01T00:00:00Z');
    // Before this, the last arc ran a fixed 365.25 days from its own start.
    expect(bodies[0].trajectory.endTime).toBeCloseTo(end, 3);
    expect(bodies[0].trajectory.startTime).toBeCloseTo(start, 3);
  });

  it('reads the mm and cm distance suffixes rather than treating them as km', () => {
    const { bodies } = new CatalogLoader().load({
      name: 't',
      items: [{ name: 'A', center: 'Didymos', trajectory: { type: 'Keplerian', semiMajorAxis: '120000cm', period: 1 } }],
    });
    expect(Math.hypot(...bodies[0].stateAt(0).position)).toBeCloseTo(1.2, 9);
  });
});
