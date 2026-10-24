/**
 * Footprints on the target surface for Cosmographia `"Observations"` items
 * (issue #28, Phase 2).
 *
 * The observation item is a body on its **target** (`center`, with body-fixed
 * trajectory and body frames), which is how its footprints pin to the surface:
 * everything here is drawn in the target's body-fixed frame and carried by the
 * target's orientation, so a footprint stays on the ground it was taken of as
 * the planet turns.
 *
 * `loadItem` spreads `item.geometry` into `Body.geometryData` verbatim, the
 * path SensorFrustum reads, and this parses it with core's
 * `observationFromCosmographia` — the same model an archive record or a sensor
 * `active` window becomes (the renderer draws those through
 * `createVisualForObservation`). Coverage decides what is drawn:
 *
 *  - `sensor` — computed: IK boundary rays intersected with the target through
 *    CSPICE (`computeFootprint`), with the target's surface method (ellipsoid,
 *    or a DSK — `resolveSurfaceMethod`), at the instants `groupSampling`
 *    indexes from each group's `obsRate`. A group with `obsRate: 0` is a
 *    continuous swath: adjacent footprints are joined edge to edge, and a
 *    sample that could not be computed (no CK, off the body) is a gap in it.
 *    Each group advances a cursor under a shared per-frame budget (count and
 *    time), so a gap is tried once and stepped over, and a long window is
 *    never enumerated. Geometry has a budget too (`MAX_FILL_VERTICES`,
 *    `MAX_LINE_VERTICES`): fills are subdivided only as far as the surface
 *    needs, a swath is filled by its strips with fans only at run ends, and a
 *    swath still over budget is drawn at a stride. The leading edge between
 *    grid samples is its own small mesh, cached by ET, so a paused clock does
 *    no work and a moving one rebuilds only that.
 *  - `footprint` — given (ODE): the archive's lon/lat polygons, holes kept,
 *    on the target's reference ellipsoid.
 *  - `disk` — given (OPUS): a marker at the archive's sub-observer point.
 *
 * Contextual by default: an observation is drawn while the clock is inside one
 * of its groups (`observationActiveAt` — not the gaps between disjoint groups),
 * showing everything it has taken so far, and hidden otherwise unless focused
 * (`setFocus`, the selection) or `setShowAll` is on. A catalog item that
 * declares its own `startTime`/`endTime` is the one explicit exception: it is
 * shown through that window, gaps included — how a campaign of instantaneous
 * frames (the Cassini demo) stays visible between frames.
 *
 * `fillInObservations` is filled *or* outlined, as in Cosmographia. Not yet
 * honoured: `showResWithColor` (needs per-footprint resolution colouring) and
 * `shadowVolumeScaleFactor` (Cosmographia's occlusion volume).
 */

import * as THREE from 'three';
import {
  bodyFixedFrameName,
  catalogTimeParser,
  footprintFromFov,
  footprintGeometryProviderOf,
  groupSampling,
  lonLatToBodyFixed,
  observationActiveAt,
  observationFromCosmographia,
  resolveSurfaceMethod,
  type Body,
  type Footprint,
  type FootprintGeometryProvider,
  type GroupSampling,
  type LonLat,
  type Observation,
  type Vec3,
} from '@cosmolabe/core';
import type { BodyVisualizer } from './BodyVisualizer.js';
import type { RendererContext } from './RendererContext.js';

/** Radial lift off the surface, as a fraction of the radius: enough to clear
 *  the globe under logarithmic depth without visibly floating. */
const LIFT = 1.002;
/** Most new footprints computed per frame, across every observation, so a long
 *  swath fills in over a few frames instead of stalling one... */
const FOOTPRINTS_PER_FRAME = 24;
/** ...and at most this much wall-clock time per frame spent computing them,
 *  whichever comes first (a footprint is dozens of CSPICE calls). */
const FOOTPRINT_MS_PER_FRAME = 4;
/**
 * Geometry budget per observation, in vertices (position triples, Float32):
 * ~18 MB of fill and ~5 MB of outline at most, however many samples a group
 * has. A build that would exceed it is redone with every k-th sample drawn
 * (`stride`) — a coarser but still gap-honest swath — rather than allocated.
 */
