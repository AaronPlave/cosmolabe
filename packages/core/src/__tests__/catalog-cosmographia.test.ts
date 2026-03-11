import { describe, it, expect } from 'vitest';
import { CatalogLoader } from '../catalog/CatalogLoader.js';
import type { CatalogJson } from '../catalog/CatalogLoader.js';

// Real Cosmographia catalog structures (simplified from actual files)

const EARTH_CATALOG: CatalogJson = {
  version: '1.0',
  name: 'Earth',
  items: [
    {
      name: 'Earth',
      label: { color: [0.7, 0.8, 1] },
      mass: '1 Mearth',
      center: 'Sun',
      trajectory: { type: 'Builtin', name: 'Earth' },
      bodyFrame: 'EquatorJ2000',
      rotationModel: {
        type: 'Uniform',
        period: 0.997269632262793,
        inclination: 0.0,
        ascendingNode: 0.0,
        meridianAngle: 280.147,
      },
      geometry: {
        type: 'Globe',
        radius: 6378.1,
      },
    },
    {
      name: 'Moon',
      label: { color: [0.5, 0.5, 0.5] },
      mass: '0.012296 Mearth',
      center: 'Earth',
      trajectory: { type: 'Builtin', name: 'Moon' },
      rotationModel: { type: 'Builtin', name: 'IAU Moon' },
      geometry: {
        type: 'Globe',
        radius: 1737.1,
      },
    },
  ],
};

const CASSINI_CATALOG: CatalogJson = {
  version: '1.0',
  name: 'Cassini Mission',
  items: [
    {
      name: 'Cassini',
      class: 'spacecraft',
      startTime: '1997-10-15 09:27:00',
      arcs: [
        {
          center: 'Sun',
          trajectoryFrame: 'EclipticJ2000',
          trajectory: { type: 'InterpolatedStates', source: 'trajectories/cassini-cruise.xyzv' },
          endTime: 2453177.0424, // Julian Date
        },
        {
          center: 'Saturn',
          trajectoryFrame: 'EclipticJ2000',
          trajectory: { type: 'InterpolatedStates', source: 'trajectories/cassini-orbit.xyzv' },
          endTime: 2455387.0,
        },
        {
          center: 'Saturn',
          trajectoryFrame: 'EclipticJ2000',
          trajectory: { type: 'InterpolatedStates', source: 'trajectories/cassini-solstice.xyzv' },
          endTime: 2458018.0,
        },
      ],
      geometry: { type: 'Mesh', size: 0.005, source: 'models/cassini.cmod' },
      label: { color: '#d0d0d0' },
    },
    {
      name: 'Huygens',
      startTime: '1997-10-15 09:27:00',
      arcs: [
        {
          center: 'Cassini',
          trajectory: { type: 'FixedPoint', position: [0.001, 0, -0.00068] },
          endTime: '2004-12-25 02:01:05.183',
        },
      ],
      geometry: { type: 'Mesh', size: 0.001, source: 'models/huygens.cmod' },
    },
  ],
};

const COMET_CATALOG: CatalogJson = {
  version: '1.0',
  items: [
    {
      name: 'C/2023 A3 Tsuchinshan-ATLAS',
      class: 'comet',
      label: { color: '#ffff00' },
      mass: '1000000000000 kg',
      center: 'Sun',
      trajectory: { type: 'Spice', target: '1003913', center: 'SUN' },
      geometry: {
        type: 'Globe',
        radii: [100000.0, 100000.0, 100000.0],
      },
    },
    {
      name: 'C/2023 A3 Tsuchinshan-ATLAS dust tail',
      startTime: '2024-08-01T00:00:00 UTC',
      endTime: '2024-12-01T00:00:00 UTC',
      center: 'C/2023 A3 Tsuchinshan-ATLAS',
      geometry: { type: 'ParticleSystem' },
    },
  ],
};

const SOLARSYS_CATALOG: CatalogJson = {
  version: '1.0',
  name: 'Solar System',
  require: ['earth.json', 'mars.json', 'jupiter.json'],
};

