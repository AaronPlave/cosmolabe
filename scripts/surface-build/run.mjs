import { constants } from 'node:fs';
import { plannerFeedback } from './report.mjs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm, stat, readdir, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { ROOT, assert, compileBuild, inspectBindings, jsonFile, identity } from './plan.mjs';
import { buildInventory } from '../data-hosting/lib/publish.mjs';
import { validateCubeTerrain, validateCubeImagery } from '../data-hosting/lib/cube.mjs';
import { CubeSphereGridSource } from '../../packages/three/dist/surface/CubeSphereGrids.js';
import { validateCubeImageryManifest } from '../../packages/three/dist/surface/CubeImagery.js';

const json = v => JSON.stringify(v, null, 2) + '\n';
const sameInventory = (a, b) => identity(a) === identity(b);
async function exists(p) { try { await stat(p); return true; } catch (e) { if (e.code !== 'ENOENT') throw e; return false; } }
async function command(file, args, log) {
  await new Promise((done, reject) => {
    const child = spawn(file, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', b => log(b.toString()));
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-8192); log(b.toString()); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? done() : reject(new Error(`${file} failed (exit ${code}): ${stderr.trim()}`)));
  });
}
export async function validateProduct(product, dir) {
  const entries = await buildInventory(dir);
  (product.kind === 'cube-terrain' ? validateCubeTerrain : validateCubeImagery)(entries, dir);
  return entries;
}

/** Reuse only a complete build whose entire output inventory still matches. */
export async function readCompleted(path, dag) {
  if (!await exists(join(path, 'complete.json'))) return null;
  const receipt = await jsonFile(join(path, 'complete.json'));
  assert(receipt.buildId === dag.buildId && receipt.lockIdentity === dag.lockIdentity, 'completed build identity mismatch');
  const actual = (await buildInventory(path)).filter(e => e.path !== 'complete.json');
  assert(sameInventory(receipt.inventory, actual), 'completed build cache content changed; refusing unsafe resume');
  return receipt;
}

/** Product reuse is limited to byte-verified completed builds in this cache. */
async function matchingProducts(cache, dag) {
  const matched = {};
  let names;
  try { names = await readdir(cache); } catch (e) { if (e.code === 'ENOENT') return matched; throw e; }
  for (const name of names.filter(n => /^[a-f0-9]{64}$/.test(n)).sort()) {
    const directory = join(resolve(cache), name);
    const prior = await jsonFile(join(directory, 'complete.json'));
    const wanted = dag.products.filter(p => !matched[p.id] && prior.report.products.some(x => x.productIdentity === p.productIdentity));
    if (!wanted.length) continue;
    // Validate full completion, including original audit, before trusting reuse.
    await readCompleted(directory, { buildId: name, lockIdentity: prior.lockIdentity });
    for (const p of wanted) matched[p.id] = { directory: join(directory, p.id), buildId: name,
      audit: prior.report.resources.actual.sourceAudit };
    if (Object.keys(matched).length === dag.products.length) break;
  }
  return matched;
}