export const MAX_FILL_VERTICES = 1_500_000;
export const MAX_LINE_VERTICES = 400_000;
/** While footprints are still arriving, rebuild the settled mesh at most this
 *  often — or, for a big swath, at most every 10× its last build time, so
 *  rebuilding stays a small share of the work. A finished set is rebuilt at
 *  once. */
const REBUILD_INTERVAL_MS = 200;

type Fov = ReturnType<FootprintGeometryProvider['getfov']>;

interface SensorSource {
  provider: FootprintGeometryProvider;
  fov: Fov;
  instrumentId: number;
  observer: string;
  fixref: string;
  method: string;
}

/**
 * One group's progress through its samples. `prints[i]` is sample i's
 * footprint, `null` when it could not be computed (no CK, no intercept) —
 * cached like a success, so a gap is tried once and then stepped over rather
 * than retried every frame. `cursor` is the next sample to compute: it only
 * moves forward, so the per-frame budget is always spent on new samples.
 */
interface GroupProgress {
  sampling: GroupSampling;
  swath: boolean;
  prints: (Footprint | null)[];
  cursor: number;
}

interface ObservationState {
  obs: Observation | null;
  sensor: SensorSource | null;
  groups: GroupProgress[];
  /** First start over the groups: nothing is drawn before it. */
  firstStart: number;
  /** The catalog item declares its own existence window (`startTime` /
   *  `endTime`): it stays drawn through it, between groups included — the
   *  catalog saying how long the observation is shown. Without one, it is
   *  drawn only while a group is in progress. */
  persists: boolean;
  /** What the settled mesh was built from, to skip rebuilding an unchanged one. */
  signature: string;
  /** Sample stride the settled mesh is drawn at; grows past the budget. */
  stride: number;
  /** Wall clock (ms) of the last settled rebuild, and how long it took, for
   *  throttling. */
  builtAt: number;
  buildMs: number;
  /** The swath's leading edge: the footprint at the clock between grid
   *  samples, cached by ET so a paused clock costs no SPICE calls. */
  leading: { gi: number; et: number; fp: Footprint | null } | null;
  /** What the leading mesh was built from. */
  leadingSignature: string;
  fill: THREE.Mesh;
  outline: THREE.LineSegments;
  /** The leading edge's own small meshes, rebuilt per clock step without
   *  touching the settled swath. */
  leadFill: THREE.Mesh;
  leadOutline: THREE.LineSegments;
}

function strToEt(ctx: RendererContext): ((s: string) => number) | undefined {
  const spice = ctx.universe.spiceInstance;
  return spice ? (s) => spice.str2et(s) : undefined;
}

/** A body's name as SPICE should read it: its NAIF ID when the catalog knows one. */
function spiceName(body: Body | undefined, fallback: string): string {
  return body?.naifId != null ? String(body.naifId) : fallback;
}

export interface ObservationsVisualizerOptions {
  /** Fill vertices per observation before it is drawn at a stride. */
  maxFillVertices?: number;
  /** Outline vertices per observation before it is drawn at a stride. */
  maxLineVertices?: number;
}

export class ObservationsVisualizer implements BodyVisualizer {
  readonly geometryType = 'Observations';
  private readonly maxFill: number;
  private readonly maxLine: number;
  private deadline = Infinity;

  constructor(options: ObservationsVisualizerOptions = {}) {
    this.maxFill = options.maxFillVertices ?? MAX_FILL_VERTICES;
    this.maxLine = options.maxLineVertices ?? MAX_LINE_VERTICES;
  }

  private readonly warned = new Set<string>();
  private readonly focus = new Set<string>();
  private showAll = false;
  /** Shared across every observation this visualizer draws, per frame. A
   *  frame is detected by an object coming round again — not by the clock
   *  moving, which with the clock paused would never refill it. */
  private budget = FOOTPRINTS_PER_FRAME;
  private readonly updatedThisFrame = new Set<THREE.Object3D>();

  /**
   * Observations shown regardless of the clock — the selected ones. By default
   * an observation is contextual: drawn while the clock is inside its own
   * window (accumulating as it goes), and gone outside it, so a scene with
   * hundreds of observations shows the ones that are happening rather than
   * every footprint ever taken.
   */
  setFocus(names: Iterable<string>): void {
    this.focus.clear();
    for (const n of names) this.focus.add(n);
  }