describe('CatalogLoader — real Cosmographia patterns', () => {
  describe('earth.json pattern', () => {
    it('loads Earth and Moon with correct metadata', () => {
      const loader = new CatalogLoader(); // No SPICE
      const result = loader.load(EARTH_CATALOG);

      expect(result.bodies.length).toBe(2);
      expect(result.name).toBe('Earth');
      expect(result.version).toBe('1.0');

      const earth = result.bodies.find(b => b.name === 'Earth')!;
      expect(earth.parentName).toBe('Sun');
      expect(earth.geometryType).toBe('Globe');
      expect(earth.radii).toEqual([6378.1, 6378.1, 6378.1]);
      expect(earth.labelColor).toEqual([0.7, 0.8, 1]);
      expect(earth.rotation).toBeDefined();

      const moon = result.bodies.find(b => b.name === 'Moon')!;
      expect(moon.parentName).toBe('Earth');
      expect(moon.radii).toEqual([1737.1, 1737.1, 1737.1]);
      expect(moon.labelColor).toEqual([0.5, 0.5, 0.5]);
    });

    it('parses mass with Mearth unit', () => {
      const loader = new CatalogLoader();
      const result = loader.load(EARTH_CATALOG);

      const earth = result.bodies.find(b => b.name === 'Earth')!;
      expect(earth.mass).toBeCloseTo(5.972e24, 20); // 1 Mearth

      const moon = result.bodies.find(b => b.name === 'Moon')!;
      expect(moon.mass).toBeCloseTo(0.012296 * 5.972e24, 17); // 0.012296 Mearth
    });

    it('converts Uniform rotation period from days to seconds', () => {
      const loader = new CatalogLoader();
      const result = loader.load(EARTH_CATALOG);
      const earth = result.bodies.find(b => b.name === 'Earth')!;

      // Rotation should be defined and produce valid quaternions
      expect(earth.rotation).toBeDefined();
      const q0 = earth.rotationAt(0);
      expect(q0).toBeDefined();

      // Rotation at different times should differ
      const q1 = earth.rotationAt(43200); // 12 hours later
      expect(q1).toBeDefined();
      // Quaternions should not be identical (Earth rotates ~180° in 12h)
      const same = q0![0] === q1![0] && q0![1] === q1![1] && q0![2] === q1![2] && q0![3] === q1![3];
      expect(same).toBe(false);
    });

    it('extracts geometry radius as sphere radii', () => {
      const loader = new CatalogLoader();
      const result = loader.load(EARTH_CATALOG);
      const earth = result.bodies.find(b => b.name === 'Earth')!;
      // geometry.radius (scalar) → [r, r, r]
      expect(earth.radii).toEqual([6378.1, 6378.1, 6378.1]);
    });
  });

  describe('cassini.json pattern (arcs)', () => {
    it('loads Cassini with composite trajectory from arcs', () => {
      const loader = new CatalogLoader();
      const result = loader.load(CASSINI_CATALOG);

      expect(result.bodies.length).toBe(2);

      const cassini = result.bodies.find(b => b.name === 'Cassini')!;
      expect(cassini.classification).toBe('spacecraft');
      expect(cassini.trajectory).toBeDefined();
      // Cassini should have a trajectory (CompositeTrajectory with 3 arcs)
      const state = cassini.stateAt(0);
      expect(state).toBeDefined();
      expect(state.position).toHaveLength(3);
    });

    it('loads Huygens with single-arc trajectory', () => {
      const loader = new CatalogLoader();
      const result = loader.load(CASSINI_CATALOG);

      const huygens = result.bodies.find(b => b.name === 'Huygens')!;
      expect(huygens).toBeDefined();
      // Single arc → FixedPoint at [0.001, 0, -0.00068]
      const state = huygens.stateAt(0);
      expect(state.position[0]).toBeCloseTo(0.001);
      expect(state.position[2]).toBeCloseTo(-0.00068);
    });

    it('parses hex label color', () => {
      const loader = new CatalogLoader();
      const result = loader.load(CASSINI_CATALOG);
      const cassini = result.bodies.find(b => b.name === 'Cassini')!;
      // #d0d0d0 → [208/255, 208/255, 208/255]
      expect(cassini.labelColor![0]).toBeCloseTo(208 / 255, 2);
      expect(cassini.labelColor![1]).toBeCloseTo(208 / 255, 2);
      expect(cassini.labelColor![2]).toBeCloseTo(208 / 255, 2);
    });

    it('stores geometry data for Mesh type', () => {
      const loader = new CatalogLoader();
      const result = loader.load(CASSINI_CATALOG);
      const cassini = result.bodies.find(b => b.name === 'Cassini')!;
      expect(cassini.geometryType).toBe('Mesh');
      expect(cassini.geometryData?.source).toBe('models/cassini.cmod');
      expect(cassini.geometryData?.size).toBe(0.005);
    });
  });

  describe('comet catalog pattern', () => {
    it('loads comet without SPICE (throws for Spice trajectory)', () => {
      const loader = new CatalogLoader(); // No SPICE
      // Spice trajectory requires SPICE instance
      expect(() => loader.load(COMET_CATALOG)).toThrow(/requires SPICE/);
    });

    it('parses mass in kg', () => {
      // Test mass parsing directly via a non-Spice catalog
      const loader = new CatalogLoader();
      const result = loader.load({
        items: [{
          name: 'TestComet',
          mass: '1000000000000 kg',
          trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        }],
      });
      expect(result.bodies[0].mass).toBe(1e12);
    });

    it('parses hex color #ffff00', () => {
      const loader = new CatalogLoader();
      const result = loader.load({
        items: [{
          name: 'Test',
          label: { color: '#ffff00' },
          trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        }],
      });
      expect(result.bodies[0].labelColor).toEqual([1, 1, 0]);
    });

    it('extracts geometry.radii array', () => {
      const loader = new CatalogLoader();
      const result = loader.load({
        items: [{
          name: 'Test',
          geometry: { type: 'Globe', radii: [100, 100, 100] },
          trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        }],
      });
      expect(result.bodies[0].radii).toEqual([100, 100, 100]);
    });
  });

  describe('solarsys.json pattern (require, no items)', () => {
    it('returns empty bodies with require list', () => {
      const loader = new CatalogLoader();
      const result = loader.load(SOLARSYS_CATALOG);

      expect(result.bodies.length).toBe(0);
      expect(result.require).toEqual(['earth.json', 'mars.json', 'jupiter.json']);
      expect(result.name).toBe('Solar System');
    });
  });

  describe('epoch parsing', () => {
    it('converts Julian Date to ET', () => {
      const loader = new CatalogLoader();
      // JD 2451545.0 = J2000.0 epoch = ET 0
      expect(loader.parseEpochValue(2451545.0)).toBeCloseTo(0, 0);
      // JD 2451546.0 = J2000.0 + 1 day = ET 86400
      expect(loader.parseEpochValue(2451546.0)).toBeCloseTo(86400, 0);
    });

    it('parses ISO date string to ET', () => {
      const loader = new CatalogLoader();
      // J2000.0 epoch: 2000-01-01T12:00:00Z (must include Z for UTC)
      const et = loader.parseEpochValue('2000-01-01T12:00:00Z');
      expect(et).toBeCloseTo(0, -1); // Within ~10s (no leap seconds without SPICE)
    });
  });

  describe('Universe integration', () => {
    it('loads catalog through Universe and resolves parent-child', async () => {
      const { Universe } = await import('../Universe.js');
      const universe = new Universe();
      universe.loadCatalog(EARTH_CATALOG);

      const earth = universe.getBody('Earth');
      const moon = universe.getBody('Moon');
      expect(earth).toBeDefined();
      expect(moon).toBeDefined();
      expect(earth!.children).toContain(moon);
      expect(moon!.parentName).toBe('Earth');
    });

    it('loads multiple catalogs sequentially', async () => {
      const { Universe } = await import('../Universe.js');
      const universe = new Universe();

      // Load earth catalog first
      universe.loadCatalog(EARTH_CATALOG);
      expect(universe.getAllBodies().length).toBe(2);

      // Load Cassini catalog (Cassini's center is Sun, which isn't in the catalog but that's OK)
      universe.loadCatalog(CASSINI_CATALOG);
      expect(universe.getAllBodies().length).toBe(4);

      const cassini = universe.getBody('Cassini');
      expect(cassini).toBeDefined();
    });

    it('queries body states at different times', async () => {
      const { Universe } = await import('../Universe.js');
      const universe = new Universe();
      universe.loadCatalog(EARTH_CATALOG);

      // Without SPICE, Builtin falls back to FixedPoint [0,0,0]
      // But the API contract still works
      const earth = universe.getBody('Earth')!;
      const state0 = earth.stateAt(0);
      const state1 = earth.stateAt(86400);
      expect(state0.position).toHaveLength(3);
      expect(state1.position).toHaveLength(3);
    });
  });
});
