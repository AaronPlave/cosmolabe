export { Body } from './Body.js';
export type { BodyProperties, TrajectoryPlotConfig, BodyChangeField, BodyChangeCallback, LegacyTrajectoryFrame } from './Body.js';
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
export {
  OBLIQUITY_J2000_ARCSEC,
  OBLIQUITY_J2000_DEG,
  OBLIQUITY_J2000_RAD,
} from './constants.js';
export type { CartesianState, Trajectory } from './trajectories/Trajectory.js';
export { FixedPointTrajectory } from './trajectories/FixedPoint.js';
export { KeplerianTrajectory } from './trajectories/Keplerian.js';
export type { KeplerianElements } from './trajectories/Keplerian.js';
export { SpiceTrajectory } from './trajectories/SpiceTrajectory.js';
export { InterpolatedStatesTrajectory } from './trajectories/InterpolatedStates.js';
export type { StateRecord } from './trajectories/InterpolatedStates.js';
export {
  oemToStateRecords,
  oemEpochToEt,
  oemRefFrameToInertial,
  oemFrameName,
  checkOemFrame,
  type OemFrameCheck,
} from './trajectories/OemAdapter.js';
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

// Kinematics — frame-aware sub-point and body-fixed velocity geometry, plus
// the inter-inertial-frame composition utility (`alignPositionToFrame`) that
// underlies BodyMesh.updatePosition and subPointOf. Apps that build their own
// body-fixed math (sub-points for 2D ground tracks, surface velocities for
// custom HUDs) should reach for these rather than reinvent the obliquity
// rotation and quaternion-rotate-vec primitives.
//
// `subPointOf` and `bodyFixedVelocityMagnitudeOf` take a `BodyLookup` —
// `(name) => universe.getBody(name)` — rather than living on `Universe`,
// which held them only for that lookup. New geometry belongs here or in
// `geometry/`, not as another method on the model.
export {
  alignPositionToFrame,
  bodyTrajectoryFrameName,
  bodyPositionFrame,
  rotateVecByQuat,
  multiplyQuat,
  frameAlignmentQuat,
  composeBodyToWorldQuat,
  bodyFixedOffsetToWorld,
  subPointOf,
  bodyFixedVelocityMagnitudeOf,
} from './kinematics.js';
export type { BodyLookup } from './kinematics.js';

// The SPICE surface core still calls — transitional, and deliberately narrow:
// only what core's own call sites use, not the heritage adapter's full surface.
// core never constructs an engine; it takes one by injection, and both
// @cosmolabe/frames (createHeritageSpice, the runtime path) and
// @cosmolabe/spice (the reference implementation used in tests) satisfy this
// structurally. It shrinks as call sites migrate to the M-0002 contracts.
// See src/spice-injection.ts.
export type {
  AberrationCorrection,
  IlluminationAngles,
  KernelSource,
  OrbitalElements,
  RotationMatrix,
  SpiceInstance,
  StateVector,
  SubPoint,
  TimeWindow,
  Vec3,
} from './spice-injection.js';

// Frames — the named-frame registry (#101). `Universe.frames` is the instance
// wired to a universe's SPICE and bodies; `DEFAULT_FRAMES` holds the built-in
// frames only.
export {
  FrameRegistry,
  DEFAULT_FRAMES,
  BUILTIN_FRAMES,
  BODY_FIXED,
  WORLD_FRAME,
  bodyFixedFrameName,
  normalizeFrameKey,
  isStateDependentFrameName,
  type FrameDefinition,
  type FrameKind,
  type FixedFrameSpec,
  type FrameRegistryOptions,
} from './frames/FrameRegistry.js';
export {
  precessionMatrix,
  nutationMatrix,
  nutationAngles,
  meanObliquity,
  equationOfEquinoxes,
  gmst,
  j2000ToMod,
  j2000ToTod,
  j2000ToTeme,
  j2000ToEarthFixed,
} from './frames/earthOrientation.js';
export { mat3Mul, mat3Transpose, mat3Vec, mat3ToQuat, quatToMat3 } from './frames/mat3.js';
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
export type {
  AnalysisContext,
  AnalysisQuantity,
  AnalysisReferenceContext,
  ConfiguredAnalysisItem,
  ConfiguredContinuousProfile,
  ConfiguredEventQuery,
  ContinuousProfileConfiguration,
  EventQueryConfiguration,
  ResolvedContinuousProfile,
} from './geometry/analysis.js';
export { resolveContinuousProfile, resolveEventQuery } from './geometry/analysis.js';

// Geometry/event finder — the shared query + result model every geometry
// search is expressed in, the SPICE GF boundary it runs against, and the
// timeline/3D integration selecting an event drives. See docs/event-model.md.
export * from './geometry/events/index.js';

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

// Time
export {
  utcMsFromCalendarString,
  etFromCalendarString,
  deltaAtSeconds,
  J2000_UNIX_MS,
  etToDate,
  etFromDate,
} from './time.js';