/** No remote writes. A failed build never receives a completion receipt. */
export async function executeBuild(lock, { bindings = {}, bindingsDir = ROOT, cache, python = 'python3', workers = 1, log = () => {} }) {
  assert(cache, '--cache is required for execution');
  assert(Number.isInteger(workers) && workers >= 1 && workers <= 8, '--workers must be 1..8');
  const executionStarted = performance.now();
  const dag = await compileBuild(lock);
  const sources = await inspectBindings(lock, bindings, bindingsDir);
  assert(sources.every(s => s.state === 'verified'), 'missing or changed source files; run dry-run and supply verified bindings');
  const target = join(resolve(cache), dag.buildId);
  const completed = await readCompleted(target, dag);
  if (completed) return { ...completed.report, reused: true, directory: target };
  // mkdir, without recursive, is also the per-build lock. Interrupted work is
  // retained for diagnosis; it cannot be mistaken for a content-valid cache.
  await mkdir(resolve(cache), { recursive: true });
  const reservation = target + '.building';
  await mkdir(reservation);
  const started = executionStarted;
  const reusedProducts = await matchingProducts(cache, dag);
  const jobPath = join(reservation, 'job.json'), work = join(reservation, 'output');
  await writeFile(jobPath, json({ lock, dag, reusedProducts, paths: Object.fromEntries(sources.map(s => [s.sourceId, s.path])) }));
  try {
    await command(python, [join(ROOT, 'scripts/surface-build/worker.py'), '--job', jobPath, '--out', work, '--workers', String(workers)], log);
    for (const [id, previous] of Object.entries(reusedProducts))
      await cp(previous.directory, join(work, id), { recursive: true, mode: constants.COPYFILE_FICLONE });
    const products = [];
    const terrainValidation = [];
    for (const product of dag.products) {
      const dir = join(work, product.id);
      const productInventory = await validateProduct(product, dir);
      const measured = { objects: productInventory.length, bytes: productInventory.reduce((n, e) => n + e.size, 0),
        reusedFromBuild: reusedProducts[product.id]?.buildId ?? null };
      if (product.kind === 'cube-terrain') {
        const diagnostics = join(work, 'diagnostics', product.id);
        await command(process.execPath, [join(ROOT, 'scripts/validate-cube-terrain.mjs'), '--dir', dir, '--out', diagnostics,
          '--clearance-m', String(lock.processing.parameters.gates.clearanceM),
          '--site', `${lock.processing.parameters.gates.controls[0].lat},${lock.processing.parameters.gates.controls[0].lon}`], log);
        const validation = await jsonFile(join(diagnostics, 'validation.json'));
        terrainValidation.push({ productId: product.id, ...validation });
        assert(validation.failures.length === 0, 'terrain numerical validation failed');
        const grids = await jsonFile(join(dir, 'cpu-grids.json'));
        const source = new CubeSphereGridSource(grids, async uri => {
          const b = await readFile(join(dir, uri)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        }, { residentLevel: 0, maxDetailTiles: 100000 });
        await source.ready;
        const controls = [];
        for (const cp of lock.processing.parameters.gates.controls) {
          await source.request(cp.lat, cp.lon);
          const sample = source.sample(cp.lat, cp.lon);
          assert(sample, 'no CPU surface at locked control');
          const errorM = sample.elevationKm * 1000 - cp.heightM;
          assert(Math.abs(errorM) <= cp.toleranceM, `terrain control registration failed: ${errorM} m at ${cp.lat},${cp.lon}`);
          controls.push({ ...cp, errorM });
        }
        await writeFile(join(diagnostics, 'controls.json'), json(controls));
        products.push({ ...product, ...measured, revision: grids.source.version, availability: grids.tiles.map(t => t.slice(0, 4)),
          maxLevel: grids.maxLevel, controls, datum: grids.datum });
      } else {
        const m = validateCubeImageryManifest(await jsonFile(join(dir, 'imagery.json')));
        let validPixels = 0, transparentPixels = 0;
        for (const tile of m.tiles) {
          const file = join(dir, 'tiles', tile + '.png');
          const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          assert(info.width === m.tileSize + 2 * m.gutter && info.height === info.width, 'imagery tile dimensions do not match registration');
          for (let y = m.gutter; y < m.gutter + m.tileSize; y++) for (let x = m.gutter; x < m.gutter + m.tileSize; x++) {
            if (data[(y * info.width + x) * 4 + 3]) validPixels++; else transparentPixels++;
          }
        }
        assert(validPixels > 0, 'imagery product contains no valid pixels');
        products.push({ ...product, ...measured, revision: m.source.version, availability: m.tiles, maxLevel: m.maxLevel,
          validPixels, transparentPixels, sourceFallbacks: m.sourceFallbacks,
          registration: m.registration, illumination: lock.sources.find(s => s.id === product.sourceIds[0]).metadata?.illumination ?? null });
      }
    }
    const audit = await jsonFile(join(work, 'source-audit.json'));
    const inventory = await buildInventory(work);
    const output = inventory.filter(e => dag.products.some(p => e.path.startsWith(p.id + '/')));
    for (const product of products) {
      const radiusM = lock.desired.coordinates.referenceShape.radiusKm * 1000;
      product.outputSpacingMByLevel = Array.from({ length: product.maxLevel + 1 }, (_, L) => 2 * radiusM / ((product.kind === 'cube-terrain' ? 64 : lock.output.tileSize) * 2 ** L));
      product.nativeFidelity = product.sourceIds.map(id => {
        const s = lock.sources.find(s => s.id === id);
        return { sourceId: id, nativeGsdM: s.nativeGsdM, accuracyM: s.accuracyM };
      });
    }
    const report = { version: 2, kind: 'surface-build-report', buildId: dag.buildId, lockIdentity: lock.identity,
      validation: 'passed-supported-gates', productionReady: false,
      limitation: lock.processing.parameters.profile === 'bounded-real-mars'
        ? 'Bounded real Mars source pilot passed supported local gates. Absolute source geolocation/accuracy remain unknown. Publication requires a separately verified receipt; no mission placement is changed.'
        : 'Bounded synthetic/controlled fixture execution only; no production promotion.',
      sources: lock.sources.map(s => ({ id: s.id, productId: s.productId, asset: s.asset, license: s.license,
        nativeGsdM: s.nativeGsdM, accuracyM: s.accuracyM, footprint: s.footprint, metadata: s.metadata ?? null })),
      requested: lock.desired.regions, selections: lock.selections,
      products, caveats: [...dag.caveats, 'Tile availability is emitted separately from upstream footprints; valid pixel counts do not prove a continuous native-resolution footprint.',
        'Concurrent worker RSS and scratch usage are sampled; summed RSS can count shared pages repeatedly and is not physical peak RAM.'],
      resources: { planned: dag.resources, actual: { outputBytes: output.reduce((n, e) => n + e.size, 0), publishedBytes: null, objects: output.length,
        workDiskBytesAtCompletion: inventory.reduce((n, e) => n + e.size, 0), peakDiskBytes: null, sampledPeakScratchBytes: audit.sampledResources?.peakScratchBytes ?? null,
        peakConcurrentWorkerRssBytes: audit.sampledResources?.peakConcurrentRssBytes ?? null,
        elapsedSeconds: (performance.now() - started) / 1000, sourceAudit: audit } }, reused: false };
    report.plannerFeedback = plannerFeedback(lock, products, audit, report.resources, sources, terrainValidation);
    await writeFile(join(work, 'planner-feedback.json'), json(report.plannerFeedback));
    await writeFile(join(work, 'lock.json'), json(lock));
    await writeFile(join(work, 'dag.json'), json(dag));
    await writeFile(join(work, 'report.json'), json(report));
    const finalInventory = await buildInventory(work);
    await writeFile(join(work, 'complete.json'), json({ version: 1, buildId: dag.buildId, lockIdentity: lock.identity, inventory: finalInventory, report }));
    await rename(work, target);
    await rm(reservation, { recursive: true });
    return { ...report, directory: target };
  } catch (e) {
    // An incomplete reservation has no publishable completion receipt. Keep the
    // logs/artifacts; restarting requires the author to choose a clean cache.
    throw new Error(`${e.message}; incomplete work retained at ${reservation}`);
  }
}

/** Backwards-compatible local entry point over the complete publication path. */
export async function publishLocalFixture(lock, options) {
  const { publishBuild } = await import('./publication.mjs');
  assert(options.localDir, 'local publication requires --local-dir');
  return publishBuild(lock, options);
}
