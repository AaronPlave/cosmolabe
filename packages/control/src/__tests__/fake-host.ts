import { etFromCalendarString } from '@cosmolabe/core';
import type { MeasurementDefinition, GeographicCoordinates, GeographicEditOperation, GeographicLayerStyle } from '@cosmolabe/core';
import type { ScriptReadinessRequest, ScriptReadiness, ScriptSurfaceAppearance } from '../contracts.js';
import { normalizeGridSettings, type GridSettings } from '../grid.js';
/**
 * A complete `ViewerControl` with no renderer behind it.
 *
 * Complete on purpose: `verbs.test.ts` asserts that every `VerbSpec.method`
 * exists on this object, which is only a real check if the object implements
 * the whole interface rather than the subset the tests happen to call.
 *
 * It keeps enough state to be snapshotted, so the `snapshot` round-trip can run
 * end to end: snapshot a state, parse the text, execute it against a *fresh*
 * host, and compare.
 */
import { snapshotScript } from '../snapshot.js';
import type {
  CircleDirection,
  ScriptActivity,
  CoordinateNavigationOptions,
  FlightPath,
  ScriptCamera,
  ScriptEventMap,
  ScriptEventName,
  ScriptFlight,
  ScriptImage,
  ScriptImagery,
  ScriptPlace,
  ScriptScene,
  ScriptTime,
  ScriptVec3,
  SurfaceView,
  ViewerControl,
  ViewerSnapshotState,
} from '../contracts.js';

export interface FakeOptions {
  /** Resolve every write on the next microtask, to prove ordering holds. */
  async?: boolean;
}

export class FakeViewer implements ViewerControl {
  pinGroundPoint(_object: string, policy: import('../contracts.js').ScriptSurfacePolicy = 'rendered'): import('../contracts.js').ScriptGroundProjection { return { scene: 1, et: 0, object: _object, body: null, frame: null, policy, status: 'unavailable', reason: 'missing-parent', point: null, annotation: null, referenceOnly: false, limitations: [] }; }
  clearProbePoint() { this.log('clearProbePoint'); }
  restoreViewState(_input: unknown) { return Promise.resolve(true); }
  selectInstrument(name: string | null) { this.log('selectInstrument', name); return true; }
  saveBookmark(name: string) { this.log('saveBookmark', name); return true; }
  upsertBookmark(input: import('../contracts.js').ScriptBookmark) { this.log('upsertBookmark', input.name); return true; }
  removeBookmark(name: string) { this.log('removeBookmark', name); return true; }
  upsertEventQuery(input: import('../contracts.js').ScriptEventQuery) { this.log('upsertEventQuery', input.id); return true; }
  openEventQuery(id: string) { this.log('openEventQuery', id); return true; }
  removeEventQuery(id: string) { this.log('removeEventQuery', id); return true; }
  runEventQuery(id: string): Promise<import('../contracts.js').ScriptEventSearch> { this.log('runEventQuery', id); return Promise.resolve({ scene: this.scene?.id ?? null, query: id, status: 'complete', progress: null, error: null, selected: null }); }
  cancelEventQuery() { return true; }
  selectEventResult(query: string, id: string) { this.log('selectEventResult', query, id); return true; }
  getEventVisualization(): import('../contracts.js').ScriptEventVisualization { return { scene: this.scene?.id ?? null, selected: null, et: this.getTime(), playing: this.isPlaying(), selectedObject: this.selected, highlightedBodies: [], timeline: { min: 0, max: 1000, selectedInResults: false, selectedInVisibleLane: false }, renderer: null, status: 'partial', limitations: ['No renderer'] }; }
  getEventQueryInfo(): import('../contracts.js').ScriptEventQueryInfo { return { status: 'missing-query', definition: null, coverage: null, error: null, provenance: null }; }
  getEventResultPage(): import('../contracts.js').ScriptEventResultPage { return { status: 'missing-query', total: 0, offset: 0, nextOffset: null, items: [], query: this.getEventQueryInfo() }; }
  async presentEventResult(reference: import('../contracts.js').ScriptEventReference) { return this.focusEventResult(reference, 'middle'); }
  focusEventResult(reference: import('../contracts.js').ScriptEventReference, anchor: 'inspect' | 'start' | 'middle' | 'end' = 'inspect'): import('../contracts.js').ScriptEventFocusReceipt { this.log('focusEventResult', reference.query, reference.id, anchor); return { status: 'partial', reference, anchor, observation: this.getEventVisualization() }; }
  moveImageryLayer(body: string, layer: string, index: number) { this.log('moveImageryLayer', body, layer, index); return true; }

