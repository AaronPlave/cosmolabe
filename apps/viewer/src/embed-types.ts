/**
 * Declaration entry for the published package (`npm run build:embed`): the
 * public API without the Svelte implementation behind it. `embed.ts` checks
 * that its `mountCosmolabe` matches the signature declared here.
 */
import type { CosmolabeViewer, MountOptions } from './embed-api';

export type * from './embed-api';

/**
 * Mount the complete Cosmolabe workspace into `container`, which it fills and
 * follows as it resizes. One workspace per page: a second concurrent mount
 * rejects; mount again after `dispose()`.
 */
export declare function mountCosmolabe(container: HTMLElement, options?: MountOptions): Promise<CosmolabeViewer>;

export {
  HostDataAdapter, exploratoryData, parseMissionActivities, etFromCalendarString, etToDate, StateUnavailableError,
} from '@cosmolabe/core';
export type {
  CatalogJson, MissionActivity, MissionActivitySpec, MissionStateSource, MissionStateSink, MissionStateChannel, MissionStateChange,
  PositionConvention, AttitudeConvention, PositionSample, AttitudeSample, StateBatch, PositionBatch, AttitudeBatch, SuppliedBatch,
  SampleTime, SourceStatus, ChannelCoverage, CoverageInterval, StateAvailability, UnavailableReason, DataProvenance, HostData,
  ExploratoryData, PluginData,
} from '@cosmolabe/core';
export type {
  ViewerControl, ScriptEventMap, ScriptEventName, ScriptTime, ScriptActivity, ScriptActivityFilter, ScriptObjectState, ScriptAvailability,
} from '@cosmolabe/control';
