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
  listActivities() { return []; }
  getActivity(_id: string) { return undefined; }
  selectActivity(_id: string) { return false; }
  seekActivity(_id: string, _edge?: 'start' | 'end') { return false; }
  navigateActivity(_direction: 'previous' | 'next') { return false; }

  scene: ScriptScene | null = { id: 1, catalog: 'Cassini', ready: true };
  getScene() { return this.scene; }

  places: ScriptPlace[] = [
    {
      ref: '["titan-names","42"]', name: 'Kraken Mare', body: 'Titan', layer: { id: 'titan-names', name: 'Titan nomenclature' },
      feature: '42', kind: 'Mare, maria', origin: 'nomenclature', latitude: 68, longitude: 310, diameterKm: 1170,
      source: { kind: 'catalog', identity: 'https://example.test/titan-names.geojson' }, unavailable: null,
    },
    {
      ref: '["titan-names","43"]', name: 'Ligeia Mare', body: 'Titan', layer: { id: 'titan-names', name: 'Titan nomenclature' },
      feature: '43', kind: 'Mare, maria', origin: 'nomenclature', latitude: 79, longitude: 248,
      source: { kind: 'catalog', identity: 'https://example.test/titan-names.geojson' }, unavailable: 'frame mismatch',
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
          bounds: null, resolutionMeters: 4000, source: { type: 'xyz', endpoint: 'https://tiles.example/iss/{z}/{x}/{y}.png', layer: null, tileMatrixSet: null }, status: 'ok', view: null },
        { id: 'radar', name: 'RADAR SAR', attribution: 'JPL', description: 'Cassini RADAR swaths', role: 'overlay', optional: true, visible: false,
          opacity: 1, bounds: [-180, 60, 180, 90], resolutionMeters: 300, source: { type: 'wms', endpoint: 'https://wms.example/radar', layer: 'RADAR_SAR', tileMatrixSet: null }, status: 'idle', view: null },
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

  setObjectVisible(name: string, visible: boolean): boolean {
    this.log('setObjectVisible', name, visible);
    return this.ok(this.known(name));
  }

  showTrajectory(name: string, visible: boolean): boolean {
    this.log('showTrajectory', name, visible);
    return this.ok(this.known(name));
  }

  showLabel(name: string, visible: boolean): boolean {
    this.log('showLabel', name, visible);
    return this.ok(this.known(name));
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
    return this.ok(true);
  }

  dolly(km: number, opts?: { seconds?: number }): boolean {
    this.log('dolly', km, opts?.seconds);
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
    const ms = Date.parse(when.text);
    if (Number.isNaN(ms)) return false;
    this.time = ms / 1000;
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
