/** Machine-checkable UI/control/script/discovery inventory. No assertion of complete UI parity. */
import { agentDefinitions } from './agent.js';
import { capabilityDomain } from './capabilities.js';
import { VERBS } from './verbs.js';

const UI: Readonly<Record<string, string>> = {
  scene: 'BodyDrawer / NavigationView / ScriptConsole', camera: 'NavigationActions / NavigationView / ScriptConsole',
  time: 'TimeScrubber / TimelineDock / ScriptConsole', activities: 'MissionActivityTimeline / SelectedEventInspector',
  places: 'NavigatePanel', surface: 'SurfaceLayersPanel / ImageryLayersSection', grids: 'SurfaceLayersPanel / ScriptConsole',
  display: 'BodyDrawer / ScriptConsole', capture: 'Command palette / ScriptConsole',
};
/** Existing port methods which have no catalog operation. A new method must be classified here or registered. */
export const CONTROL_CONTRACT_GAPS = {
  getActivity: 'Activity detail is currently derived from listActivities; direct lookup is not a separate tool.',
  getObjectState: '#297: scientific state query schema and availability/provenance projection missing.',
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
  { feature: 'Event Finder', ui: 'EventFinder / EventDetails', reason: '#297 owns semantic search/results/selection/readiness APIs; no agent event analysis.' },
  { feature: 'Measurements', ui: 'MeasurementPanel', reason: '#297 owns measurement create/read/edit/delete APIs and authoring permissions.' },
  { feature: 'Geographic shapes', ui: 'DrawToolbar', reason: '#297 owns shape import/create/read/edit/delete and frame/provenance semantics.' },
  { feature: 'Instruments', ui: 'InstrumentViewPanel', reason: '#297 owns instrument selection, observation, visibility and readiness APIs.' },
  { feature: 'Bookmarks / view sharing', ui: 'NavigationView / camera bookmark and permalink actions', reason: '#297 owns semantic bookmark CRUD and share/export contract. Existing portable view-state functions are not instance-bound catalog operations.' },
  { feature: 'Surface planner', ui: 'SurfaceLayersPanel / external plan:surface CLI', reason: 'CLI planning/building is outside ViewerControl; no browser filesystem/network tool. #297 owns any future viewer contract.' },
  { feature: 'Terrain appearance / readiness', ui: 'SurfaceAppearanceControls / SurfaceLayersPanel', reason: 'getSurfaceData inventories existing configuration/runtime observations. #297 owns missing appearance writes and complete readiness APIs.' },
] as const;

export function capabilityCoverage() {
  return [
    ...agentDefinitions().map(def => {
      const domain = capabilityDomain(def.name, def.effect);
      return { feature: domain, operation: `${domain}.${def.name}`, ui: UI[domain],
        semantic: def.method ?? 'bounded composite read', script: VERBS.has(def.name) ? def.name : null,
        discovery: true, status: 'registered', missingReason: null };
    }),
    ...UI_CAPABILITY_GAPS.map(gap => ({ ...gap, operation: null, semantic: null, script: null,
      discovery: false, status: 'gap', missingReason: gap.reason })),
  ];
}
