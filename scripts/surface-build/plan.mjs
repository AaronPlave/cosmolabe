// The CLI execution contract is deliberately smaller than the planner contract.
// No source discovery, URL fetch, shell text, credentials or renderer is used here.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLockedSurfacePlan, estimateSurfacePlan, serializeSurfacePlan } from '../../packages/core/dist/surface-plan/index.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const GENERATOR = { name: 'cosmolabe-surface-build', version: '1' };
export const digest = data => createHash('sha256').update(data).digest('hex');
export const identity = value => digest(serializeSurfacePlan(value));
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function jsonFile(path) {
  if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error(`${path}: JSON exceeds 2 MiB`);
  return JSON.parse(await readFile(path, 'utf8'));
}
export function assert(ok, message) { if (!ok) throw new Error(message); }
function keys(value, fields, name) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name}: expected object`);
  for (const key of Object.keys(value)) assert(fields.includes(key), `${name}: unsupported field ${key}`);
}
const positive = n => Number.isFinite(n) && n > 0;
// This profile is an intentionally small fixture executor, not a production bake.
// At L4 even a mistakenly global regional cap has at most 2,046 cube nodes.
const level = n => Number.isInteger(n) && n >= 0 && n <= 4;
function tiling(v, name) {
  assert(level(v.globalLevel) && v.globalLevel <= 3, `${name}: globalLevel must be 0..3 (bounded overview)`);
  assert(Array.isArray(v.regions) && v.regions.length <= 32, `${name}: expected finite regions`);
  for (const r of v.regions) {
    assert(typeof r === 'string' && /^[\w-]+@-?[\d.]+,-?[\d.]+:\d+=[\d.]+(?:,\d+=[\d.]+)*$/.test(r), `${name}: invalid NAME@LAT,LON:L=KM region`);
    const [where, bands] = r.split('@')[1].split(':');
    const [lat, lon] = where.split(',').map(Number);
    assert(Math.abs(lat) <= 90 && Math.abs(lon) <= 360, `${name}: invalid region centre`);
    let previousLevel = v.globalLevel, previousRadius = Infinity;
    for (const b of bands.split(',')) {
      const [L, radius] = b.split('=').map(Number);
      assert(level(L) && L === previousLevel + 1 && positive(radius) && radius <= previousRadius,
        `${name}: fixture levels must be 0..4, contiguous after the global overview, with positive/nonincreasing radii`);
      previousLevel = L; previousRadius = radius;
    }
  }
}
function selectionLevel(v) {
  return Math.max(v.globalLevel, ...v.regions.flatMap(r => r.split(':')[1].split(',').map(x => Number(x.split('=')[0]))));
}

/** Compile only a validated, pinned finite plan. Paths are runtime bindings, never identities. */
export async function compileBuild(lock) {
  await validateLockedSurfacePlan(lock);
  assert(serializeSurfacePlan(lock.processing.generator) === serializeSurfacePlan(GENERATOR), 'unsupported generator; expected cosmolabe-surface-build version 1');
  assert(lock.desired.body === 'Mars' && lock.desired.frame === 'IAU_MARS', 'v1 executor supports bounded Mars builds only');
  const c = lock.desired.coordinates;
  assert(c.longitudeDirection === 'east', 'west-positive source grids are unsupported');
  assert(c.latitude === 'planetocentric', 'XYZ execution requires explicit planetocentric source coordinates');
  // #248 currently permits only identity locks. Areoid conversion must first be
  // expressible in that shared contract, not hidden in a private executor flag.
  assert(c.referenceShape.kind === 'sphere', 'ellipsoid/areoid execution needs a shared non-identity lock transform; v1 supports sphere-radial fixtures only');
  assert(lock.processing.fusion === 'residual-bias-none', 'only authoritative residual fusion with bias none is supported');
  assert(lock.output.formatVersion === 'cosmolabe-cube-1' && lock.output.imageryEncoding === 'png'
    && lock.output.elevationEncoding === 'float32', 'unsupported output format; expected cube-1 PNG / float32');
  assert(lock.output.tileSize <= 1024 && lock.output.gutter >= 1 && lock.output.gutter <= 8, 'unsupported tile size/gutter');
  const p = lock.processing.parameters;
  keys(p, ['terrain', 'imagery', 'gates', 'caveats'], 'parameters');
  keys(p.terrain, ['base', 'detail', 'globalLevel', 'regions', 'blendM', 'fitStride'], 'terrain');
  tiling(p.terrain, 'terrain');
  assert(positive(p.terrain.blendM) && Number.isInteger(p.terrain.fitStride) && p.terrain.fitStride >= 1, 'invalid fusion taper/stride');
  const byId = new Map(lock.sources.map(s => [s.id, s]));
  const base = byId.get(p.terrain.base), detail = byId.get(p.terrain.detail);
  assert(base?.channel === 'elevation' && detail?.channel === 'elevation' && base !== detail, 'terrain requires distinct selected base and detail elevation sources');
  assert(Array.isArray(p.imagery) && p.imagery.length >= 1 && p.imagery.length <= 4, 'expected 1..4 independent imagery products');
  const used = new Set([base.id, detail.id]);
  for (const image of p.imagery) {
    keys(image, ['sourceId', 'globalLevel', 'regions', 'visible', 'opacity'], 'imagery');
    const source = byId.get(image.sourceId);
    assert(source?.channel === 'imagery' && !used.has(image.sourceId), 'imagery requires unique selected source IDs');
    assert(source.projection === 'EPSG:4326', `${source.id}: only EPSG:4326 XYZ imagery is supported`);
    assert(typeof image.visible === 'boolean' && Number.isFinite(image.opacity) && image.opacity >= 0 && image.opacity <= 1, 'explicit layer visibility/opacity required');
    tiling(image, image.sourceId); used.add(image.sourceId);
  }
  assert(used.size === byId.size, 'all locked sources must have an execution adapter');
  for (const s of lock.sources) {
    assert(s.asset.checksum?.algorithm === 'sha256', `${s.id}: execution requires SHA-256, a mutable version/URL is insufficient`);
    assert(s.asset.bytes > 0, `${s.id}: exact source bytes required`);
    assert(!s.metadata || s.metadata.reuse.status === 'allowed', `${s.id}: permissions unknown or restricted`);
    assert(s.projection === 'EPSG:4326', `${s.id}: source reprojection is unsupported`);
  }
  keys(p.gates, ['maxOffsetM', 'maxBoundaryStepM', 'controls', 'clearanceM'], 'gates');
  assert(positive(p.gates.clearanceM) && p.gates.clearanceM <= 500, 'explicit clearance must be in (0, 500] metres');
  assert(positive(p.gates.maxOffsetM) && positive(p.gates.maxBoundaryStepM), 'explicit registration and boundary limits required');
  assert(Array.isArray(p.gates.controls) && p.gates.controls.length > 0 && p.gates.controls.length <= 64, 'independent terrain controls required');
  for (const cp of p.gates.controls) {
    keys(cp, ['lat', 'lon', 'heightM', 'toleranceM'], 'control');
    assert(Number.isFinite(cp.lat) && Math.abs(cp.lat) <= 90 && Number.isFinite(cp.lon) && Math.abs(cp.lon) <= 360
      && Number.isFinite(cp.heightM) && positive(cp.toleranceM), 'invalid control point');
  }
  assert(Array.isArray(p.caveats) && p.caveats.every(s => typeof s === 'string'), 'explicit caveats required (use [] when none)');
  // Bind the implementation as well as the lock: changing a shared primitive
  // invalidates caches even if a developer forgets to bump a version string.
  const files = ['scripts/surface-build/plan.mjs', 'scripts/surface-build/run.mjs', 'scripts/surface-build/worker.py',
    'scripts/terrain/dem.py', 'scripts/terrain/cube_imagery.py', 'scripts/terrain/cube_xyz.py', 'scripts/validate-cube-terrain.mjs',
    'packages/three/src/surface/CubeSphere.ts', 'packages/three/src/surface/CubeSphereGrids.ts',
    'packages/three/src/surface/CubeImagery.ts', 'package-lock.json'];
  const implementation = Object.fromEntries(await Promise.all(files.map(async path => [path, await hashFile(resolve(ROOT, path))])));
  const buildId = identity({ lock: lock.identity, implementation });
  const products = [{ id: `terrain-${buildId.slice(0, 24)}`, kind: 'cube-terrain', sourceIds: [base.id, detail.id], tiling: p.terrain },
    ...p.imagery.map((im, order) => ({ id: `imagery-${identity({ buildId, sourceId: im.sourceId }).slice(0, 24)}`,
      kind: 'cube-imagery', sourceIds: [im.sourceId], tiling: im, order, visible: im.visible, opacity: im.opacity }))];
  // Output density is not native accuracy. Never silently lower a locked target.
  for (const s of lock.selections) {
    assert(s.resampling === (s.channel === 'elevation' ? 'cubic' : 'bilinear'), 'resampling must match the existing cubic DEM / bilinear XYZ primitives');
    if (s.channel === 'imagery') assert(s.sourceIds.length === 1, 'v1 imagery selections require one independent source per region/channel');
    const t = s.channel === 'elevation' ? p.terrain : p.imagery.find(x => s.sourceIds.includes(x.sourceId));
    const spacing = 2 * c.referenceShape.radiusKm * 1000 / ((s.channel === 'elevation' ? 64 : lock.output.tileSize) * 2 ** selectionLevel(t));
    assert(spacing <= s.outputGsdM, `${s.regionId}/${s.channel}: finest output spacing ${spacing} m exceeds locked ${s.outputGsdM} m`);
  }
  const estimate = await estimateSurfacePlan(lock.desired, { sources: lock.sources });
  const nodes = lock.sources.map(s => ({ id: `source:${s.id}`, kind: 'source', dependencies: [], sourceId: s.id,
    url: s.asset.url ?? null, retrieval: s.asset.retrieval ?? null, bytes: s.asset.bytes, sha256: s.asset.checksum.value }));
  nodes.push({ id: 'fusion', kind: 'residual-fusion', dependencies: [`source:${base.id}`, `source:${detail.id}`], bias: 'none', blendM: p.terrain.blendM });
  for (const product of products) {
    nodes.push({ id: product.id, kind: product.kind, dependencies: product.kind === 'cube-terrain' ? ['fusion'] : product.sourceIds.map(id => `source:${id}`),
      transforms: ['identity', product.kind === 'cube-terrain' ? 'sphere-radial cube geometry + CPU grids' : 'shared EPSG:4326 XYZ to cube, premultiplied alpha'],
      tiling: product.tiling });
    nodes.push({ id: `validate:${product.id}`, kind: 'validation', dependencies: [product.id] });
  }
  nodes.push({ id: 'publish', kind: 'explicit-publication-only', dependencies: products.map(x => `validate:${x.id}`) });
  return { version: 1, kind: 'surface-build-dag', lockIdentity: lock.identity, buildId, implementation, products, nodes,
    resources: { stage: 'source-aware-uncalibrated', rawSourceBytes: lock.sources.reduce((n, s) => n + s.asset.bytes, 0),
      publishedBytes: estimate.totals.publishedBytes, publishedObjects: estimate.totals.publishedObjects,
      peakDiskBytes: { min: estimate.totals.peakWorkDiskBytes.min, max: null }, peakRamBytes: null,
      caveats: ['Planner raster scenarios are not cube packing bounds.', 'Decoded raster dimensions and worker concurrency determine peak RAM; unknown before inspection.',
        'XYZ bundles have additional response bytes recorded at inspection.', 'No shared global terrain patch composition is promised.'], browser: estimate.browser },
    caveats: p.caveats };
}

/** Check byte identity, not just existence/size. The dry run performs no downloads or writes. */
export async function inspectBindings(lock, bindings, baseDir) {
  keys(bindings, lock.sources.map(s => s.id), 'bindings');
  return Promise.all(lock.sources.map(async s => {
    const local = bindings[s.id];
    assert(local === undefined || typeof local === 'string', `${s.id}: binding must be a local filename`);
    if (!local) return { sourceId: s.id, state: 'missing', downloadBytes: s.asset.bytes };
    assert(!/^[a-z][\w+.-]*:/i.test(local), 'bindings must be local files');
    const path = resolve(baseDir, local);
    try {
      const st = await stat(path);
      if (!st.isFile() || st.size !== s.asset.bytes || await hashFile(path) !== s.asset.checksum.value)
        return { sourceId: s.id, state: 'checksum-mismatch', path, downloadBytes: s.asset.bytes };
      const responses = [];
      if (s.channel === 'imagery') {
        const bundle = await jsonFile(path);
        assert(bundle.version === 1 && bundle.kind === 'locked-xyz-bundle' && bundle.tiles && Object.keys(bundle.tiles).length <= 100000, `${s.id}: expected finite locked XYZ bundle`);
        const seen = new Set();
        for (const entry of Object.values(bundle.tiles)) {
          assert(typeof entry.path === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256), `${s.id}: invalid response pin`);
          if (seen.has(entry.sha256)) continue;
          seen.add(entry.sha256);
          const responsePath = resolve(dirname(path), entry.path);
          let size = null, verified = false;
          try {
            size = (await stat(responsePath)).size;
            verified = await hashFile(responsePath) === entry.sha256;
          } catch (e) { if (e.code !== 'ENOENT') throw e; }
          responses.push({ sha256: entry.sha256, bytes: size, verified });
        }
      }
      return { sourceId: s.id, state: responses.every(r => r.verified) ? 'verified' : 'response-missing-or-changed', path, downloadBytes: 0, responses };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { sourceId: s.id, state: 'missing', path, downloadBytes: s.asset.bytes };
    }
  }));
}
