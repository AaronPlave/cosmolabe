import { identity } from './plan.mjs';

// Versioned planner feedback. Never infer continuous coverage from tile counts.
export function plannerFeedback(lock, products, audit, resources, sources, terrainValidation) {
  return {
    version: 1, kind: 'surface-planner-feedback', lockIdentity: lock.identity,
    requested: lock.desired.regions.map(region => {
      const layer = lock.desired.layers.find(l => l.id === region.feature.layerId);
      const feature = layer.geojson.features.find(f => `${typeof f.id}:${f.id}` === region.feature.featureId);
      const selections = lock.selections.filter(s => s.regionId === region.id);
      return { regionId: region.id, geometry: feature.geometry, imagery: region.imagery ?? null, elevation: region.elevation ?? null,
        fallback: region.fallback,
        channels: selections.map(s => {
          const selected = lock.sources.filter(x => s.sourceIds.includes(x.id));
          const nativeGsdM = Math.min(...selected.map(x => x.nativeGsdM));
          const target = region[s.channel].gsdM;
          return { channel: s.channel, sourceIds: s.sourceIds, outputGsdM: s.outputGsdM, nativeGsdM,
            accuracyM: selected.map(x => ({ sourceId: x.id, accuracyM: x.accuracyM })),
            targetMetByNativeSource: nativeGsdM <= target,
            diagnostic: nativeGsdM > target ? 'native-target-unavailable; coarser physical/source data retained by declared fallback' : null };
        }) };
    }),
    products: products.map(p => {
      const sourceProofs = p.sourceIds.map(id => {
        const source = lock.sources.find(s => s.id === id);
        const a = (source.channel === 'imagery' ? audit.imagery : audit.rasters)[id];
        return { sourceId: id, declaredFootprint: source.footprint,
          declaredNativeValid: source.metadata?.validData ?? null,
          confirmedNativeValid: a?.nativeValidSubset ?? null,
          nativeGsdM: source.nativeGsdM, accuracyM: source.accuracyM,
          invalidPixels: a?.invalidPixels ?? null,
          illumination: source.metadata?.illumination ?? null,
          absoluteRegistrationErrorM: null,
          sourceGridPreservation: a?.sourceToOutputRegistration ?? null };
      });
      return { productId: p.id, productIdentity: p.productIdentity, sourceProofs,
        emitted: { availability: p.availability, maximumLevel: p.maxLevel,
          outputSpacingMByLevel: p.outputSpacingMByLevel, objects: p.objects, bytes: p.bytes,
          validPixelCount: p.validPixels ?? null, transparentPixelCount: p.transparentPixels ?? null },
        continuousNativeCoverage: p.kind === 'cube-imagery'
          ? audit.imagery[p.sourceIds[0]]?.sourceToOutputRegistration?.continuousRequestedCoverage ?? null : null,
        continuousNativeCoverageStatus: p.kind === 'cube-imagery' && audit.imagery[p.sourceIds[0]]?.sourceToOutputRegistration
          ? 'proved-for-checked-requested-ROI-only' : 'not-proved-by-tile-availability',
        publication: { status: 'not-published', objects: 0, bytes: 0, receipt: null },
        reusedFromBuild: p.reusedFromBuild ?? null };
    }),
    sourceTransfers: sources.map(s => ({ sourceId: s.sourceId, state: s.state,
      pinnedSourceBytes: lock.sources.find(x=>x.id===s.sourceId)?.asset.bytes ?? null,
      downloadedBytesThisExecution: 0, missingDownloadBytes: s.downloadBytes,
      boundResponseBytes: (s.responses ?? []).reduce((n, r) => n + (r.bytes ?? 0), 0) })),
    resources,
    sourceAcquisition: 'offline verified bindings; no network acquisition during execution',
    terrainValidation,
    unsupported: [{ code: 'terrain-patch-composition-unsupported',
      message: 'One authoritative terrain/CPU product. Geometric patch composition is unsupported; unknown terrain patch fields fail capability validation.' }],
    caveats: ['Native GSD and unknown source accuracy are distinct from resampled output spacing.',
      'No independent absolute geolocation or baked illumination certification.',
      'Emitted tile addresses do not certify continuous valid/native coverage.',
      'Physical RAM/disk peaks are unknown; sampled summed RSS may double-count shared pages.'],
  };
}

export function publishedFeedback(report, receipt) {
  const { identity: pin, ...body } = receipt;
  if (pin !== identity(body)) throw new Error('publication receipt changed');
  if (receipt.buildId !== report.buildId || receipt.lockIdentity !== report.lockIdentity) throw new Error('publication receipt/report mismatch');
  return { ...report.plannerFeedback, products: report.plannerFeedback.products.map(p => {
    const published = receipt.products.find(x => x.productId === p.productId);
    if (!published?.verified) throw new Error('partial publication cannot update planner feedback');
    return { ...p, publication: { status: receipt.localOnly ? 'verified-local-http' : 'verified-hosted-http',
      objects: published.objects, bytes: published.bytes,
      receipt: receipt.identity, baseUrl: receipt.baseUrl, prefix: published.prefix } };
  }) };
}
