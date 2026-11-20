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
 *  - `footprint` — given (ODE, or a host's simulation): lon/lat polygons,
 *    holes kept. On a target with streamed cube-sphere terrain they are draped
 *    on that terrain (body-fixed ray queries, a couple of metres above it, re-
 *    draped as finer terrain arrives) and drawn relative to their own centre so
 *    metre-scale footprints keep their precision; elsewhere they lie on the
 *    reference ellipsoid. A `requestedRegion` (what the observation was asked to
 *    cover) is outlined apart from the footprints, never as one of them.
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
import type { BodyMesh } from '../BodyMesh.js';
import type { RendererContext } from './RendererContext.js';

/** Radial lift off the surface, as a fraction of the radius: enough to clear
 *  the globe under logarithmic depth without visibly floating. */
const LIFT = 1.002;
/** Draped (terrain) geometry sits this far above the surface it was placed on, km. */
const DRAPE_LIFT_KM = 0.002;
/** Longest straight outline step laid on terrain, km, and most steps per edge. */
const DRAPE_LINE_STEP_KM = 0.025;
const DRAPE_LINE_MAX_STEPS = 16;
/** Longest fill-triangle edge laid on terrain, km, and most steps per edge. */
const DRAPE_FILL_STEP_KM = 0.08;
const DRAPE_FILL_MAX_STEPS = 6;
/** An outlined (unfilled) footprint's fill is only what a click hits: coarser. */
const DRAPE_PICK_FILL_MAX_STEPS = 2;
/**
 * Most terrain rays one build casts. Vertices past it sit on the reference
 * shape until the next build (soon after) places them, so a large footprint
 * set drapes over a few frames instead of stalling one.
 */
const DRAPE_RAYS_PER_BUILD = 120;
/** While vertices are still waiting for rays (budget or unloaded terrain), rebuild this often. */
const DRAPE_PENDING_MS = 250;
/**
 * Footprint depth is pulled toward the camera by this fraction of its distance
 * (screen position unchanged): draped on the finest physical terrain, a
 * footprint would otherwise sink under a coarser rendered LOD, whose error
 * grows with distance as this does.
 */
export const DEPTH_PULL = 0.004;
/** Re-drape at most this often while finer terrain keeps arriving. */
const DRAPE_REBUILD_MS = 1000;
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
  /** Drawn whatever the clock (a host's current selection), not contextually. */
  always: boolean;
  /** Given coverage: fill triangle → polygon index, for picking one footprint. */
  triangleOwner: Int32Array;
  /** Given coverage: each polygon's outline vertex range, for the highlight. */
  lineRanges: { start: number; count: number }[];
  /** Given coverage: each polygon's centre (mesh-local), to tell overlapping footprints apart when picking. */
  centers: THREE.Vector3[];
  /** The requested region's outline, and its invisible fill (what a click hits). */
  regionOutline: THREE.LineSegments;
  regionFill: THREE.Mesh;
  /** The emphasized footprint (a polygon index), or the region. */
  highlight: THREE.LineSegments;
  selected: number | 'region' | null;
  /** How the given geometry was placed: draped on terrain, partly, or on the reference shape. */
  placement: 'terrain' | 'partial-terrain' | 'reference';
  /** Draped vertices by direction, kept across builds: only unsettled ones are cast again. */
  drapeMemo: Map<string, { p: Vec3; settled: boolean; cast?: boolean; onTerrain?: boolean }>;
  /** Vertices of the last build not yet on sufficiently detailed terrain (budget, unloaded or coarse). */
  drapePending: number;
  /** The last build ran out of rays before every vertex had one. */
  drapeMore: boolean;
  /** Terrain revision of the last build: coarse vertices are cast again only when it changes. */
  drapeRevision: number | null;
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
  createVisualForObservation(
    obs: Observation | null, ctx: RendererContext, name = obs?.name ?? 'observation', options: { always?: boolean } = {},
  ): THREE.Object3D {
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
    // The requested region: yellow outline, never filled (it is not coverage).
    const regionOutline = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: new THREE.Color(1, 0.82, 0.1), transparent: true, opacity: 0.95 }),
    );
    const regionFill = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, depthWrite: false, visible: false }),
    );
    const highlight = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthTest: false }),
    );
    highlight.renderOrder = 3;
    for (const m of [fill, outline, leadFill, leadOutline, regionOutline, regionFill, highlight]) m.frustumCulled = false;
    for (const m of [fill, outline, regionOutline, highlight]) pullDepth(m.material as THREE.Material);
    group.add(fill, outline, leadFill, leadOutline, regionOutline, regionFill, highlight);

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
      always: options.always === true,
      triangleOwner: new Int32Array(0),
      lineRanges: [],
      centers: [],
      regionOutline,
      regionFill,
      highlight,
      selected: null,
      placement: 'reference',
      drapeMemo: new Map(),
      drapePending: 0,
      drapeMore: false,
      drapeRevision: null,
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
    const contextual = state.always || active || (begun && (state.persists || this.showAll || this.focus.has(name)));
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
    // Draped on the target's terrain when it has streamed cube terrain: rebuilt
    // (throttled) as finer terrain arrives, so the footprints follow the ground
    // that is actually drawn. Otherwise built once on the reference ellipsoid.
    const drape = terrainOf(targetMesh);
    // Settled (every vertex on sufficiently detailed terrain): nothing to redo
    // until the terrain itself is replaced. Pending: retried as terrain loads.
    // Budget-limited: keep going (throttled) until every vertex has had its ray.
    const signature = !drape ? 'given:reference'
      : state.drapeMore ? `given:terrain:more:${state.builtAt}`
        : state.drapePending === 0 && state.signature.startsWith('given:terrain') ? state.signature
          : `given:terrain:${drape.terrainRevision ?? 0}:${state.drapePending}`;
    if (state.signature === signature) return;
    const wait = state.drapePending > 0 ? DRAPE_PENDING_MS : DRAPE_REBUILD_MS;
    if (state.signature.startsWith('given:') && performance.now() - state.builtAt < wait) return;
    const t0 = performance.now();
    this.buildGiven(state, obs, ctx, drape);
    state.signature = signature;
    state.builtAt = performance.now();
    state.buildMs = state.builtAt - t0;
  }

  /** Emphasize one footprint (a given polygon's index) or the requested region; null clears. */
  setSelected(object: THREE.Object3D, part: number | 'region' | null): void {
    const state = object.userData.observation as ObservationState | undefined;
    if (!state || state.selected === part) return;
    state.selected = part;
    writeHighlight(state);
  }

  /**
   * What a ray hits among this observation's given footprints and requested
   * region: the footprint's polygon index (and its exposure group's epoch,
   * when there is one group per polygon), or the region. Footprints win over
   * the region they lie in. Null when the ray misses both.
   */
  pickGiven(object: THREE.Object3D, raycaster: THREE.Raycaster): { footprint: number | null; region: boolean; distance: number; et: number | null } | null {
    const state = object.userData.observation as ObservationState | undefined;
    if (!state?.obs || !object.visible) return null;
    // Survey footprints overlap: of the footprints under the pointer (hits at
    // the same ground, within a couple of lifts), the one centred nearest it.
    const hits = raycaster.intersectObject(state.fill, false).filter((h) => h.faceIndex != null && state.triangleOwner[h.faceIndex] != null);
    const hit = hits[0];
    if (hit) {
      const local = state.fill.worldToLocal(hit.point.clone());
      const near = hits.filter((h) => h.distance - hit.distance <= 4 * DRAPE_LIFT_KM * (state.fill.parent?.scale.x ?? 1) + 1e-12);
      let footprint = state.triangleOwner[hit.faceIndex!]!;
      let best = Infinity;
      for (const h of near) {
        const i = state.triangleOwner[h.faceIndex!]!;
        const d = state.centers[i]?.distanceTo(local) ?? Infinity;
        if (d < best) { best = d; footprint = i; }
      }
      const g = state.obs.groups;
      const perPolygon = state.obs.coverage.kind === 'footprint' && g.length === state.obs.coverage.polygonLonLat.length;
      return { footprint, region: false, distance: hit.distance, et: perPolygon ? g[footprint]!.startEt : null };
    }
    const region = raycaster.intersectObject(state.regionFill, false)[0];
    return region ? { footprint: null, region: true, distance: region.distance, et: null } : null;
  }

  /** How the given geometry is placed now: on terrain, partly, or on the reference shape. */
  placementOf(object: THREE.Object3D): ObservationState['placement'] | null {
    return (object.userData.observation as ObservationState | undefined)?.placement ?? null;
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
    if (!state || !object.visible) return [];
    return state.obs?.requestedRegion ? [state.fill, state.regionFill] : [state.fill];
  }

  dispose(object: THREE.Object3D): void {
    this.updatedThisFrame.delete(object);
    const state = object.userData.observation as ObservationState | undefined;
    if (!state) return;
    for (const m of [state.fill, state.outline, state.leadFill, state.leadOutline, state.regionOutline, state.regionFill, state.highlight]) m.geometry.dispose();
    for (const m of [state.fill, state.outline, state.regionOutline, state.regionFill, state.highlight]) (m.material as THREE.Material).dispose();
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

  /**
   * Given footprints (one polygon per exposure, holes kept), a disk marker, and
   * the requested region — draped on `drape` (cube terrain) when given, else on
   * the reference ellipsoid. Draped geometry is written relative to its own
   * centre (the meshes are offset to it), so a footprint metres across keeps
   * Float32 precision a few hundred metres from the camera.
   */
  private buildGiven(state: ObservationState, obs: Observation, ctx: RendererContext, drape: BodyMesh | null): void {
    const radii = ctx.universe.getBody(obs.target)?.radii;
    if (!radii) {
      this.warnOnce(obs.name, `target "${obs.target}" has no radii; a given footprint has no surface to sit on.`);
      return;
    }
    const revision = drape?.terrainRevision ?? 0;
    const fillMax = obs.fillInObservations === true ? DRAPE_FILL_MAX_STEPS : DRAPE_PICK_FILL_MAX_STEPS;
    const place = drape ? drapedPlacement(drape, radii, state.drapeMemo, revision !== state.drapeRevision) : null;
    state.drapeRevision = revision;
    const cov = obs.coverage;
    const rings: LonLat[] = cov.kind === 'footprint' ? cov.polygonLonLat.flat() : [...(obs.requestedRegion?.polygonLonLat ?? [])];
    const origin: Vec3 = place && rings.length ? place.at(blend(rings.map(() => 1), rings.map(unitDir))) : [0, 0, 0];
    const lines = new VertexBuffer(this.maxLine, origin);
    const tris = new VertexBuffer(this.maxFill, origin);
    const owner: number[] = [];
    const ranges: { start: number; count: number }[] = [];
    const centers: THREE.Vector3[] = [];
    if (cov.kind === 'footprint') {
      cov.polygonLonLat.forEach((outer, i) => {
        const l0 = lines.count;
        const t0 = tris.count;
        addPolygon(outer, cov.holesLonLat?.[i] ?? [], radii, lines, tris, place, fillMax);
        ranges.push({ start: l0, count: lines.count - l0 });
        const c = new THREE.Vector3();
        const ring = lines.slice(l0, lines.count - l0);
        for (let k = 0; k < ring.length; k += 3) c.add(new THREE.Vector3(ring[k], ring[k + 1], ring[k + 2]));
        centers.push(c.divideScalar(Math.max(1, ring.length / 3)));
        for (let k = t0 / 3; k < tris.count / 3; k++) owner.push(i);
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
      addPolygon(ring, [], radii, lines, tris, place);
    }
    lines.writeTo(state.outline.geometry);
    tris.writeTo(state.fill.geometry);
    state.triangleOwner = Int32Array.from(owner);
    state.lineRanges = ranges;
    state.centers = centers;
    const regionLines = new VertexBuffer(this.maxLine, origin);
    const regionTris = new VertexBuffer(this.maxFill, origin);
    if (obs.requestedRegion) addPolygon(obs.requestedRegion.polygonLonLat, [], radii, regionLines, regionTris, place, DRAPE_PICK_FILL_MAX_STEPS);
    regionLines.writeTo(state.regionOutline.geometry);
    regionTris.writeTo(state.regionFill.geometry);
    for (const m of [state.fill, state.outline, state.regionOutline, state.regionFill, state.highlight]) {
      m.position.set(origin[0], origin[1], origin[2]);
    }
    state.placement = !place ? 'reference' : place.fallbacks() === 0 ? 'terrain' : 'partial-terrain';
    state.drapePending = place?.unsettled() ?? 0;
    state.drapeMore = !!place && place.budgetLeft() === 0;
    if (place && place.fallbacks() > 0 && place.budgetLeft() > 0) {
      this.warnOnce(obs.name, `terrain was not loaded under ${place.fallbacks()} footprint vertices; they lie on the reference shape until it is.`, 'drape');
    }
    writeHighlight(state);
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
  /** `origin` is subtracted from every vertex (in float64, before the Float32 store). */
  constructor(private readonly cap: number, readonly origin: Vec3 = [0, 0, 0]) {}
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
    this.data[3 * this.count] = x - this.origin[0];
    this.data[3 * this.count + 1] = y - this.origin[1];
    this.data[3 * this.count + 2] = z - this.origin[2];
    this.count++;
  }
  /** The stored vertices, origin-relative. */
  slice(start: number, count: number): Float32Array {
    return this.data.slice(3 * start, 3 * (start + count));
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
 * between them filled. A hole stays a hole.
 *
 * On the reference ellipsoid (`place` null): triangulated in a plane tangent
 * at the polygon's centre (longitudes unwrapped about it), then laid on the
 * surface and lifted. Draped (`place` given): every ring and triangle is
 * subdivided along great circles — never in lon/lat, which bends edges near a
 * pole — and each vertex is placed on the terrain.
 */
function addPolygon(
  outerRing: readonly LonLat[],
  holeRings: readonly (readonly LonLat[])[],
  radii: Vec3,
  lines: VertexBuffer,
  tris: VertexBuffer,
  place: DrapedPlacement | null = null,
  fillMax = DRAPE_FILL_MAX_STEPS,
): void {
  const outer = openRing(outerRing);
  const holes = holeRings.map(openRing).filter((h) => h.length >= 3);
  if (outer.length < 3) return;
  if (place) {
    addDrapedPolygon(outer, holes, radii, place, lines, tris, fillMax);
    return;
  }
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

/**
 * Scale the view-space position toward the camera by `DEPTH_PULL` after
 * projection setup: x/z and y/z are unchanged, so only depth moves. Before the
 * log-depth include, which reads the final `gl_Position`.
 */
function pullDepth(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>\nmvPosition.xyz *= ${(1 - DEPTH_PULL).toFixed(6)};\ngl_Position = projectionMatrix * mvPosition;`,
    );
  };
  material.customProgramCacheKey = () => 'observation-depth-pull';
}

/** Places body-fixed directions on terrain; counts the ones it could not. */
interface DrapedPlacement {
  at(direction: Vec3): Vec3;
  /** Vertices on the reference shape: terrain unloaded, or no ray left this build. */
  fallbacks(): number;
  /** Vertices to cast again later (fallbacks, and coarse terrain hits). */
  unsettled(): number;
  budgetLeft(): number;
}

/** The target's streamed cube terrain, when it has one to drape on. */
function terrainOf(mesh: BodyMesh | undefined): BodyMesh | null {
  return mesh && typeof mesh.intersectTerrainRay === 'function' && mesh.terrainRaySurface ? mesh : null;
}

/**
 * Directions → points on `bm`'s cube terrain (a radial ray from 12 km above
 * the reference radius down through 12 km below it), lifted `DRAPE_LIFT_KM`.
 * Where the grids are not resident, or this build's ray budget is spent, the
 * point is on the reference ellipsoid, lifted the same way, and counted.
 * `memo` persists across builds: a vertex on sufficiently detailed terrain is
 * never cast again, so later builds only finish what is pending.
 */
function drapedPlacement(bm: BodyMesh, radii: Vec3, memo: Map<string, { p: Vec3; settled: boolean; cast?: boolean; onTerrain?: boolean }>, recastCoarse: boolean): DrapedPlacement {
  const seen = new Map<string, Vec3>();
  let misses = 0;
  let unsettled = 0;
  let budget = DRAPE_RAYS_PER_BUILD;
  return {
    fallbacks: () => misses,
    unsettled: () => unsettled,
    budgetLeft: () => budget,
    at(direction) {
      const n = Math.hypot(...direction);
      const d: Vec3 = [direction[0] / n, direction[1] / n, direction[2] / n];
      const key = `${d[0].toFixed(12)},${d[1].toFixed(12)},${d[2].toFixed(12)}`;
      const here = seen.get(key);
      if (here) return here;
      const known = memo.get(key);
      let out: Vec3;
      if (known?.settled || (known?.cast && !recastCoarse)) {
        // Detailed terrain, or coarse terrain that has not changed since its ray.
        if (!known.settled) unsettled++;
        if (!known.onTerrain) misses++;
        out = known.p;
      } else {
        const e = ellipsoidAlong(d, radii);
        let p: Vec3 = known?.p ?? e;
        let settled = false;
        let terrain = false;
        let cast = false;
        if (budget > 0) {
          budget--;
          cast = true;
          const r = Math.hypot(...e);
          const hit = bm.intersectTerrainRay(
            { origin: { xKm: d[0] * (r + 12), yKm: d[1] * (r + 12), zKm: d[2] * (r + 12) }, direction: [-d[0], -d[1], -d[2]], nearKm: 0, farKm: 24 },
            { maxMeshErrorKm: 0.001 },
          );
          if (hit?.kind === 'hit') {
            p = [hit.position.xKm + d[0] * DRAPE_LIFT_KM, hit.position.yKm + d[1] * DRAPE_LIFT_KM, hit.position.zKm + d[2] * DRAPE_LIFT_KM];
            settled = hit.detail === 'sufficient';
            terrain = true;
          }
        }
        if (!terrain) {
          misses++;
          p = [e[0] + d[0] * DRAPE_LIFT_KM, e[1] + d[1] * DRAPE_LIFT_KM, e[2] + d[2] * DRAPE_LIFT_KM];
        }
        if (!settled) unsettled++;
        memo.set(key, { p, settled, cast, onTerrain: terrain });
        out = p;
      }
      seen.set(key, out);
      return out;
    },
  };
}

/** Where the ray from the centre along unit `d` meets the ellipsoid. */
function ellipsoidAlong(d: Vec3, radii: Vec3): Vec3 {
  const t = 1 / Math.sqrt((d[0] / radii[0]) ** 2 + (d[1] / radii[1]) ** 2 + (d[2] / radii[2]) ** 2);
  return [d[0] * t, d[1] * t, d[2] * t];
}

function unitDir([lon, lat]: LonLat): Vec3 {
  const lo = (lon * Math.PI) / 180, la = (lat * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

/** Normalized linear blend of unit vectors: a great-circle point, for the short arcs here. */
function blend(w: readonly number[], v: readonly Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < v.length; i++) { x += w[i]! * v[i]![0]; y += w[i]! * v[i]![1]; z += w[i]! * v[i]![2]; }
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
}

function addDrapedPolygon(
  outer: readonly LonLat[], holes: readonly (readonly LonLat[])[], radii: Vec3,
  place: DrapedPlacement, lines: VertexBuffer, tris: VertexBuffer, fillMax: number,
): void {
  const rings = [outer, ...holes].map((ring) => ring.map(unitDir));
  const radius = Math.max(...radii);
  const steps = (a: Vec3, b: Vec3, stepKm: number, max: number) =>
    Math.min(max, Math.max(1, Math.ceil((Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * radius) / stepKm)));
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      const n = steps(a, b, DRAPE_LINE_STEP_KM, DRAPE_LINE_MAX_STEPS);
      let prev = place.at(a);
      for (let k = 1; k <= n; k++) {
        const next = place.at(k === n ? b : blend([1 - k / n, k / n], [a, b]));
        pushRaw(lines, prev, next);
        prev = next;
      }
    }
  }
  // Triangulated in the plane tangent at the centroid: a projection with no
  // pole singularity, so a footprint at -89.7° is as well shaped as one at 0°.
  const all = rings.flat();
  const c = blend(all.map(() => 1), all);
  const e1 = normalize3(Math.abs(c[2]) < 0.9 ? cross3([0, 0, 1], c) : cross3([1, 0, 0], c));
  const e2 = cross3(c, e1);
  const flat = (v: Vec3) => {
    const s = 1 / (v[0] * c[0] + v[1] * c[1] + v[2] * c[2]);
    return new THREE.Vector2((v[0] * e1[0] + v[1] * e1[1] + v[2] * e1[2]) * s, (v[0] * e2[0] + v[1] * e2[1] + v[2] * e2[2]) * s);
  };
  const faces = THREE.ShapeUtils.triangulateShape(rings[0]!.map(flat), rings.slice(1).map((h) => h.map(flat)));
  for (const [ia, ib, ic] of faces) {
    const a = all[ia]!, b = all[ib]!, cc = all[ic]!;
    const n = Math.max(steps(a, b, DRAPE_FILL_STEP_KM, fillMax), steps(b, cc, DRAPE_FILL_STEP_KM, fillMax), steps(cc, a, DRAPE_FILL_STEP_KM, fillMax));
    const at = (i: number, j: number) => place.at(blend([1 - (i + j) / n, i / n, j / n], [a, b, cc]));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        pushRaw(tris, at(i, j), at(i + 1, j), at(i, j + 1));
        if (j < n - i - 1) pushRaw(tris, at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
      }
    }
  }
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize3(v: Vec3): Vec3 {
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** Vertices already on (and lifted off) their surface. */
function pushRaw(out: VertexBuffer, ...pts: Vec3[]): void {
  for (const p of pts) out.push(p[0], p[1], p[2]);
}

/** The highlight: the selected polygon's outline, or the requested region's. */
function writeHighlight(state: ObservationState): void {
  const sel = state.selected;
  let data = new Float32Array(0);
  if (sel === 'region') {
    const pos = state.regionOutline.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (pos) data = (pos.array as Float32Array).slice();
  } else if (sel != null && state.lineRanges[sel]) {
    const { start, count } = state.lineRanges[sel]!;
    const pos = state.outline.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (pos) data = (pos.array as Float32Array).slice(3 * start, 3 * (start + count));
  }
  state.highlight.geometry.setAttribute('position', new THREE.BufferAttribute(data, 3));
  state.highlight.geometry.computeBoundingSphere();
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