  /** Show every observation's footprints up to the clock, not just the
   *  active and focused ones. */
  setShowAll(on: boolean): void {
    this.showAll = on;
  }

  get showingAll(): boolean {
    return this.showAll;
  }

  createVisual(body: Body, ctx: RendererContext): THREE.Object3D {
    const geo = (body.geometryData ?? {}) as Record<string, unknown>;
    let obs: Observation | null = null;
    try {
      obs = observationFromCosmographia(body.name, body.parentName ?? '', geo, catalogTimeParser(strToEt(ctx)));
    } catch (err) {
      this.warnOnce(body.name, (err as Error).message);
    }
    const visual = this.createVisualForObservation(obs, ctx, body.name);
    (visual.userData.observation as ObservationState).persists =
      body.existsFrom !== undefined || body.existsUntil !== undefined;
    return visual;
  }

  /**
   * The visual for an Observation that did not come from an `Observations`
   * item — a sensor's `active` windows — through exactly the same path.
   */
  createVisualForObservation(obs: Observation | null, ctx: RendererContext, name = obs?.name ?? 'observation'): THREE.Object3D {
    const group = new THREE.Group();
    group.name = `${name}_observations`;

    const color = obs?.footprintColor
      ? new THREE.Color(obs.footprintColor[0], obs.footprintColor[1], obs.footprintColor[2])
      : new THREE.Color(1, 0.6, 0.1);
    const opacity = obs?.footprintOpacity ?? 0.5;
    const filled = obs?.fillInObservations === true;
    // Filled *or* outlined, as in Cosmographia — never both. The fill mesh is
    // built either way: it is what a click on the footprint hits.
    const fill = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, visible: filled }),
    );
    const outline = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, opacity * 1.6) }),
    );
    outline.visible = !filled;
    const leadFill = new THREE.Mesh(new THREE.BufferGeometry(), fill.material);
    const leadOutline = new THREE.LineSegments(new THREE.BufferGeometry(), outline.material);
    leadOutline.visible = !filled;
    for (const m of [fill, outline, leadFill, leadOutline]) m.frustumCulled = false;
    group.add(fill, outline, leadFill, leadOutline);

    const sensor = obs?.coverage.kind === 'sensor' ? this.resolveSensor(obs, obs.coverage.sensor, ctx) : null;
    let groups: GroupProgress[] = [];
    if (obs && sensor) {
      try {
        groups = obs.groups.map((g) => {
          const sampling = groupSampling(g, obs.alongTrackDivisions ?? 100);
          if (sampling.thinned) {
            this.warnOnce(obs.name, `a group of ${g.endEt - g.startEt} s at obsRate ${g.obsRate} is drawn as ${sampling.count} evenly spaced footprints.`, 'thinned');
          }
          return { sampling, swath: g.obsRate === 0, prints: [], cursor: 0 };
        });
      } catch (err) {
        this.warnOnce(obs.name, (err as Error).message);
      }
    }
    const state: ObservationState = {
      obs,
      sensor,
      groups,
      firstStart: obs?.groups.length ? Math.min(...obs.groups.map((g) => g.startEt)) : Infinity,
      persists: false,
      signature: '',
      stride: 1,
      builtAt: -Infinity,
      buildMs: 0,
      leading: null,
      leadingSignature: '',
      fill,
      outline,
      leadFill,
      leadOutline,
    };
    group.userData.observation = state;
    group.userData.observationName = name;
    return group;
  }

  updateVisual(object: THREE.Object3D, _body: Body, et: number, _pos: [number, number, number], ctx: RendererContext): void {
    this.updateObservation(object, et, ctx);
  }

  /** Per-frame update for any visual this visualizer created. */
  updateObservation(object: THREE.Object3D, et: number, ctx: RendererContext): void {
    const state = object.userData.observation as ObservationState | undefined;
    const obs = state?.obs;
    if (!state || !obs) return;
    if (this.updatedThisFrame.has(object) || this.updatedThisFrame.size === 0) {
      this.updatedThisFrame.clear();
      this.budget = FOOTPRINTS_PER_FRAME;
      this.deadline = performance.now() + FOOTPRINT_MS_PER_FRAME;
    }
    this.updatedThisFrame.add(object);

    const name = object.userData.observationName as string;
    // Contextual: drawn while one of its own groups is in progress — not in
    // the gaps between disjoint groups — unless its catalog item declares how
    // long it is shown (`persists`; the renderer hides it outside that window).
    // Once begun, focus or show-all keep it too. What is drawn is everything
    // it has taken up to the clock.
    const active = observationActiveAt(obs, et);
    const begun = et >= state.firstStart;
    const contextual = active || (begun && (state.persists || this.showAll || this.focus.has(name)));
    // Pin to the target: its scene position and its body-fixed orientation.
    const targetMesh = ctx.getBodyMesh(obs.target);
    const q = contextual ? ctx.universe.bodyToWorldQuat(obs.target, et) : undefined;
    if (!contextual || !targetMesh || !q) {
      object.visible = false;
      return;
    }
    object.position.copy(targetMesh.position);
    object.quaternion.set(q[1], q[2], q[3], q[0]);
    object.scale.setScalar(ctx.scaleFactor);

    if (obs.coverage.kind === 'sensor') {
      object.visible = this.updateSensorGeometry(state, obs, et);
      return;
    }
    object.visible = true;
    if (state.signature === 'given') return;
    state.signature = 'given';
    const lines = new VertexBuffer(this.maxLine);
    const tris = new VertexBuffer(this.maxFill);
    this.givenGeometry(obs, ctx, lines, tris);
    lines.writeTo(state.outline.geometry);
    tris.writeTo(state.fill.geometry);
  }

  /** A focused (selected) observation, or every one under show-all, stays
   *  drawn past its catalog item's existence window. */
  showsWhenAbsent(object: THREE.Object3D): boolean {
    const name = object.userData.observationName as string | undefined;
    return this.showAll || (name !== undefined && this.focus.has(name));
  }

  /** What a click should hit: the footprint fill, drawn or not. Lines are left
   *  out — a raycaster's line threshold is in world units, and at the scene's
   *  scale it would catch every click. */
  pickTargets(object: THREE.Object3D): THREE.Object3D[] {
    const state = object.userData.observation as ObservationState | undefined;
    return state && object.visible ? [state.fill] : [];
  }

  dispose(object: THREE.Object3D): void {
    this.updatedThisFrame.delete(object);
    const state = object.userData.observation as ObservationState | undefined;
    if (!state) return;
    for (const m of [state.fill, state.outline, state.leadFill, state.leadOutline]) m.geometry.dispose();
    for (const m of [state.fill, state.outline]) (m.material as THREE.Material).dispose();
  }

  // ── sensor coverage ──────────────────────────────────────────────────────

  private resolveSensor(obs: Observation, sensorName: string, ctx: RendererContext): SensorSource | null {
    const sensor = ctx.universe.getBody(sensorName);
    const spiceId = sensor?.geometryData?.spiceId;
    if (!sensor || typeof spiceId !== 'number') {
      this.warnOnce(obs.name, `sensor "${sensorName}" is not a Sensor body with a spiceId; no footprints are computed.`);
      return null;
    }
    const provider = footprintGeometryProviderOf(ctx.universe.spiceInstance);
    if (!provider) {
      this.warnOnce(obs.name, 'footprints need a SPICE engine with getfov/sincpt/ilumin; none is loaded.');
      return null;
    }
    let fov: Fov;
    try {
      fov = provider.getfov(spiceId);
    } catch (err) {
      this.warnOnce(obs.name, `no FOV for instrument ${spiceId} (is its IK furnished?): ${(err as Error).message}`);
      return null;
    }
    // The observer is the spacecraft carrying the sensor.
    const craftName = sensor.parentName ?? sensorName;
    const target = ctx.universe.getBody(obs.target);
    return {
      provider,
      fov,
      instrumentId: spiceId,
      observer: spiceName(ctx.universe.getBody(craftName), craftName),
      // The frame the target is drawn in: its SPICE rotation's own frame when
      // it has one (MU69_FIXED for Arrokoth), else the IAU frame by name.
      fixref: (target?.rotation as { bodyFixedFrame?: string } | undefined)?.bodyFixedFrame ?? bodyFixedFrameName(obs.target),
      // An irregular target (a DSK) is a declaration on the target or the
      // observation, resolved here for every observation alike.
      method: resolveSurfaceMethod(obs, target?.geometryData),
    };
  }

  /**
   * Sensor footprints up to `et`: advance each group's cursor under the frame
   * budget, rebuild the settled mesh when what is drawn changed (throttled
   * while samples are still arriving), and the leading edge's small mesh when
   * the clock moved. Returns whether there is anything to draw.
   */
  private updateSensorGeometry(state: ObservationState, obs: Observation, et: number): boolean {
    const src = state.sensor;
    if (!src) return false;
    const counts: number[] = [];
    let pending = false;
    for (const progress of state.groups) {
      const reached = progress.sampling.reached(et);
      // Advance the cursor through reached samples; failures are stored as
      // gaps and never retried.
      while (progress.cursor < reached && this.canCompute()) {
        this.budget--;
        progress.prints[progress.cursor] = this.footprintAt(src, obs, progress.sampling.at(progress.cursor));
        progress.cursor++;
      }
      if (progress.cursor < reached) pending = true;
      counts.push(Math.min(progress.cursor, reached));
    }

    const signature = counts.join(',');
    const now = performance.now();
    const shrank = signature !== state.signature && counts.some((n, i) => n < (Number(state.signature.split(',')[i]) || 0));
    const interval = Math.max(REBUILD_INTERVAL_MS, 10 * state.buildMs);
    if (signature !== state.signature && (!pending || shrank || now - state.builtAt >= interval)) {
      this.buildSettled(state, counts);
      state.signature = signature;
      state.builtAt = performance.now();
      state.buildMs = state.builtAt - now;
    }
    this.updateLeading(state, obs, et, counts);
    return counts.some((n) => n > 0);
  }

  /** Whether this frame's footprint budget (count and time) has room. */
  private canCompute(): boolean {
    return this.budget > 0 && performance.now() < this.deadline;
  }

  /** The settled swath, at the smallest stride that fits the budget. */
  private buildSettled(state: ObservationState, counts: number[]): void {
    for (;;) {
      const lines = new VertexBuffer(this.maxLine);
      const tris = new VertexBuffer(this.maxFill);
      const total = counts.reduce((sum, n) => sum + drawnCount(n, state.stride), 0);
      let done = 0;
      for (let gi = 0; gi < state.groups.length && !lines.overflowed && !tris.overflowed; gi++) {
        done += addGroup(state.groups[gi]!, counts[gi]!, state.stride, lines, tris);
      }
      if (!lines.overflowed && !tris.overflowed) {
        lines.writeTo(state.outline.geometry);
        tris.writeTo(state.fill.geometry);
        return;
      }
      // Over budget, found partway through: the build stopped there, and the
      // share of samples it reached says how much coarser to draw. Every k-th
      // sample then, and say so once.
      const over = total / Math.max(1, done);
      state.stride = Math.max(state.stride + 1, Math.ceil(state.stride * over * 1.1));
      this.warnOnce(
        state.obs!.name,
        `its footprints exceed the geometry budget; drawing every ${state.stride}th sample.`,
        'stride',
      );
    }
  }

  /** The leading edge of each in-progress swath group, cached by ET. */
  private updateLeading(state: ObservationState, obs: Observation, et: number, counts: number[]): void {
    const src = state.sensor!;
    let key = '';
    let lead: { gi: number; fp: Footprint; from: Footprint } | null = null;
    for (let gi = 0; gi < state.groups.length && !lead; gi++) {
      const progress = state.groups[gi]!;
      const group = obs.groups[gi]!;
      const n = counts[gi]!;
      const last = n > 0 ? progress.prints[n - 1] : null;
      // Only once every reached sample is in, and only from an existing last
      // sample — never across a gap.
      if (!progress.swath || !last || n !== progress.sampling.reached(et) || !(et > group.startEt && et < group.endEt)) continue;
      if (et <= progress.sampling.at(n - 1)) continue;
      if (!(state.leading && state.leading.gi === gi && state.leading.et === et)) {
        if (!this.canCompute()) continue;
        this.budget--;
        state.leading = { gi, et, fp: this.footprintAt(src, obs, et) };
      }
      if (state.leading.fp) {
        lead = { gi, fp: state.leading.fp, from: last };
        key = `${gi}:${et}:${n}`;
      }
    }
    if (key === state.leadingSignature) return;
    state.leadingSignature = key;
    const lines = new VertexBuffer(this.maxLine);
    const tris = new VertexBuffer(this.maxFill);
    if (lead) {
      addFootprint(lead.fp, lines, tris);
      addSwathStrip(lead.from, lead.fp, tris);
    }
    lines.writeTo(state.leadOutline.geometry);
    tris.writeTo(state.leadFill.geometry);
  }

  private footprintAt(src: SensorSource, obs: Observation, et: number): Footprint | null {
    try {
      const fp = footprintFromFov(src.provider, src.fov, {
        instrumentId: src.instrumentId,
        target: obs.target,
        observer: src.observer,
        fixref: src.fixref,
        et,
        abcorr: 'LT+S',
        sideDivisions: obs.sideDivisions ?? 8,
        method: src.method,
      });
      // A frame that misses the target altogether is a gap too.
      return fp.boundary.some((p) => p !== null) || fp.boresight ? fp : null;
    } catch (err) {
      // Typically no CK at this instant: a gap in the swath, said once.
      this.warnOnce(obs.name, `no footprint at ET ${et.toFixed(1)} (and possibly others): ${(err as Error).message}`, 'gap');
      return null;
    }
  }

  // ── given coverage ───────────────────────────────────────────────────────

  private givenGeometry(obs: Observation, ctx: RendererContext, lines: VertexBuffer, tris: VertexBuffer): void {
    const radii = ctx.universe.getBody(obs.target)?.radii;
    if (!radii) {
      this.warnOnce(obs.name, `target "${obs.target}" has no radii; a given footprint has no surface to sit on.`);
      return;
    }
    const cov = obs.coverage;
    if (cov.kind === 'footprint') {
      cov.polygonLonLat.forEach((outer, i) => {
        addPolygon(outer, cov.holesLonLat?.[i] ?? [], radii, lines, tris);
      });
    } else if (cov.kind === 'disk') {
      // A small ring around the sub-observer point: where the camera looked
      // from, which is all disk geometry says about the surface.
      const [lat, lon] = cov.subObsLatLon;
      const r = Math.min(...radii) * 0.02;
      const ring: LonLat[] = [];
      for (let i = 0; i < 24; i++) {
        const a = (2 * Math.PI * i) / 24;
        const dLat = ((r * Math.sin(a)) / radii[2]) * (180 / Math.PI);
        const dLon = ((r * Math.cos(a)) / (radii[0] * Math.max(0.05, Math.cos((lat * Math.PI) / 180)))) * (180 / Math.PI);
        ring.push([lon + dLon, lat + dLat]);
      }
      addPolygon(ring, [], radii, lines, tris);
    }
  }

  /** Warn once per observation and `kind` (the message itself by default). */
  private warnOnce(name: string, message: string, kind: string = message): void {
    const key = `${name}\u0000${kind}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[Cosmolabe] observation "${name}": ${message}`);
  }
}

