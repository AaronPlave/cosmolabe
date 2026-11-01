/** Catalog declarations and runtime observations are deliberately separate. */
import type { Body } from '@cosmolabe/core';
import type { BodyMesh } from '@cosmolabe/three';
import type { ScriptImageryLayer, ScriptSurfaceData, ScriptSurfaceProduct } from '@cosmolabe/control';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === 'string' ? value : null;
/** Strip signed queries, fragments and credentials, including relative asset URLs. */
const endpoint = (value: unknown): string | null => {
  const url = string(value);
  return url === null ? null : url.replace(/[?#].*$/s, '').replace(/^((?:[a-z][a-z\d+.-]*:)?\/\/)[^/]*@/i, '$1');
};
const unknownRuntime = (): ScriptSurfaceProduct['runtime'] => ({ ready: null, loaded: null, failedRequests: null, drawn: null, coversView: null });

export function surfaceData(body: Body, bm: BodyMesh | undefined, overlays: readonly ScriptImageryLayer[]): ScriptSurfaceData {
  const geo = body.geometryData ?? {};
  const terrain = record(geo.terrain);
  const cube = record(record(terrain.cubeSphere).imagery);
  const metadata = bm?.terrainSourceMetadata ?? record(terrain.sourceMetadata);
  const cubeMetadata = bm?.terrainCubeImageryMetadata;
  const datum = record(terrain.datum);
  const product = (kind: ScriptSurfaceProduct['kind'], url: unknown): ScriptSurfaceProduct => ({
    kind, endpoint: endpoint(typeof url === 'string' ? url : record(url).template ?? record(url).topLayer), configured: true,
    source: { id: null, revision: null, kind: null }, frame: null, datum: null,
    resolutionMeters: null, runtime: unknownRuntime(),
  });
  const metrics = bm?.terrainSurfaceStatus;
  const cubeStats = bm?.terrainCubeImageryStats;
  const elevation = Object.keys(terrain).length > 0 && terrain.type !== 'imagery' ? {
    ...product('terrain', terrain.url), frame: string(terrain.frame),
    source: { id: endpoint(metadata.id), revision: string(metadata.version), kind: string(metadata.kind), url: endpoint(metadata.url) },
    datum: Object.keys(datum).length ? { verticalDatum: string(datum.verticalDatum), heightConvention: string(datum.heightConvention) } : null,
    runtime: { ...unknownRuntime(), ready: bm?.hasTerrain ?? null,
      loaded: metrics ? metrics.tiles.loaded > 0 || metrics.tiles.cpu > 0 : null,
      failedRequests: metrics?.network.failed ?? null,
      drawn: metrics ? bm?.visible === true && bm.surfaceTransitionState === 'streamed' && metrics.tiles.drawn > 0 : null },
  } satisfies ScriptSurfaceProduct : null;
  const cubeImagery = typeof cube.url === 'string' ? {
    ...product('cube-imagery', cube.url),
    source: { id: cubeMetadata?.source.id ?? null, revision: cubeMetadata?.source.version ?? cubeStats?.version ?? null, kind: cubeMetadata?.source.kind ?? null, attribution: cubeMetadata?.source.attribution ?? null, url: endpoint(cubeMetadata?.source.url) },
    crsId: cubeMetadata?.registration.crsId ?? null,
    lod: cubeMetadata ? { minLevel: cubeMetadata.minLevel, maxLevel: cubeMetadata.maxLevel } : null,
    runtime: cubeStats ? {
      ready: cubeStats.ready, manifestFailed: cubeStats.manifestFailed ?? null, loaded: cubeStats.textures > 0, failedRequests: cubeStats.failures,
      drawn: bm?.visible === true && bm.surfaceTransitionState === 'streamed' && cubeStats.tiles > 0,
      coversView: null,
      coversDrawnTiles: bm?.visible === true && bm.surfaceTransitionState === 'streamed' && cubeStats.tiles > 0 ? cubeStats.baseUncoveredBlocks === 0 : null,
    } : unknownRuntime(),
  } satisfies ScriptSurfaceProduct : null;
  return {
    body: body.name, bodyFrame: bm?.bodyFixedFrame ?? body.rotation?.bodyFixedFrame ?? null,
    surface: bm?.surfaceTransitionState ?? null, terrain: elevation, cubeImagery,
    textures: (['baseMap', 'normalMap', 'displacementMap', 'bumpMap'] as const)
      .filter(key => geo[key] != null).map(key => product(key, geo[key])),
    imageryProducts: (Array.isArray(geo.imagery) ? geo.imagery : geo.imagery ? [geo.imagery] : [])
      .map(value => {
        const config = record(value);
        return { ...product('imagery', config.url), source: { id: string(config.id), revision: null,
          kind: string(config.type), attribution: string(config.attribution) } };
      }),
    overlays,
  };
}
