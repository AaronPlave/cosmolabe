// Main renderer
export { UniverseRenderer } from './UniverseRenderer.js';
export type { UniverseRendererOptions, SurfacePickResult } from './UniverseRenderer.js';

// Scene components
export { BodyMesh } from './BodyMesh.js';
export type { ModelResolver } from './BodyMesh.js';
export { TrajectoryLine } from './TrajectoryLine.js';
export type { TrajectoryLineOptions, PositionResolver, ColorSegment } from './TrajectoryLine.js';
export { TrajectoryCache } from './TrajectoryCache.js';
export type { TrajectoryCacheConfig } from './TrajectoryCache.js';
export { SpiceCacheWorker } from './SpiceCacheWorker.js';
export type { CacheBuildRequest } from './SpiceCacheWorker.js';
export { SensorFrustum } from './SensorFrustum.js';
export type { SensorFrustumOptions } from './SensorFrustum.js';
export { InstrumentView } from './InstrumentView.js';
export type { InstrumentViewOptions, FovBoundary } from './InstrumentView.js';
export { RingMesh } from './RingMesh.js';
export { AtmosphereMesh, resolveAtmosphereParams, getAtmospherePreset } from './AtmosphereMesh.js';
export type { AtmosphereParams } from './AtmosphereMesh.js';
export { StarField } from './StarField.js';
export type { StarFieldOptions } from './StarField.js';
export { LabelManager } from './LabelManager.js';
export type { LabelManagerOptions } from './LabelManager.js';
export { EventMarkers } from './EventMarkers.js';
export type { EventMarker, EventMarkerType, EventMarkersOptions } from './EventMarkers.js';
export { GeometryReadout } from './GeometryReadout.js';
export type { GeometryReadoutOptions } from './GeometryReadout.js';

// Controls
export { TimeController, rateLabel } from './controls/TimeController.js';
export type { TimeListener } from './controls/TimeController.js';
export { CameraController } from './controls/CameraController.js';
export type { CameraViewpoint, FlyToOptions } from './controls/CameraController.js';
export { KeyboardControls } from './controls/KeyboardControls.js';
export type { KeyboardControlsConfig } from './controls/KeyboardControls.js';

// Terrain
export { TerrainManager } from './TerrainManager.js';
export type { TerrainConfig, TerrainImageryConfig } from './TerrainManager.js';
export { SurfaceTileOverlay, SURFACE_TILE_LAYER } from './SurfaceTileOverlay.js';
export type { SurfaceTileConfig } from './SurfaceTileOverlay.js';

// Plugin interface
export type { RendererPlugin } from './plugins/RendererPlugin.js';
export type { RendererContext } from './plugins/RendererContext.js';
export type { BodyVisualizer } from './plugins/BodyVisualizer.js';
export type { AttachedVisual, AttachOptions } from './plugins/AttachedVisual.js';
export type { RendererEventMap } from './events/RendererEventMap.js';

// Stock plugins
export { TrajectoryColorPlugin } from './plugins/stock/TrajectoryColorPlugin.js';
export type { TrajectoryColorSegment } from './plugins/stock/TrajectoryColorPlugin.js';
export { ManeuverVectorPlugin } from './plugins/stock/ManeuverVectorPlugin.js';
export type { ManeuverEvent } from './plugins/stock/ManeuverVectorPlugin.js';
export { CommLinkPlugin } from './plugins/stock/CommLinkPlugin.js';
export type { CommLink } from './plugins/stock/CommLinkPlugin.js';
