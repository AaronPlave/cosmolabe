// The port
export type {
  ViewerControl,
  ScriptActivity,
  ScriptActivityFilter,
  ScriptAvailability,
  ScriptObjectState,
  ViewerSnapshotState,
  CircleDirection,
  CoordinateNavigationOptions,
  FlightPath,
  SurfaceView,
  ScriptCamera,
  ScriptEventMap,
  ScriptEventName,
  ScriptFlight,
  FlightOutcome,
  ScriptScene,
  ScriptPlace,
  ScriptImagery,
  ScriptImageryLayer,
  ScriptImage,
  ScriptTime,
  ScriptVec3,
} from './contracts.js';

// The language
export type {
  ExecuteOptions,
  ScriptCancelSignal,
  ExecutionReport,
  ParseOptions,
  Program,
  Statement,
  VerbValue,
} from './contracts.js';
export { parse } from './parse.js';
export { execute } from './execute.js';
export { snapshotScript, quote } from './snapshot.js';

// Errors
export {
  ScriptSyntaxError,
  ScriptRuntimeError,
  formatProblem,
} from './errors.js';
export type { ScriptProblem, ScriptProblemKind } from './errors.js';

// The vocabulary
export { VERBS, VERB_LIST, VERB_NAMES, FRAME_MODES, FLIGHT_PATHS, SURFACE_VIEWS, LAYERS, verbUsage } from './verbs.js';
export type { ParamType, VerbParam, VerbPreset, VerbSpec } from './verbs.js';
export { suggest } from './suggest.js';

// Editor support
export { cursorContext, completionsAt, signatureAt } from './complete.js';
export type { CursorContext, ScriptCompletion, CompletionNames, ScriptSignature } from './complete.js';
export { ANGULAR_GRID_STEPS, DEFAULT_GRID_SETTINGS, normalizeGridSettings, gridBodyState } from './grid.js';
export type { GridSettings } from './grid.js';
export { applyViewState, decodeViewState, encodeViewState, validateViewState, viewStateAtEpoch, ViewStateError, MAX_VIEW_STATE_LENGTH, PORTABLE_POSE_MODES } from './view-state.js';
export type { ViewStateV1, ViewCatalog, ViewTime } from './view-state.js';

// Agent tools (#311)
export { createAgentTools } from './agent.js';
export type {
  AgentTools, AgentTask, AgentToolDef, AgentToolEffect, AgentToolResult, AgentErrorCode, AgentJsonSchema, AgentToolsOptions,
} from './agent.js';
export { runAgent, AgentTransportError, AGENT_SYSTEM_PROMPT, AGENT_WIRE_VERSION } from './agent-loop.js';
export type {
  AgentContent, AgentMessage, AgentRequest, AgentResponse, AgentStop, AgentTransport, AgentErrorKind, AgentEvent, AgentOutcome, AgentRunOptions, AgentRun,
  AgentWireRequest, AgentWireResponse,
} from './agent-loop.js';