  selectPlace(ref: string | null) { if (ref && !this.places.some(p => p.ref === ref)) return false; this.selectedPlace = ref; return true; }
  listPlaceSources() { return []; }
  setPlaceSourceEnabled(_id: string, _enabled: boolean) { return false; }
  showPlaceLabels(_id: string, _visible: boolean) { return false; }
  measurements: MeasurementDefinition[] = [];
  selectedMeasurement: string | null = null;
  listMeasurements() { return structuredClone(this.measurements); }
  getSelectedMeasurement() { return this.selectedMeasurement; }
  upsertMeasurement(definition: MeasurementDefinition) { this.measurements = [...this.measurements.filter(m => m.id !== definition.id), structuredClone(definition)]; return true; }
  restoreMeasurements(state: { version: 1; items: MeasurementDefinition[]; selected?: string }, mode: 'merge' | 'replace' = 'merge') {
    if (mode === 'replace') { this.measurements = []; this.selectedMeasurement = null; }
    for (const m of state.items) this.upsertMeasurement(m);
    if (state.selected) this.selectedMeasurement = state.selected;
    return true;
  }
  removeMeasurement(id: string) { const found = this.measurements.some(m => m.id === id); this.measurements = this.measurements.filter(m => m.id !== id); return found; }
  selectMeasurement(id: string | null) { if (id !== null && !this.measurements.some(m => m.id === id)) return false; this.selectedMeasurement = id; return true; }
  showMeasurement(id: string, visible: boolean) { const m = this.measurements.find(m => m.id === id); if (!m) return false; m.visible = visible; return true; }
  listGeographicLayers() { return []; }
  listGeographicFeatures(_id: string) { return undefined; }
  getSelectedGeographicFeature() { return null; }
  setGeographicLayerVisible(_id: string, _visible: boolean) { return false; }
  setGeographicLayerStyle(_id: string, _style: GeographicLayerStyle | null) { return false; }
  selectGeographicFeature(_layer: string, _feature: string) { return false; }
  clearGeographicSelection() {}
  gotoGeographicFeature(_layer: string, _feature: string) { return false; }
  createAnnotationLayer(_body: string, _name: string, _coordinates: GeographicCoordinates) { return false as const; }
  editAnnotation(_layer: string, _operation: GeographicEditOperation) { return false as const; }
  getSurfaceAppearance(_body: string): { settings: ScriptSurfaceAppearance | null; unavailable: string | null } | undefined { return undefined; }
  setSurfaceAppearance(_body: string, _patch: Partial<ScriptSurfaceAppearance>) { return false; }
  getReadiness(request: ScriptReadinessRequest): ScriptReadiness { return { request, scene: this.scene?.id ?? null, status: this.scene?.ready ? 'ready' : 'partial', missing: [], limitations: ['Fake initial assets only'] }; }
  async waitUntilReady(request: ScriptReadinessRequest, _opts?: { signal?: import('../contracts.js').ScriptCancelSignal; timeoutMs?: number; scene?: number }) { return this.getReadiness(request); }

  listActivities(): readonly ScriptActivity[] { return []; }
  getActivity(_id: string): ScriptActivity | undefined { return undefined; }
  getSelectedActivity(): ScriptActivity | undefined { return undefined; }
  selectActivity(_id: string) { return false; }
  seekActivity(_id: string, _edge?: 'start' | 'end') { return false; }
  navigateActivity(_direction: 'previous' | 'next') { return false; }

  scene: ScriptScene | null = { id: 1, catalog: 'Cassini', ready: true };
  getScene() { return this.scene; }

