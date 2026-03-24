export { Body } from './Body.js';
export type { BodyProperties, TrajectoryPlotConfig } from './Body.js';
export { Universe } from './Universe.js';
export type { UniverseOptions } from './Universe.js';
export { CatalogLoader } from './catalog/CatalogLoader.js';
export type { CatalogJson, CatalogItem, TrajectorySpec, RotationModelSpec, GeometrySpec, LoadedCatalog, CatalogLoaderOptions, ViewpointDefinition } from './catalog/CatalogLoader.js';

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
export type { TLEData } from './trajectories/TLETrajectory.js';
export { createBuiltinTrajectory } from './trajectories/BuiltinTrajectory.js';
export { parseXyzv } from './trajectories/XyzvParser.js';

// Rotations
export type { Quaternion, RotationModel } from './rotations/RotationModel.js';
export { UniformRotation } from './rotations/UniformRotation.js';
export { SpiceRotation } from './rotations/SpiceRotation.js';
export { TrajectoryNadirRotation } from './rotations/TrajectoryNadirRotation.js';
export { FixedRotation } from './rotations/FixedRotation.js';
export { FixedEulerRotation } from './rotations/FixedEulerRotation.js';
export { InterpolatedRotation, parseQFile } from './rotations/InterpolatedRotation.js';
export type { OrientationRecord } from './rotations/InterpolatedRotation.js';

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
export type { SpiceCraftPlugin } from './plugins/Plugin.js';
export type { ResourceLayer } from './plugins/ResourceLayer.js';
