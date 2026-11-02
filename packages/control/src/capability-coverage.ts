/** Machine-checkable UI/control/script/discovery inventory. No assertion of complete UI parity. */
import { agentDefinitions } from './agent.js';
import { capabilityDomain, defaultAskDefinitions } from './capabilities.js';
import { VERBS } from './verbs.js';

const UI: Readonly<Record<string, string>> = {
  spatial: 'Point Probe / DrawToolbar',
  scene: 'BodyDrawer / NavigationView / ScriptConsole', camera: 'NavigationActions / NavigationView / ScriptConsole',
  time: 'TimeScrubber / TimelineDock / ScriptConsole', activities: 'MissionActivityTimeline / SelectedEventInspector',
  places: 'NavigatePanel', surface: 'SurfaceLayersPanel / ImageryLayersSection', grids: 'SurfaceLayersPanel / ScriptConsole',
  measurements: 'MeasurementPanel', geographic: 'SurfaceLayersPanel / DrawToolbar', readiness: 'Scene loading / SurfaceLayersPanel',
  events: 'EventFinder / EventDetails / TimelineDock', instruments: 'InstrumentViewPanel', bookmarks: 'DisplaySettings / view-link',
  display: 'BodyDrawer / ScriptConsole', capture: 'Command palette / ScriptConsole',
};
/** Existing port methods which have no catalog operation. A new method must be classified here or registered. */
export const CONTROL_CONTRACT_GAPS = {
  resolvePlace: 'Trusted exact body/layer/feature resolver. Agents resolve through bounded searchPlaces and exact refs, which withhold private source identities.',
  getViewState: 'Trusted portable export through existing ViewState v1. Raw catalog/resource state is withheld from agent transport; snapshot/restore uses typed host operations.',
  getSelectedMeasurement: 'Observed by listMeasurements; trusted hosts receive full definitions.',
  getSelectedGeographicFeature: 'Scene-scoped geographic selection read; included in notifications.',
  getActivity: 'Activity detail is currently derived from listActivities; direct lookup is not a separate tool.',
  getTimelineWindow: '#297: timeline window read/write schemas missing.',
  setTimelineWindow: '#297: timeline window read/write schemas missing.',
  getCamera: 'Used by UI and snapshot; explicit pose read schema missing (#297).',
  getCameraReference: '#297: portable floating-origin read/write schema missing.',
  setCameraReference: '#297: portable floating-origin read/write schema missing.',
  getSelectedActivity: 'Observed by describeScene and receipt readback.',
  getSelectedPlace: 'Observed by describeScene and receipt readback.',
  getPlace: 'Used for exact scene reference readback; searchPlaces is the bounded public read.',
  getTime: 'Observed by describeScene and receipt readback.',
  getRate: 'Observed by describeScene and receipt readback.',
  isPlaying: 'Observed by describeScene and receipt readback.',
  getSelected: 'Observed by describeScene and receipt readback.',
  getTracked: 'Observed by describeScene and receipt readback.',
  getFlight: 'Observed by describeScene and flight receipts.',
  listObjects: 'Bounded by describeScene and resolve.',
  listViewpoints: 'Bounded by describeScene and resolve.',
  snapshot: 'Trusted script serialization; raw text is not exposed to agents.',
  getScene: 'Observed by describeScene; scene identity guards every task.',
  on: 'Infrastructure: task lifecycle, progress and camera ownership events.',
} as const;

export const UI_CAPABILITY_GAPS = [
  { feature: 'Event Finder', ui: 'EventFinder / EventDetails', reason: 'Existing query configuration, run/progress/cancel/results/selection are registered. Trajectory-extrema solver implementation is owned by #329.' },
  { feature: 'Geographic file import/export', ui: 'DrawToolbar', reason: 'Bounded annotation edits are supported; local file import/export and authored layer snapshot transport require an explicit portable-resource contract.' },
  { feature: 'Instruments', ui: 'InstrumentViewPanel', reason: 'Synthetic sensor feeds and truthful pointing inspection are registered. Calibrated observation ingestion/authority is owned by #28/#192-195; no calibrated measurements are fabricated.' },
  { feature: 'Bookmarks / view sharing', ui: 'NavigationView / camera bookmark and permalink actions', reason: 'Session bookmark CRUD and same-catalog ViewState v1 restore are registered. Raw portable state capture is trusted-host-only; automatic file/clipboard/network export is withheld.' },
  { feature: 'Surface planner', ui: 'SurfaceLayersPanel / external plan:surface CLI', reason: 'CLI planning/building is outside ViewerControl; no browser filesystem/network tool. #297 owns any future viewer contract.' },
  { feature: 'Terrain appearance / readiness', ui: 'SurfaceAppearanceControls / SurfaceLayersPanel', reason: 'getSurfaceData inventories existing configuration/runtime observations. Appearance writes and bounded readiness predicates are supported. Current-view product-footprint geometry coverage and target LOD are exposed. Arbitrary-region/planet-wide coverage is not a supported predicate.' },
] as const;

export function capabilityCoverage() {
  const direct = new Set(defaultAskDefinitions().map(d => d.name));
  return [
    ...agentDefinitions().map(def => {
      const domain = capabilityDomain(def.name, def.effect);
      return { feature: domain, operation: `${domain}.${def.name}`, ui: UI[domain],
        semantic: def.method ?? 'bounded composite read', script: VERBS.has(def.name) ? def.name : null,
        discovery: true, defaultAsk: direct.has(def.name) ? 'direct' : 'discovery', effect: def.effect, permission: def.effect === 'authoring' ? 'approve-authoring' : def.effect === 'export' ? 'approve-external' : 'direct', status: 'registered', missingReason: null };
    }),
    ...UI_CAPABILITY_GAPS.map(gap => ({ ...gap, operation: null, semantic: null, script: null,
      discovery: false, status: 'gap', missingReason: gap.reason })),
  ];
}
