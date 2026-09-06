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
  ScriptCamera,
  ScriptEventMap,
  ScriptEventName,
  ScriptImage,
  ScriptTime,
  ScriptVec3,
  ViewerControl,
  ViewerSnapshotState,
} from '../contracts.js';

export interface FakeOptions {
  /** Resolve every write on the next microtask, to prove ordering holds. */
  async?: boolean;
}

export class FakeViewer implements ViewerControl {
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