// ── geometry helpers (body-fixed km in, lifted off the surface) ─────────────

function lift(p: Vec3): Vec3 {
  return [p[0] * LIFT, p[1] * LIFT, p[2] * LIFT];
}

/**
 * A growable Float32 position buffer with a hard cap. Past the cap it stops
 * storing and only counts (`demand`), so an over-budget build costs a count,
 * not an allocation, and the caller can pick a stride that fits.
 */
class VertexBuffer {
  private data = new Float32Array(3 * 1024);
  count = 0;
  demand = 0;
  constructor(private readonly cap: number) {}
  get overflowed(): boolean {
    return this.demand > this.cap;
  }
  push(x: number, y: number, z: number): void {
    this.demand++;
    if (this.demand > this.cap) return;
    if (3 * this.count + 3 > this.data.length) {
      const next = new Float32Array(Math.min(this.data.length * 2, 3 * this.cap));
      next.set(this.data);
      this.data = next;
    }
    this.data[3 * this.count] = x;
    this.data[3 * this.count + 1] = y;
    this.data[3 * this.count + 2] = z;
    this.count++;
  }
  writeTo(geometry: THREE.BufferGeometry): void {
    geometry.setAttribute('position', new THREE.BufferAttribute(this.data.slice(0, 3 * this.count), 3));
    geometry.computeBoundingSphere();
  }
}

