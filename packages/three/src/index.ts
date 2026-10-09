// Main renderer
export { UniverseRenderer } from './UniverseRenderer.js';
export type { UniverseRendererOptions, SurfacePickResult } from './UniverseRenderer.js';

// Scene components
export { BodyMesh } from './BodyMesh.js';
export type { ModelResolver } from './BodyMesh.js';
export { TrajectoryLine } from './TrajectoryLine.js';
export type { TrajectoryLineOptions, PositionResolver, ColorSegment, DrawnTrail } from './TrajectoryLine.js';
export { TrajectoryLead, resolveLeadWindows, leadFade } from './TrajectoryLead.js';
export type { LeadRequest, LeadPolicy, LeadSpan, LeadWindow, LeadWindowKind, DrawnLead } from './TrajectoryLead.js';
export { TrajectoryCache } from './TrajectoryCache.js';
export type { TrajectoryCacheConfig } from './TrajectoryCache.js';
export {
  SpiceCacheWorker,
  GeometrySearchCancelled,
} from './SpiceCacheWorker.js';
export {
  GeometrySearchWorker,
  type GeometrySearch,
  type GeometrySearchScope,
  type GeometrySearchWorkerOptions,
} from './GeometrySearchWorker.js';
export { spiceAltitude, type SpiceAltitudeSource } from './spice-altitude.js';
export type {
  CacheBuildRequest,
  GeometrySearchOptions,
  GeometrySearchProgress,
  KernelSource,
  WorkerGeometrySearch,
} from './SpiceCacheWorker.js';
export { SensorFrustum } from './SensorFrustum.js';
export type { SensorFrustumOptions } from './SensorFrustum.js';
export { InstrumentView } from './InstrumentView.js';
export type { InstrumentViewOptions, FovBoundary } from './InstrumentView.js';
export { instrumentFovProviderOf } from './InstrumentFovProvider.js';
export type { InstrumentFov, InstrumentFovProvider } from './InstrumentFovProvider.js';
export { RingMesh } from './RingMesh.js';
export { AssetLoadTracker, DEFAULT_INITIAL_ASSET_TIMEOUT_MS } from './AssetLoadTracker.js';
export type {
  AssetKind,
  AssetRequest,
  AssetFailure,
  AssetProgress,
  InitialAssetsSummary,
} from './AssetLoadTracker.js';
export { AtmosphereMesh, resolveAtmosphereParams, getAtmospherePreset } from './AtmosphereMesh.js';
export type { AtmosphereParams } from './AtmosphereMesh.js';
export { BloomEffect, BLOOM_LAYER } from './BloomEffect.js';
export type { BloomConfig } from './BloomEffect.js';
export { StarField } from './StarField.js';
export type { StarFieldOptions } from './StarField.js';
export { LabelManager } from './LabelManager.js';
export type { LabelManagerOptions } from './LabelManager.js';
export { EventMarkers } from './EventMarkers.js';
export type { EventMarker, EventMarkerType, EventMarkersOptions, EventLeadVisibility } from './EventMarkers.js';
export type { ScreenRect } from './EventCallout.js';
export { OccultationGeometry } from './OccultationGeometry.js';
export type { OccultationGeometryParticipants } from './OccultationGeometry.js';
export { GeometryReadout } from './GeometryReadout.js';
export type { GeometryReadoutOptions } from './GeometryReadout.js';

// Controls
export { TimeController, rateLabel } from './controls/TimeController.js';
export type { TimeListener } from './controls/TimeController.js';
export { CameraController } from './controls/CameraController.js';
export type { CameraViewpoint, FlyToOptions } from './controls/CameraController.js';
export { applyNamedViewpoint } from './controls/applyNamedViewpoint.js';
export type { ViewpointHost, ApplyViewpointOptions } from './controls/applyNamedViewpoint.js';
export { KeyboardControls } from './controls/KeyboardControls.js';
export type { KeyboardControlsConfig } from './controls/KeyboardControls.js';
export { CameraModeName } from './controls/CameraModes.js';
export type { ICameraMode, CameraModeContext, CameraModeParams, CameraModeSpice } from './controls/CameraModes.js';

