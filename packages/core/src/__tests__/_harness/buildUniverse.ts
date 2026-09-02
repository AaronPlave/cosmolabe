/**
 * Headless scene builder for the regression harness. Replicates what the
 * viewer's `initScene` (apps/viewer/src/lib/loader.ts) does to turn a catalog
 * into a time-set Universe — minus all the Three.js / rendering plumbing — so
 * tests can assert on the same numeric state the renderer consumes
 * (`absolutePositionOf`, `rotationAt`, `subPointOf`).
 */
import { Spice, type SpiceInstance } from '@cosmolabe/spice';
import { createHeritageSpice } from '@cosmolabe/frames';
import { Universe } from '../../Universe.js';
import type { CatalogJson } from '../../catalog/CatalogLoader.js';
import { furnishKernels, SPICE_TEST_KERNELS } from './kernels.js';

/** Which CSPICE build backs the scene.
 *
 *  'timecraftjs'  — the incumbent (packages/spice, CSPICE via TimeCraftJS).
 *  'cspice-wasm'  — the harvested engine, reached through @cosmolabe/frames'
 *                   heritage adapter, which implements the same SpiceInstance
 *                   surface (see packages/frames/src/differential.test.ts).
 *
 *  Set COSMOLABE_SPICE_ENGINE=cspice-wasm to run the whole suite — goldens,
 *  oracle, invariants — through the new engine without editing any test. That
 *  is the pipeline-mode check: call parity is already proven, and this is what
 *  proves parity *through* the core's own frame composition and accumulation. */
export type SpiceEngine = 'timecraftjs' | 'cspice-wasm';

export const DEFAULT_SPICE_ENGINE: SpiceEngine =
  (process.env.COSMOLABE_SPICE_ENGINE as SpiceEngine | undefined) ?? 'timecraftjs';

async function initEngine(engine: SpiceEngine): Promise<SpiceInstance> {
  return engine === 'cspice-wasm' ? await createHeritageSpice() : await Spice.init();
}

export interface BuiltScene {
  universe: Universe;
  /** undefined for SPICE-free (analytical) scenes. */
  spice: SpiceInstance | undefined;
  /** Which CSPICE build produced this scene's numbers. */
  engine: SpiceEngine | undefined;
  /** Ephemeris time (s past J2000 TDB) the universe is set to. */
  et: number;
  bodyNames: string[];
}

export interface BuildOptions {
  catalog: CatalogJson;
  /** Kernel paths relative to `kernelRoot`. Empty/omitted ⇒ SPICE-free scene. */
  kernels?: string[];
  kernelRoot?: string;
  /** UTC ISO time; resolved via SPICE str2et when kernels are present, else via J2000 epoch math. */
  defaultTime: string;
  /** CSPICE build to use. Defaults to DEFAULT_SPICE_ENGINE (env-selectable). */
  engine?: SpiceEngine;
}

const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/** Build a Universe from a catalog + (optional) kernels and set it to `defaultTime`. */
export async function buildUniverseFromCatalog(opts: BuildOptions): Promise<BuiltScene> {
  let spice: SpiceInstance | undefined;
  let et: number;
  const engine = opts.engine ?? DEFAULT_SPICE_ENGINE;

  if (opts.kernels && opts.kernels.length > 0) {
    spice = await initEngine(engine);
    await furnishKernels(spice, opts.kernels, opts.kernelRoot ?? SPICE_TEST_KERNELS);
    et = spice.str2et(opts.defaultTime);
  } else {
    // SPICE-free path mirrors loader.ts's fallback when no LSK is loaded.
    et = (new Date(opts.defaultTime).getTime() - J2000_MS) / 1000;
  }

  const universe = new Universe(spice);
  universe.loadCatalog(opts.catalog);
  universe.setTime(et);

  return {
    universe,
    spice,
    engine: spice ? engine : undefined,
    et,
    bodyNames: universe.getAllBodies().map((b) => b.name),
  };
}
