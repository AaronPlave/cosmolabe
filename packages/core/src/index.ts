export { Body } from './Body.js';
export type { BodyProperties, TrajectoryPlotConfig, BodyChangeField, BodyChangeCallback } from './Body.js';
export { Universe } from './Universe.js';
export type { UniverseOptions } from './Universe.js';
export { CatalogLoader, collectKernelRefs } from './catalog/CatalogLoader.js';
export type { CatalogJson, CatalogItem, TrajectorySpec, RotationModelSpec, GeometrySpec, LoadedCatalog, CatalogLoaderOptions, ViewpointDefinition, TrajectoryFactory, RotationFactory, TrajectoryFactoryContext, RotationFactoryContext, KernelRef, SpkImportSpec } from './catalog/CatalogLoader.js';
export { loadCatalogFromUrl } from './catalog/CatalogResolver.js';
export type { ResolvedCatalog, ResolvedCatalogGraph, ResolvedKernel, CatalogFetcher } from './catalog/CatalogResolver.js';

// Built-in catalogs (Sun, Earth system, planets, asteroids, …) for programmatic
// catalog composition.
export { builtinCatalogs } from './builtin-catalogs/index.js';
export type { BuiltinCatalogName } from './builtin-catalogs/index.js';

// Trajectories
export type { CartesianState, Trajectory } from './trajectories/Trajectory.js';
export { FixedPointTrajectory } from './trajectories/FixedPoint.js';
export { KeplerianTrajectory } from './trajectories/Keplerian.js';
export type { KeplerianElements } from './trajectories/Keplerian.js';
export { SpiceTrajectory } from './trajectories/SpiceTrajectory.js';
export { InterpolatedStatesTrajectory } from './trajectories/InterpolatedStates.js';
export type { StateRecord } from './trajectories/InterpolatedStates.js';
export { CompositeTrajectory } from './trajectories/CompositeTrajectory.js';
export type { TrajectoryArc } from './trajectories/CompositeTrajectory.js';
export { TLETrajectory } from './trajectories/TLETrajectory.js';
export type { TLEData, TLETrajectoryOptions } from './trajectories/TLETrajectory.js';
export { WaypointTrajectory } from './trajectories/WaypointTrajectory.js';
export type { Waypoint } from './trajectories/WaypointTrajectory.js';
export { createBuiltinTrajectory } from './trajectories/BuiltinTrajectory.js';
export { parseXyzv } from './trajectories/XyzvParser.js';

// Rotations
export type { Quaternion, RotationModel, InertialFrameName } from './rotations/RotationModel.js';
export { DEFAULT_INERTIAL_FRAME } from './rotations/RotationModel.js';
export { UniformRotation } from './rotations/UniformRotation.js';
export { SpiceRotation } from './rotations/SpiceRotation.js';
export { TrajectoryNadirRotation } from './rotations/TrajectoryNadirRotation.js';
export { FixedRotation } from './rotations/FixedRotation.js';
export { FixedEulerRotation } from './rotations/FixedEulerRotation.js';
export { InterpolatedRotation, parseQFile } from './rotations/InterpolatedRotation.js';
export type { OrientationRecord } from './rotations/InterpolatedRotation.js';

// Kinematics — frame-aware sub-point and body-fixed velocity primitives,
// plus the inter-inertial-frame composition utility (`alignPositionToFrame`)
// that underlies BodyMesh.updatePosition and Universe.subPointOf. Apps
// that build their own body-fixed math (sub-points for 2D ground tracks,
// surface velocities for custom HUDs) should reach for these rather than
// reinvent the obliquity rotation and quaternion-rotate-vec primitives.
export { alignPositionToFrame, bodyTrajectoryFrameName, rotateVecByQuat } from './kinematics.js';
export type { Vec3 } from './kinematics.js';

// Frames
export type { Frame } from './frames/Frame.js';
export { transformVector } from './frames/Frame.js';
export { InertialFrame, EclipticJ2000, ICRF, EquatorJ2000 } from './frames/InertialFrame.js';
export { BodyFixedFrame } from './frames/BodyFixedFrame.js';
export { TwoVectorFrame } from './frames/TwoVectorFrame.js';

// Geometry
export { GeometryCalculator } from './geometry/GeometryCalculator.js';
export type { BodyGeometry, GeometryConfig } from './geometry/GeometryCalculator.js';
export { EventFinder } from './geometry/EventFinder.js';
export type { EventType, EventFinderConfig } from './geometry/EventFinder.js';

// Plugins
export type { CosmolabePlugin } from './plugins/Plugin.js';
export type { ResourceLayer } from './plugins/ResourceLayer.js';

// Events
export { EventBus } from './events/EventBus.js';
export type { EventHandler } from './events/EventBus.js';
export type { UniverseEventMap } from './events/EventTypes.js';

// State
export { StateStore } from './state/StateStore.js';
export type { StateListener } from './state/StateStore.js';
export type { UniverseState } from './state/StateTypes.js';
export { DEFAULT_UNIVERSE_STATE } from './state/StateTypes.js';