// Terrain
export { TerrainManager, TERRAIN_DEBUG_MODES } from './TerrainManager.js';
export type { TerrainConfig, TerrainImageryConfig, TerrainDebugMode, TerrainPerformanceMetrics, TerrainTiming } from './TerrainManager.js';
export { TerrainSampler, geodeticToBodyFixed, bodyFixedToGeodetic, datumRadiusAtLat } from './TerrainSampler.js';
export {
  summarizeDifferences, fitPlane, tileKeyId, parseTileKey, geographicTileBounds, geographicTilesCovering,
  tileParent, tileChildren, tileNeighbor, singleTileLayer, samplerLayer, sharedEdgeReport, seamReport,
  parentChildReport, pyramidReport, registrationReport, boundaryContinuityReport, controlPointReport,
  samplingCostReport, QuantizedMeshTileset,
} from './TerrainValidation.js';
export type {
  DifferenceStats, PlanarFit, TileKey, GeoBounds, TerrainLayer, EdgeReport, KeyedTile, LevelStats, SeamReport,
  ParentChildReport, PyramidReport, RegistrationReport, BoundaryContinuityReport, ControlPoint,
  ControlPointLayerValue, ControlPointReport, SamplingCostRow, QuantizedMeshLayerJson, QuantizedMeshTilesetOptions,
} from './TerrainValidation.js';
export type { TerrainDatum, TerrainSourceMetadata, TerrainSample, TerrainHeightTile, TerrainMeshTile, TerrainTile, BodyFixedPosition, BodyFixedCartesian } from './TerrainSampler.js';
export { SurfaceTileOverlay, SURFACE_TILE_LAYER } from './SurfaceTileOverlay.js';
export type { SurfaceTileConfig } from './SurfaceTileOverlay.js';

// Plugin interface
export type { RendererPlugin } from './plugins/RendererPlugin.js';
export type { RendererContext } from './plugins/RendererContext.js';
export type { BodyVisualizer } from './plugins/BodyVisualizer.js';
export { ObservationsVisualizer } from './plugins/ObservationsVisualizer.js';
export type { AttachedVisual, AttachOptions } from './plugins/AttachedVisual.js';
export type { RendererEventMap } from './events/RendererEventMap.js';

// Plugin UI slots
export type {
  PluginUISlots,
  PluginOverlay,
  PluginInfoSection,
  InfoRow,
  InfoSectionResult,
  PluginTimelineTrack,
  TimeInterval,
  PluginCommand,
  PluginToolbarItem,
} from './plugins/PluginUI.js';

// Stock plugins
export { TrajectoryColorPlugin } from './plugins/stock/TrajectoryColorPlugin.js';
export type { TrajectoryColorSegment } from './plugins/stock/TrajectoryColorPlugin.js';
export { ManeuverVectorPlugin } from './plugins/stock/ManeuverVectorPlugin.js';
export type { ManeuverEvent } from './plugins/stock/ManeuverVectorPlugin.js';
export { CommLinkPlugin } from './plugins/stock/CommLinkPlugin.js';
export type { CommLink } from './plugins/stock/CommLinkPlugin.js';
export { ScreenshotPlugin } from './plugins/stock/ScreenshotPlugin.js';
export { VideoRecordPlugin } from './plugins/stock/VideoRecordPlugin.js';
export { OrbitalInfoPlugin } from './plugins/stock/OrbitalInfoPlugin.js';
export { AsteroidSwarmPlugin } from './plugins/AsteroidSwarmPlugin.js';
export type { AsteroidSwarmPluginOptions } from './plugins/AsteroidSwarmPlugin.js';

// Capture
export { captureFrameDataUrl, captureFilename, downloadDataUrl } from './scripting/captureFrame.js';
export type { CaptureHost } from './scripting/captureFrame.js';

// Opt-in CPU physical-surface proof (see docs/design/physical-surface-adr.md).
export { CpuMeshSurface } from './surface/CpuMeshSurface.js';
export type { CpuSurfaceMesh } from './surface/CpuMeshSurface.js';
export { GlobeTileSurface } from './surface/GlobeTileSurface.js';
export { requestSurfaceIntersection } from './surface/PhysicalSurface.js';
export type {
  PhysicalSurface, PhysicalSurfaceMetadata, SurfaceRay, SurfaceVector, SurfaceQueryOptions,
  SurfaceAccuracy, SurfaceHit, SurfaceIntersection, SurfaceQueryLoader,
} from './surface/PhysicalSurface.js';
export { pickPhysicalSurface, cameraPositionFromSurfacePick, surfaceRayBetween } from './surface/SurfaceConsumers.js';
export type { MapImageLayer, ObservationImageProjection, ObservationRayResolver } from './surface/SurfaceImagery.js';