function push(out: VertexBuffer, ...pts: Vec3[]): void {
  for (const p of pts) {
    const q = lift(p);
    out.push(q[0], q[1], q[2]);
  }
}

/** Most steps per edge when a fill triangle is laid on the surface. */
const FILL_STEPS = 24;
/** Longest edge, as a fraction of the radius, laid flat without subdividing:
 *  an edge sags L²/8R ≤ 0.0003 R and a triangle's centre about twice that,
 *  both well under the LIFT. */
const FLAT_EDGE = 0.05;

/**
 * A surface triangle, subdivided and pushed back out to the surface: each
 * interior point takes the radius interpolated from its corners. A flat
 * triangle across a footprint is a chord, and on a Titan-sized body a NAC
 * frame's chord sinks tens of km under the ground — the fill vanished into
 * the globe while its outline stayed visible.
 */
function pushSurfaceTri(out: VertexBuffer, a: Vec3, b: Vec3, c: Vec3): void {
  const ra = Math.hypot(...a);
  const rb = Math.hypot(...b);
  const rc = Math.hypot(...c);
  // Subdivide only as much as the triangle's size needs: a NAC frame's fan
  // on Titan is a few steps, a frame's worth of swath strip usually one.
  const edge = Math.max(dist(a, b), dist(b, c), dist(c, a));
  const n = Math.min(FILL_STEPS, Math.max(1, Math.ceil(edge / (FLAT_EDGE * Math.min(ra, rb, rc)))));
  const at = (i: number, j: number): Vec3 => {
    const wb = i / n;
    const wc = j / n;
    const wa = 1 - wb - wc;
    const p: Vec3 = [
      wa * a[0] + wb * b[0] + wc * c[0],
      wa * a[1] + wb * b[1] + wc * c[1],
      wa * a[2] + wb * b[2] + wc * c[2],
    ];
    const len = Math.hypot(...p);
    const r = wa * ra + wb * rb + wc * rc;
    return len > 0 ? [(p[0] * r) / len, (p[1] * r) / len, (p[2] * r) / len] : p;
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n - i; j++) {
      push(out, at(i, j), at(i + 1, j), at(i, j + 1));
      if (j < n - i - 1) push(out, at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
}

const dist = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/**
 * One group's settled geometry, every `stride`-th sample (and the last).
 * Discrete footprints are each outlined and filled. A swath is outlined per
 * drawn sample and filled as strips between consecutive drawn samples, with a
 * fan only at each end of a contiguous run — the strips already sweep
 * everything between. Two drawn samples are joined only if every sample
 * between them exists: a gap is never bridged, at any stride.
 */
/** How many of a group's first `n` samples are drawn at `stride`. */
function drawnCount(n: number, stride: number): number {
  return n === 0 ? 0 : Math.ceil(n / stride) + ((n - 1) % stride === 0 ? 0 : 1);
}

/**
 * One group's settled geometry, every `stride`-th sample (and the last).
 * Discrete footprints are each outlined and filled. A swath is outlined per
 * drawn sample and filled as strips between consecutive drawn samples, with a
 * fan only at each end of a contiguous run — the strips already sweep
 * everything between. Two drawn samples are joined only if every sample
 * between them exists: a gap is never bridged, at any stride. Stops as soon
 * as either buffer overflows, and returns how many samples it drew.
 */
function addGroup(progress: GroupProgress, n: number, stride: number, lines: VertexBuffer, tris: VertexBuffer): number {
  const prints = progress.prints;
  const drawn: number[] = [];
  for (let i = 0; i < n; i += stride) drawn.push(i);
  if (n > 0 && drawn[drawn.length - 1] !== n - 1) drawn.push(n - 1);
  const joined = (a: number, b: number) => {
    for (let k = a; k <= b; k++) if (!prints[k]) return false;
    return true;
  };
  for (let d = 0; d < drawn.length; d++) {
    if (lines.overflowed || tris.overflowed) return d;
    const i = drawn[d]!;
    const fp = prints[i];
    if (!fp) continue;
    if (!progress.swath) {
      addFootprint(fp, lines, tris);
      continue;
    }
    const prev = d > 0 && joined(drawn[d - 1]!, i) ? prints[drawn[d - 1]!]! : null;
    const next = d < drawn.length - 1 && joined(i, drawn[d + 1]!);
    addFootprint(fp, lines, prev && next ? null : tris);
    if (prev) addSwathStrip(prev, fp, tris);
  }
  return drawn.length;
}

/** Outline and (with `tris`) fan fill of one footprint. Rays past the limb
 *  break the outline rather than bridging the gap with a chord. */
function addFootprint(fp: Footprint, lines: VertexBuffer, tris: VertexBuffer | null): void {
  const b = fp.boundary;
  const hits = b.filter((p): p is Vec3 => p !== null);
  if (hits.length < 2) return;
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    const q = b[(i + 1) % b.length];
    if (p && q) push(lines, p, q);
  }
  if (!tris) return;
  const centre = fp.boresight ?? centroid(hits);
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    const q = b[(i + 1) % b.length];
    if (p && q) pushSurfaceTri(tris, centre, p, q);
  }
}