  places: ScriptPlace[] = [
    {
      ref: '["titan-names","42"]', name: 'Kraken Mare', body: 'Titan', layer: { id: 'titan-names', name: 'Titan nomenclature' },
      feature: '42', kind: 'Mare, maria', origin: 'nomenclature', latitude: 68, longitude: 310, diameterKm: 1170,
      source: { kind: 'catalog' }, unavailable: null,
    },
    {
      ref: '["titan-names","43"]', name: 'Ligeia Mare', body: 'Titan', layer: { id: 'titan-names', name: 'Titan nomenclature' },
      feature: '43', kind: 'Mare, maria', origin: 'nomenclature', latitude: 79, longitude: 248,
      source: { kind: 'catalog' }, unavailable: 'frame mismatch',
    },
  ];
  selectedPlace: string | null = null;
  searchPlaces(query: string, opts?: { body?: string; limit?: number }) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.places
      .filter((p) => (!opts?.body || p.body === opts.body) && words.every((w) => p.name.toLowerCase().split(' ').some((n) => n.startsWith(w))))
      .slice(0, opts?.limit ?? 10);
  }
  getPlace(ref: string) { return this.places.find((p) => p.ref === ref); }
  getSelectedPlace() { return this.places.find((p) => p.ref === this.selectedPlace); }
  gotoPlace(ref: string, opts?: { animate?: boolean; view?: SurfaceView }): boolean {
    this.log('gotoPlace', ref, opts?.animate, opts?.view);
    const place = this.getPlace(ref);
    if (!place) return false;
    if (place.unavailable) throw new Error(place.unavailable);
    this.selectedPlace = ref;
    return this.ok(true);
  }

  imagery: Record<string, ScriptImagery> = {
    Titan: {
      body: 'Titan', surface: 'streamed', imageryOnly: true,
      layers: [
        { id: 'iss', name: 'ISS mosaic', attribution: 'USGS', description: null, role: 'base', optional: false, visible: true, opacity: 1,
          bounds: null, resolutionMeters: 4000, source: { type: 'xyz', endpoint: 'https://tiles.example', layer: null, tileMatrixSet: null }, status: 'ok', view: null },
        { id: 'radar', name: 'RADAR SAR', attribution: 'JPL', description: 'Cassini RADAR swaths', role: 'overlay', optional: true, visible: false,
          opacity: 1, bounds: [-180, 60, 180, 90], resolutionMeters: 300, source: { type: 'wms', endpoint: 'https://wms.example', layer: 'RADAR_SAR', tileMatrixSet: null }, status: 'idle', view: null },
      ],
    },
  };
  getImagery(body: string): ScriptImagery | undefined {
    if (!this.known(body)) return undefined;
    return this.imagery[body] ?? { body, surface: null, imageryOnly: false, layers: [] };
  }
  setImageryVisible(body: string, id: string, visible: boolean): boolean {
    this.log('setImageryVisible', body, id, visible);
    const layer = this.getImagery(body)?.layers.find((l) => l.id === id);
    if (!layer || (!visible && !layer.optional)) return false;
    (layer as { visible: boolean }).visible = visible;
    return this.ok(true);
  }
  setImageryOpacity(body: string, id: string, opacity: number): boolean {
    this.log('setImageryOpacity', body, id, opacity);
    const layer = this.getImagery(body)?.layers.find((l) => l.id === id);
    if (!layer || !(opacity >= 0 && opacity <= 1)) return false;
    (layer as { opacity: number }).opacity = opacity;
    return this.ok(true);
  }

  /** Every call, as `verb(arg, arg)`, in the order it arrived. */
  readonly calls: string[] = [];

  objects: string[] = ['Cassini', 'Titan', 'Enceladus', 'Saturn'];
  viewpoints: string[] = ['SOI (2004-07-01)', 'Ring Plane View'];

  time = 0;
  timeText: string | undefined = undefined;
  rate = 1;
  playing = false;
  selected: string | null = null;
  tracked: string | null = null;
  origin: string | null = null;
  getCameraReference(): string | null { return this.origin; }
  setCameraReference(name: string | null): boolean { this.origin = name; return true; }
  lookAt: string | null = null;
  frame: { mode: string; body?: string } = { mode: 'free-orbit' };
  camera: { position: ScriptVec3; target: ScriptVec3; up: ScriptVec3; fov: number } = {
    position: [0, 0, 1],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fov: 60,
  };
  layers: Record<string, boolean> = {
    trajectories: true,
    labels: true,
    grid: false,
    axes: false,
    sensors: true,
    sensorLabels: true,
  };
  grid: GridSettings | undefined = undefined;
  note: string | undefined = undefined;
  recording = false;
  shots = 0;

  private readonly listeners = new Map<string, Set<(data: never) => void>>();

  constructor(private readonly opts: FakeOptions = {}) {}

  private log(verb: string, ...args: unknown[]): void {
    this.calls.push(`${verb}(${args.map((a) => JSON.stringify(a) ?? String(a)).join(', ')})`);
  }

  /** `true`, or a promise of `true`, depending on how the host was configured. */
  private ok<T>(value: T): T {
    if (!this.opts.async) return value;
    return Promise.resolve(value) as unknown as T;
  }

  private known(name: string): boolean {
    return this.objects.includes(name);
  }

  // ── Write ──

  gotoObject(name: string, opts?: { seconds?: number }): boolean {
    this.log('gotoObject', name, opts?.seconds);
    if (!this.known(name)) return false;
    this.tracked = name;
    return this.ok(true);
  }

  select(name: string): boolean {
    this.log('select', name);
    if (!this.known(name)) return false;
    this.selected = name;
    return this.ok(true);
  }

  deselect(): void {
    this.log('deselect');
    this.selected = null;
  }

  track(name: string): boolean {
    this.log('track', name);
    if (!this.known(name)) return false;
    this.tracked = name;
    return this.ok(true);
  }

  untrack(): void {
    this.log('untrack');
    this.tracked = null;
  }

  /** The flight `flyTo` started; it lands only when `stopFlight` ends it. */
  flight: ScriptFlight | null = null;
  private flightSeq = 0;

  frameObject(name?: string): boolean {
    this.log('frameObject', name);
    const target = name ?? this.tracked;
    if (target === null || !this.known(target)) return false;
    this.tracked = target;
    return this.ok(true);
  }

  flyTo(name: string, opts?: { seconds?: number; path?: FlightPath }): boolean {
    this.log('flyTo', name, opts?.path, opts?.seconds);
    if (!this.known(name)) return false;
    this.flight = { id: ++this.flightSeq, target: name, path: opts?.path ?? 'direct' };
    return this.ok(true);
  }

  jumpTo(name: string): boolean {
    this.log('jumpTo', name);
    if (!this.known(name)) return false;
    this.tracked = name;
    return this.ok(true);
  }

  gotoCoordinates(name: string, latDeg: number, lonDeg: number, opts?: CoordinateNavigationOptions): boolean {
    this.log('gotoCoordinates', name, latDeg, lonDeg, opts?.view, opts?.seconds);
    if (!this.known(name)) return false;
    if (Math.abs(latDeg) > 90) throw new Error('Latitude must be between 90° S and 90° N');
    this.tracked = name;
    return this.ok(true);
  }

  stopFlight(): void {
    this.log('stopFlight');
    if (this.flight?.target) this.tracked = this.flight.target;
    this.flight = null;
  }

  getFlight(): ScriptFlight | null {
    return this.flight;
  }

  pointAtObject(name: string): boolean {
    this.log('pointAtObject', name);
    if (!this.known(name)) return false;
    this.lookAt = name;
    return this.ok(true);
  }

  clearLookAt(): void {
    this.log('clearLookAt');
    this.lookAt = null;
  }

  viewpoint(name: string): boolean {
    this.log('viewpoint', name);
    return this.ok(this.viewpoints.includes(name));
  }

  setFrame(mode: string, body?: string): boolean {
    this.log('setFrame', mode, body);
    if (body !== undefined && !this.known(body)) return false;
    if (body !== undefined) this.tracked = body;
    this.frame = body === undefined ? { mode } : { mode, body };
    return this.ok(true);
  }

  /** Objects hidden with setObjectVisible: drawn no more. */
  hidden = new Set<string>();
  setObjectVisible(name: string, visible: boolean): boolean {
    this.log('setObjectVisible', name, visible);
    if (this.known(name)) { if (visible) this.hidden.delete(name); else this.hidden.add(name); }
    return this.ok(this.known(name));
  }

  /** Per-object trajectory and label visibility, as `getViewerState` reports it. */
  display: Record<string, { trajectory: boolean; label: boolean }> = {};
  showTrajectory(name: string, visible: boolean): boolean {
    this.log('showTrajectory', name, visible);
    if (this.known(name)) this.display[name] = { trajectory: visible, label: this.display[name]?.label ?? true };
    return this.ok(this.known(name));
  }

  showLabel(name: string, visible: boolean): boolean {
    this.log('showLabel', name, visible);
    if (this.known(name)) this.display[name] = { label: visible, trajectory: this.display[name]?.trajectory ?? true };
    return this.ok(this.known(name));
  }

  timeline = { start: 0, end: 1000 };
  getTimelineWindow() { return { ...this.timeline }; }
  setTimelineWindow(start: ScriptTime, end: ScriptTime): boolean {
    const et = (t: ScriptTime) => t.kind === 'et' ? t.et : etFromCalendarString(t.text);
    this.timeline = { start: et(start), end: et(end) };
    return this.timeline.end > this.timeline.start;
  }

  getViewerState(): import('../contracts.js').ViewerState {
    return { ...this.snapshotState(), objects: this.objects.map(name => ({ name, trajectory: this.display[name]?.trajectory ?? true, label: this.display[name]?.label ?? true })) };
  }

  showBodyGrid(name: string, visible: boolean): boolean {
    if (!this.known(name)) return false;
    this.grid = normalizeGridSettings({ ...this.grid, perBody: { ...this.grid?.perBody, [name]: { ...this.grid?.perBody[name], visible } } });
    if (visible) this.layers.grid = true;
    return true;
  }
  showBodyGridLabels(name: string, labels: boolean): boolean {
    if (!this.known(name)) return false;
    this.grid = normalizeGridSettings({ ...this.grid, perBody: { ...this.grid?.perBody, [name]: { ...this.grid?.perBody[name], labels } } }); return true;
  }
  setGridScope(scope: GridSettings['scope'], names?: string): boolean {
    this.grid = normalizeGridSettings({ ...this.grid, scope, bodies: (names ?? '').split(',').filter(Boolean), perBody: {} }); return true;
  }
  setGridDensity(density: GridSettings['density'], spacingDeg?: number): boolean {
    this.grid = normalizeGridSettings({ ...this.grid, density, spacingDeg }); return true;
  }
  setGridOpacity(opacity: number): boolean { this.grid = normalizeGridSettings({ ...this.grid, opacity }); return true; }
  setGridLabels(labels: boolean): boolean { this.grid = normalizeGridSettings({ ...this.grid, labels }); return true; }
  setGridMinorLines(minorLines: boolean): boolean { this.grid = normalizeGridSettings({ ...this.grid, minorLines }); return true; }
  setGridCoordinateFrame(coordinateFrame: boolean): boolean { this.grid = normalizeGridSettings({ ...this.grid, coordinateFrame }); return true; }

  setLayer(layer: string, on: boolean): boolean {
    this.log('setLayer', layer, on);
    if (!(layer in this.layers)) return false;
    this.layers[layer] = on;
    return this.ok(true);
  }

  setFov(deg: number): boolean {
    this.log('setFov', deg);
    this.camera = { ...this.camera, fov: deg };
    return this.ok(true);
  }

  setCamera(position: ScriptVec3, target?: ScriptVec3, up?: ScriptVec3): boolean {
    this.log('setCamera', position, target, up);
    this.camera = {
      ...this.camera,
      position,
      target: target ?? [0, 0, 0],
      up: up ?? this.camera.up,
    };
    return this.ok(true);
  }

  circleCenter(direction: CircleDirection, degrees: number, opts?: { seconds?: number }): boolean {
    this.log('circleCenter', direction, degrees, opts?.seconds);
    // CameraController._rotateAboutTarget: right/left about up, up/down about view right.
    const { position: p, target: t, up: u } = this.camera;
    const o: ScriptVec3 = [p[0] - t[0], p[1] - t[1], p[2] - t[2]];
    const n = (a: ScriptVec3): ScriptVec3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
    const cross = (a: ScriptVec3, b: ScriptVec3): ScriptVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const rotate = (v: ScriptVec3, k: ScriptVec3, a: number): ScriptVec3 => {
      const c = Math.cos(a), s = Math.sin(a), d = v[0] * k[0] + v[1] * k[1] + v[2] * k[2], x = cross(k, v);
      return [0, 1, 2].map(i => v[i] * c + x[i] * s + k[i] * d * (1 - c)) as unknown as ScriptVec3;
    };
    const radians = (direction === 'right' || direction === 'up' ? 1 : -1) * degrees * Math.PI / 180;
    const horizontal = direction === 'right' || direction === 'left';
    const axis = horizontal ? n(u) : n(cross([-o[0], -o[1], -o[2]], u));
    const angle = horizontal ? radians : -radians;
    const moved = rotate(o, axis, angle);
    this.camera = { ...this.camera, position: [t[0] + moved[0], t[1] + moved[1], t[2] + moved[2]], up: horizontal ? u : n(rotate(u, axis, angle)) };
    return this.ok(true);
  }

  dolly(km: number, opts?: { seconds?: number }): boolean {
    this.log('dolly', km, opts?.seconds);
    const { position: p, target: t } = this.camera, d = Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
    const k = Math.max(1e-6, d + km) / d;
    this.camera = { ...this.camera, position: [t[0] + (p[0] - t[0]) * k, t[1] + (p[1] - t[1]) * k, t[2] + (p[2] - t[2]) * k] };
    return this.ok(true);
  }

  crane(km: number, opts?: { seconds?: number }): boolean {
    this.log('crane', km, opts?.seconds);
    return this.ok(true);
  }

  setTime(when: ScriptTime): boolean {
    this.log('setTime', when);
    if (when.kind === 'et') {
      this.time = when.et;
      this.timeText = undefined;
      return this.ok(true);
    }
    if (Number.isNaN(Date.parse(when.text))) return false;
    this.time = etFromCalendarString(when.text);
    this.timeText = when.text;
    return this.ok(true);
  }

  setTimeRate(x: number): boolean {
    this.log('setTimeRate', x);
    this.rate = x;
    return this.ok(true);
  }

  setPlaying(on: boolean): boolean {
    this.log('setPlaying', on);
    this.playing = on;
    return this.ok(true);
  }

  runTo(seconds: number): boolean {
    this.log('runTo', seconds);
    this.time += seconds;
    return this.ok(true);
  }

  async wait(seconds: number): Promise<void> {
    this.log('wait', seconds);
    await Promise.resolve();
  }

  displayNote(text: string, seconds?: number): void {
    this.log('displayNote', text, seconds);
    this.note = text;
  }

  screenshot(label?: string): ScriptImage {
    this.log('screenshot', label);
    this.shots++;
    return { dataUrl: `data:image/png;base64,shot${this.shots}`, label };
  }

  record(on: boolean): boolean {
    this.log('record', on);
    this.recording = on;
    return true;
  }

  // ── Read ──

  getTime(): number {
    return this.time;
  }
  getRate(): number {
    return this.rate;
  }
  isPlaying(): boolean {
    return this.playing;
  }
  getSelected(): string | null {
    return this.selected;
  }
  getTracked(): string | null {
    return this.tracked;
  }
  getCamera(): ScriptCamera {
    return this.camera;
  }

  /** World positions (km) and measured radii for `getViewComposition`; empty means none drawn. */
  bodies: Record<string, { position: ScriptVec3; radiusKm: number | null }> = {};
  aspect = 16 / 9;

  /** The same projection the viewer reports: pinhole camera looking at `camera.target`. */
  getViewComposition(names: readonly string[]): import('../contracts.js').ScriptViewComposition {
    const sub = (a: ScriptVec3, b: ScriptVec3): ScriptVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dot = (a: ScriptVec3, b: ScriptVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a: ScriptVec3, b: ScriptVec3): ScriptVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const unit = (a: ScriptVec3): ScriptVec3 => { const n = Math.hypot(...a); return [a[0] / n, a[1] / n, a[2] / n]; };
    const { position: eye, target, fov } = this.camera;
    const forward = unit(sub(target, eye)), right = unit(cross(forward, this.camera.up)), up = cross(right, forward);
    const deg = (r: number) => r * 180 / Math.PI;
    const tanV = Math.tan(fov * Math.PI / 360), tanH = tanV * this.aspect;
    const angular = (name: string) => {
      const b = this.bodies[name];
      const rel = sub(b.position, eye), range = Math.hypot(...rel);
      return { b, rel, range, ang: b.radiusKm ? Math.asin(Math.min(1, b.radiusKm / range)) : 0 };
    };
    const objects = names.map(object => {
      // A scene object with no configured geometry sits at the centre of the view, distance unknown.
      if (!this.bodies[object] && this.objects.includes(object)) return { object, available: true, drawEnabled: !this.hidden.has(object), rangeKm: null, radiusKm: null, angularRadiusDeg: null, bearingDeg: [0, 0] as const, ndc: [0, 0] as const, inView: true, occlusion: null };
      if (!this.bodies[object]) return { object, available: false, drawEnabled: false, rangeKm: null, radiusKm: null, angularRadiusDeg: null, bearingDeg: null, ndc: null, inView: false, occlusion: null };
      const { b, rel, range, ang } = angular(object);
      const x = dot(rel, right), y = dot(rel, up), z = dot(rel, forward);
      const ndc = z > 0 ? [x / z / tanH, y / z / tanV] as const : null;
      let occlusion: { by: string; kind: 'partial' | 'full' } | null = null;
      for (const other of Object.keys(this.bodies)) {
        if (other === object || !this.bodies[other].radiusKm) continue;
        const o = angular(other);
        if (o.range >= range) continue;
        const sep = Math.acos(Math.max(-1, Math.min(1, dot(unit(o.rel), unit(rel)))));
        if (sep < o.ang && (!occlusion || o.range < angular(occlusion.by).range)) occlusion = { by: other, kind: sep + ang <= o.ang ? 'full' : 'partial' };
      }
      return { object, available: true, drawEnabled: !this.hidden.has(object), rangeKm: range, radiusKm: b.radiusKm, angularRadiusDeg: deg(ang),
        bearingDeg: [deg(Math.atan2(x, z)), deg(Math.atan2(y, Math.hypot(x, z)))] as const, ndc,
        inView: !!ndc && Math.abs(ndc[0]) <= 1 && Math.abs(ndc[1]) <= 1, occlusion };
    });
    return { scene: this.scene?.id ?? null, et: this.time, playing: this.playing, tracked: this.tracked,
      orbitDistanceKm: Math.hypot(...sub(eye, target)), fovDeg: fov, aspect: this.aspect, objects };
  }
  listObjects(): readonly string[] {
    return this.objects;
  }
  listViewpoints(): readonly string[] {
    return this.viewpoints;
  }

  snapshotState(): ViewerSnapshotState {
    return {
      time: this.time,
      timeText: this.timeText,
      rate: this.rate,
      playing: this.playing,
      selected: this.selected,
      tracked: this.tracked,
      lookAt: this.lookAt,
      frame: this.frame,
      camera: this.camera,
      ...(this.grid ? { grid: this.grid } : {}),
      layers: { ...this.layers },
      note: this.note,
      ...(this.measurements.length ? { measurements: { version: 1 as const, items: this.listMeasurements(), ...(this.selectedMeasurement ? { selected: this.selectedMeasurement } : {}) } } : {}),
    };
  }

  snapshot(): string {
    return snapshotScript(this.snapshotState());
  }

  on<K extends ScriptEventName>(event: K, cb: (data: ScriptEventMap[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as (data: never) => void);
    return () => void set.delete(cb as (data: never) => void);
  }

  emit<K extends ScriptEventName>(event: K, data: ScriptEventMap[K]): void {
    for (const cb of this.listeners.get(event) ?? []) (cb as (d: ScriptEventMap[K]) => void)(data);
  }
}
