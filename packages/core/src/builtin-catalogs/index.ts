/**
 * Built-in catalogs.
 *
 * These are the same JSON catalogs the cosmolabe demo viewer ships in
 * `apps/viewer/test-catalogs/base/`, exported as typed `CatalogJson` objects
 * so consumers can compose mission-specific catalogs on top of them
 * programmatically rather than fetching them at runtime.
 *
 * Catalogs that `require` sibling catalogs continue to declare that
 * dependency. When using these via `Universe.loadCatalog(...)` directly,
 * load the required catalogs in the right order yourself, or merge their
 * `items` into a single composite. When using `loadCatalogFromUrl(...)` or
 * the catalog resolver, the require chain is followed automatically.
 *
 * Texture/model paths in these catalogs (e.g. "textures/earth-5k.jpg") are
 * relative — consumers are responsible for providing the assets and
 * resolving paths via `textureResolver` / `modelResolver` on
 * `UniverseRendererOptions`.
 *
 * Maintenance: when a new base catalog is added under
 * `apps/viewer/test-catalogs/base/`, copy the JSON here and add an entry
 * below. There's no automatic glob-import for tsc-built packages.
 */
import type { CatalogJson } from '../catalog/CatalogLoader.js';

import comets from './comets.json' with { type: 'json' };
import dwarfPlanets from './dwarf-planets.json' with { type: 'json' };
import earthSystem from './earth-system.json' with { type: 'json' };
import innerPlanets from './inner-planets.json' with { type: 'json' };
import jupiter from './jupiter.json' with { type: 'json' };
import jupiterGalilean from './jupiter-galilean.json' with { type: 'json' };
import jupiterSystem from './jupiter-system.json' with { type: 'json' };
import mainBelt300 from './main-belt-300.json' with { type: 'json' };
import mainBeltNamed from './main-belt-named.json' with { type: 'json' };
import mars from './mars.json' with { type: 'json' };
import marsSatellites from './mars-satellites.json' with { type: 'json' };
import marsSystem from './mars-system.json' with { type: 'json' };
import mercury from './mercury.json' with { type: 'json' };
import naif from './naif.json' with { type: 'json' };
import nearEarthAsteroids from './near-earth-asteroids.json' with { type: 'json' };
import neptuneSystem from './neptune-system.json' with { type: 'json' };
import outerPlanets from './outer-planets.json' with { type: 'json' };
import plutoSystem from './pluto-system.json' with { type: 'json' };
import saturn from './saturn.json' with { type: 'json' };
import saturnMajorMoons from './saturn-major-moons.json' with { type: 'json' };
import saturnSystem from './saturn-system.json' with { type: 'json' };
import smallBodies from './small-bodies.json' with { type: 'json' };
import solarsys from './solarsys.json' with { type: 'json' };
import sun from './sun.json' with { type: 'json' };
import uranusSystem from './uranus-system.json' with { type: 'json' };
import venus from './venus.json' with { type: 'json' };

export const builtinCatalogs = {
  comets: comets as unknown as CatalogJson,
  dwarfPlanets: dwarfPlanets as unknown as CatalogJson,
  earthSystem: earthSystem as unknown as CatalogJson,
  innerPlanets: innerPlanets as unknown as CatalogJson,
  jupiter: jupiter as unknown as CatalogJson,
  jupiterGalilean: jupiterGalilean as unknown as CatalogJson,
  jupiterSystem: jupiterSystem as unknown as CatalogJson,
  mainBelt300: mainBelt300 as unknown as CatalogJson,
  mainBeltNamed: mainBeltNamed as unknown as CatalogJson,
  mars: mars as unknown as CatalogJson,
  marsSatellites: marsSatellites as unknown as CatalogJson,
  marsSystem: marsSystem as unknown as CatalogJson,
  mercury: mercury as unknown as CatalogJson,
  naif: naif as unknown as CatalogJson,
  nearEarthAsteroids: nearEarthAsteroids as unknown as CatalogJson,
  neptuneSystem: neptuneSystem as unknown as CatalogJson,
  outerPlanets: outerPlanets as unknown as CatalogJson,
  plutoSystem: plutoSystem as unknown as CatalogJson,
  saturn: saturn as unknown as CatalogJson,
  saturnMajorMoons: saturnMajorMoons as unknown as CatalogJson,
  saturnSystem: saturnSystem as unknown as CatalogJson,
  smallBodies: smallBodies as unknown as CatalogJson,
  solarsys: solarsys as unknown as CatalogJson,
  sun: sun as unknown as CatalogJson,
  uranusSystem: uranusSystem as unknown as CatalogJson,
  venus: venus as unknown as CatalogJson,
} as const;

export type BuiltinCatalogName = keyof typeof builtinCatalogs;