/** The ground swept between two consecutive footprints: each boundary edge
 *  joined to its successor, so a continuous group fills in as a swath. */
function addSwathStrip(a: Footprint, b: Footprint, tris: VertexBuffer): void {
  const n = Math.min(a.boundary.length, b.boundary.length);
  for (let i = 0; i < n; i++) {
    const a0 = a.boundary[i];
    const a1 = a.boundary[(i + 1) % n];
    const b0 = b.boundary[i];
    const b1 = b.boundary[(i + 1) % n];
    if (a0 && a1 && b0 && b1) {
      pushSurfaceTri(tris, a0, a1, b1);
      pushSurfaceTri(tris, a0, b1, b0);
    }
  }
}

/** Drop WKT's repeated closing vertex. */
function openRing(ring: readonly LonLat[]): LonLat[] {
  const r = [...ring];
  if (r.length > 1 && r[0]![0] === r[r.length - 1]![0] && r[0]![1] === r[r.length - 1]![1]) r.pop();
  return r;
}

/**
 * A given lon/lat polygon with its holes: every ring outlined, and the area
 * between them filled — triangulated in a plane tangent at the polygon's
 * centre (longitudes unwrapped about it), then laid on the surface. A hole
 * stays a hole.
 */
function addPolygon(
  outerRing: readonly LonLat[],
  holeRings: readonly (readonly LonLat[])[],
  radii: Vec3,
  lines: VertexBuffer,
  tris: VertexBuffer,
): void {
  const outer = openRing(outerRing);
  const holes = holeRings.map(openRing).filter((h) => h.length >= 3);
  if (outer.length < 3) return;
  const [lon0, lat0] = meanLonLat(outer);
  const k = Math.cos((lat0 * Math.PI) / 180);
  const flat = ([lon, lat]: LonLat) => new THREE.Vector2((((lon - lon0 + 540) % 360) - 180) * k, lat - lat0);
  const surface = ([lon, lat]: LonLat) => lonLatToBodyFixed(lon, lat, radii);

  for (const ring of [outer, ...holes]) {
    for (let i = 0; i < ring.length; i++) push(lines, surface(ring[i]!), surface(ring[(i + 1) % ring.length]!));
  }
  const all = [outer, ...holes].flat();
  const faces = THREE.ShapeUtils.triangulateShape(outer.map(flat), holes.map((h) => h.map(flat)));
  for (const [a, b, c] of faces) pushSurfaceTri(tris, surface(all[a]!), surface(all[b]!), surface(all[c]!));
}

function centroid(pts: Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) {
    c[0] += p[0] / pts.length;
    c[1] += p[1] / pts.length;
    c[2] += p[2] / pts.length;
  }
  return c;
}

/** Mean of a ring's vertices in lon/lat, unwrapping across the ±180° seam. */
function meanLonLat(ring: readonly (readonly [number, number])[]): [number, number] {
  let x = 0;
  let y = 0;
  let lat = 0;
  for (const [lo, la] of ring) {
    x += Math.cos((lo * Math.PI) / 180);
    y += Math.sin((lo * Math.PI) / 180);
    lat += la;
  }
  return [(Math.atan2(y, x) * 180) / Math.PI, lat / ring.length];
}
