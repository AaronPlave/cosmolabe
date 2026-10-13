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
 *    Each group advances a cursor under a shared per-frame budget, so a gap is
 *    tried once and stepped over, and a long window is never enumerated.
 *  - `footprint` — given (ODE): the archive's lon/lat polygons, holes kept,
 *    on the target's reference ellipsoid.
 *  - `disk` — given (OPUS): a marker at the archive's sub-observer point.
 *
 * Contextual by default: an observation is drawn while the clock is inside its
 * own window, accumulating as it goes, and hidden outside it unless focused
 * (`setFocus`, the selection) or `setShowAll` is on.
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
 *  swath fills in over a few frames instead of stalling one. */
const FOOTPRINTS_PER_FRAME = 24;

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
  /** First start and last end over the groups: the observation's own window. */
  window: [number, number];
  /** What the current mesh was built from, to skip rebuilding an unchanged one. */
  signature: string;
  fill: THREE.Mesh;
  outline: THREE.LineSegments;
}

function strToEt(ctx: RendererContext): ((s: string) => number) | undefined {
  const spice = ctx.universe.spiceInstance;
  return spice ? (s) => spice.str2et(s) : undefined;
}

/** A body's name as SPICE should read it: its NAIF ID when the catalog knows one. */
function spiceName(body: Body | undefined, fallback: string): string {
  return body?.naifId != null ? String(body.naifId) : fallback;
}

export class ObservationsVisualizer implements BodyVisualizer {
  readonly geometryType = 'Observations';
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
    return this.createVisualForObservation(obs, ctx, body.name);
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
    fill.frustumCulled = false;
    outline.frustumCulled = false;
    group.add(fill, outline);

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
      window: obs?.groups.length
        ? [Math.min(...obs.groups.map((g) => g.startEt)), Math.max(...obs.groups.map((g) => g.endEt))]
        : [Infinity, -Infinity],
      signature: '',
      fill,
      outline,
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
    if (this.updatedThisFrame.has(object)) {
      this.updatedThisFrame.clear();
      this.budget = FOOTPRINTS_PER_FRAME;
    }
    this.updatedThisFrame.add(object);

    const name = object.userData.observationName as string;
    const [start, end] = state.window;
    const contextual = et >= start && (et <= end || this.showAll || this.focus.has(name));
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

    const lines: number[] = [];
    const tris: number[] = [];
    let signature: string;
    if (obs.coverage.kind === 'sensor') {
      signature = this.sensorGeometry(state, obs, et, lines, tris);
    } else {
      signature = 'given';
      if (signature !== state.signature) this.givenGeometry(obs, ctx, lines, tris);
    }
    object.visible = signature !== '';
    if (signature === state.signature) return;
    state.signature = signature;
    setPositions(state.outline.geometry, lines);
    setPositions(state.fill.geometry, tris);
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
    for (const m of [state.fill, state.outline]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
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

  /** Accumulated sensor footprints up to `et`; returns the build signature. */
  private sensorGeometry(state: ObservationState, obs: Observation, et: number, lines: number[], tris: number[]): string {
    const src = state.sensor;
    if (!src) return '';
    const sig: string[] = [];
    const drawn: { progress: GroupProgress; n: number; leading: Footprint | null }[] = [];

    for (let gi = 0; gi < state.groups.length; gi++) {
      const progress = state.groups[gi]!;
      const reached = progress.sampling.reached(et);
      // Advance the cursor through reached samples; failures are stored as
      // gaps and never retried.
      while (progress.cursor < reached && this.budget > 0) {
        this.budget--;
        progress.prints[progress.cursor] = this.footprintAt(src, obs, progress.sampling.at(progress.cursor));
        progress.cursor++;
      }
      const n = Math.min(progress.cursor, reached);
      if (n === 0) continue;
      // A swath's leading edge follows the clock between grid samples. It joins
      // the last sample only if that sample exists — never across a gap.
      let leading: Footprint | null = null;
      const group = obs.groups[gi]!;
      if (progress.swath && n === reached && et > group.startEt && et < group.endEt && progress.prints[n - 1] && this.budget > 0) {
        this.budget--;
        leading = this.footprintAt(src, obs, et);
      }
      drawn.push({ progress, n, leading });
      sig.push(`${gi}:${n}${leading ? `:${et}` : ''}`);
    }
    const signature = sig.join('|');
    if (signature === state.signature) return signature;

    for (const { progress, n, leading } of drawn) {
      const prints = progress.prints;
      for (let i = 0; i < n; i++) {
        const fp = prints[i];
        if (!fp) continue;
        addFootprint(fp, lines, tris);
        // Only genuinely adjacent samples are joined: a failed sample between
        // two good ones is a hole in the swath, not something to bridge.
        const prev = i > 0 ? prints[i - 1] : null;
        if (progress.swath && prev) addSwathStrip(prev, fp, tris);
      }
      if (leading) {
        addFootprint(leading, lines, tris);
        addSwathStrip(prints[n - 1]!, leading, tris);
      }
    }
    return signature;
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

  private givenGeometry(obs: Observation, ctx: RendererContext, lines: number[], tris: number[]): void {
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

function push(out: number[], ...pts: Vec3[]): void {
  for (const p of pts) {
    const q = lift(p);
    out.push(q[0], q[1], q[2]);
  }
}

/** Steps per edge when a fill triangle is laid on the surface. */
const FILL_STEPS = 6;

/**
 * A surface triangle, subdivided and pushed back out to the surface: each
 * interior point takes the radius interpolated from its corners. A flat
 * triangle across a footprint is a chord, and on a Titan-sized body a NAC
 * frame's chord sinks tens of km under the ground — the fill vanished into
 * the globe while its outline stayed visible.
 */
function pushSurfaceTri(out: number[], a: Vec3, b: Vec3, c: Vec3): void {
  const ra = Math.hypot(...a);
  const rb = Math.hypot(...b);
  const rc = Math.hypot(...c);
  const n = FILL_STEPS;
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

/** Outline and fan fill of one footprint. Rays past the limb break the
 *  outline rather than bridging the gap with a chord. */
function addFootprint(fp: Footprint, lines: number[], tris: number[]): void {
  const b = fp.boundary;
  const hits = b.filter((p): p is Vec3 => p !== null);
  if (hits.length < 2) return;
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    const q = b[(i + 1) % b.length];
    if (p && q) push(lines, p, q);
  }
  const centre = fp.boresight ?? centroid(hits);
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    const q = b[(i + 1) % b.length];
    if (p && q) pushSurfaceTri(tris, centre, p, q);
  }
}

/** The ground swept between two consecutive footprints: each boundary edge
 *  joined to its successor, so a continuous group fills in as a swath. */
function addSwathStrip(a: Footprint, b: Footprint, tris: number[]): void {
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
  lines: number[],
  tris: number[],
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

function setPositions(geometry: THREE.BufferGeometry, data: number[]): void {
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data, 3));
  geometry.computeBoundingSphere();
}
