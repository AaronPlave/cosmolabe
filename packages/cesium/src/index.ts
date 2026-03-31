// Main renderer (convenience orchestrator)
export { CesiumRenderer } from './CesiumRenderer.js';
export type { CesiumRendererOptions } from './CesiumRenderer.js';

// Composable standalone pieces
export { BodyEntity } from './BodyEntity.js';
export type { BodyEntityOptions } from './BodyEntity.js';
export { TrajectoryTrail } from './TrajectoryTrail.js';
export type { TrajectoryTrailOptions } from './TrajectoryTrail.js';
export { SurfacePoints } from './SurfacePoints.js';
export type { SurfacePointsOptions } from './SurfacePoints.js';
export { CameraManager } from './CameraManager.js';
export type { FlyToOptions } from './CameraManager.js';

// Globe setup (used by CesiumRenderer, also usable standalone)
export { createGlobeViewer } from './GlobeSetup.js';
export type { GlobeSetupOptions, ImageryPreset } from './GlobeSetup.js';

// Styling
export { resolveEntityStyle } from './EntityStyle.js';
export type { EntityStyleOptions, ResolvedEntityStyle } from './EntityStyle.js';

// Utilities
export { patchCesiumWorkers } from './util/workerPatch.js';
export { eclipticToIcrfMeters, KM_TO_M } from './util/coordinates.js';
