import * as THREE from "three";
import type { TrajectoryCache } from "./TrajectoryCache.js";

/**
 * The future half of a trajectory: the path ahead of the current simulation
 * time, drawn by the {@link TrajectoryLine} that owns it.
 *
 * "Future" is relative to the playhead, not the wall clock, and it is not a
 * prediction: it is whatever the loaded trajectory data says happens after the
 * current simulation time. So the lead never extrapolates — it is clipped to
 * the trajectory's coverage and ends where the data ends.
 *
 * Nothing draws a long lead by default. A lead is the union of *requests*,
 * each under its own key so independent consumers do not overwrite each other:
 * a catalog's plot `lead`, a hovered event previewing where it happens, a
 * selected event keeping that context, a "show the future path" mode on a
 * focused body. The {@link resolveLeadWindows} policy turns the requests into
 * the time windows actually drawn — continuous from the playhead when the
 * target is near, an excerpt around the target when it is far — so a
 * multi-year gap between now and a distant event is not drawn at every scale.
 *
 * Event and analysis features ask for lead geometry through requests and read
 * it back through {@link TrajectoryLead.drawnLead}; they never sample or draw
 * trajectories of their own.
 */

/** A span in ET seconds. Instants have `start === end`. */
export interface LeadSpan {
  start: number;
  end: number;
}

/** One consumer's ask for future trajectory. */
export interface LeadRequest {
  /** At least this many seconds of continuous path ahead of the playhead. */
  duration?: number;
  /**
   * A span the lead should reach, or show context around when it is too far
   * ahead to reach. Also drawn at full strength, rather than faded, so an
   * event on the lead reads as the part of the path it is about.
   */
  target?: LeadSpan;
}

/** How requests become windows. Exact values are tunable per line. */
export interface LeadPolicy {
  /**
   * Longest continuous lead drawn from the playhead, seconds. A target that
   * ends within this reach extends the lead to it; one further out gets a
   * context excerpt instead of every intervening segment.
   */
  maxContinuous: number;
  /** Context drawn either side of a target, seconds. */
  contextPad: number;
}

export type LeadWindowKind = "continuous" | "context";

/** A time window of the lead, as drawn. */
export interface LeadWindow extends LeadSpan {
  /**
   * `continuous` starts at the playhead and joins the trail; `context` is an
   * excerpt around a distant target, tapered at both ends so it reads as one.
   */
  kind: LeadWindowKind;
}

/**
 * Resolve lead requests into the windows to draw.
 *
 * Pure: the only inputs are the playhead, the requests, the coverage the lead
 * may not leave, and the policy. Windows are clipped to `[et, coverage.end]`
 * (the future, within data), sorted, and merged where they overlap.
 */
export function resolveLeadWindows(
  et: number,
  requests: Iterable<LeadRequest>,
  coverage: LeadSpan,
  policy: LeadPolicy,
): LeadWindow[] {
  const floor = Math.max(et, coverage.start);
  const ceil = coverage.end;
  if (!(ceil > floor)) return [];

  const reach = Math.max(0, policy.maxContinuous);
  let continuousEnd = et;
  const context: LeadSpan[] = [];

  for (const req of requests) {
    if (req.duration != null && req.duration > 0) {
      continuousEnd = Math.max(continuousEnd, et + req.duration);
    }
    const target = req.target;
    if (!target || !(target.end >= target.start)) continue;
    // Already on the trail: nothing ahead to show.
    if (target.end <= et) continue;

    const pad = Math.max(policy.contextPad, 0.25 * (target.end - target.start));
    const want = target.end + pad;
    if (want - et <= reach) {
      // Near: draw the path from here all the way through it.
      continuousEnd = Math.max(continuousEnd, want);
    } else if (target.start - et <= reach) {
      // It starts within reach but runs long: reach as far as the policy
      // allows rather than drawing an arbitrarily long lead.
      continuousEnd = Math.max(continuousEnd, et + reach);
    } else {
      // Far: an excerpt around the target, no longer than a continuous lead.
      const start = target.start - pad;
      context.push({ start, end: Math.min(want, start + Math.max(reach, 2 * pad)) });
    }
  }

  const windows: LeadWindow[] = [];
  const push = (start: number, end: number, kind: LeadWindowKind) => {
    const s = Math.max(start, floor);
    const e = Math.min(end, ceil);
    if (e > s) windows.push({ start: s, end: e, kind });
  };
  if (continuousEnd > et) push(et, continuousEnd, "continuous");
  for (const c of context) push(c.start, c.end, "context");

  windows.sort((a, b) => a.start - b.start);
  const merged: LeadWindow[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
      if (w.kind === "continuous") last.kind = "continuous";
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

/**
 * Time-anchored dash period for a window of this length, in seconds.
 *
 * Dashes are equal *time* steps rather than equal lengths: they stay put on
 * the path as the playhead moves (no crawling), and they stretch where the
 * body moves fast, so the lead doubles as a speed cue. The period is snapped
 * to a power of two so it does not change continuously as a window grows.
 */
export function leadDashPeriod(windowSeconds: number, dashes = 48): number {
  if (!(windowSeconds > 0)) return 1;
  return Math.pow(2, Math.round(Math.log2(windowSeconds / dashes)));
}

/**
 * Brightness of a lead vertex, 0–1, before emphasis and color segments.
 *
 * A continuous lead dims away from the playhead, so the near future reads
 * first and the transition from the solid trail is a change of line treatment
 * rather than a jump in brightness. A context excerpt tapers at both ends.
 * Anything inside a request's target is drawn at full strength.
 */
export function leadFade(
  t: number,
  window: LeadWindow,
  targets: readonly LeadSpan[],
): number {
  for (const target of targets) {
    if (t >= target.start && t <= target.end) return 1;
  }
  const span = window.end - window.start;
  if (!(span > 0)) return 1;
  const u = Math.min(1, Math.max(0, (t - window.start) / span));
  if (window.kind === "continuous") return 1 - 0.7 * u;
  const TAPER = 0.2;
  return Math.min(1, u / TAPER, (1 - u) / TAPER);
}

/** Read-only view of the lead geometry drawn this frame. */
export interface DrawnLead {
  /** Local-space xyz, as segment pairs: vertices 2k and 2k+1 form a segment. */
  readonly positions: Float32Array;
  /** Epoch (ET seconds) of each vertex, parallel to `positions`. */
  readonly times: Float64Array;
  /** Number of valid vertices (twice the number of segments). */
  readonly count: number;
  /** The windows those segments were drawn for. */
  readonly windows: readonly LeadWindow[];
}

/** What the owning line hands the lead each frame. */
export interface LeadFrame {
  et: number;
  scaleFactor: number;
  offset: [number, number, number];
  /** Resolve a raw (pre-offset) position in km; NaN outside coverage. */
  resolve: (t: number) => [number, number, number];
  /** The owning line's cache, when it has one. */
  cache: TrajectoryCache | null;
  /** The trail's head sample at `et`, so lead and trail meet exactly. */
  head: { t: number; x: number; y: number; z: number } | null;
  /** Coverage the lead must stay inside. */
  coverage: LeadSpan;
  /** Current trail color (base or hover-emphasised). */
  color: THREE.Color;
  /** The owning line's time-ranged color overrides. */
  colorSegments: ReadonlyArray<{ startEt: number; endEt: number; color: THREE.Color }>;
  /** Live-sampled vertices per window; cheap resolvers can afford more. */
  liveSamples: number;
}

interface SampledWindow extends LeadSpan {
  /** Ascending times, and raw positions in km (3 per time; NaN = no data). */
  times: number[];
  xyz: number[];
}

/** Lead windows are sampled a little past their end so steady playback does
 *  not resample every frame. */
const SAMPLE_SLACK = 0.1;
/** A second at most, so an exact window boundary never misses by rounding. */
const EPS = 1e-3;

export class TrajectoryLead {
  readonly object: THREE.LineSegments;
  private positions: Float32Array;
  private colors: Float32Array;
  private distances: Float32Array;
  private times: Float64Array;
  private capacity = 0;
  private count = 0;

  private readonly requests = new Map<string, LeadRequest>();
  private policy: LeadPolicy;
  private windows: LeadWindow[] = [];
  private sampled: SampledWindow[] = [];
  private dirty = true;

  private readonly material: THREE.LineDashedMaterial;
  private baseOpacity: number;

  constructor(policy: LeadPolicy, opacity: number) {
    this.policy = { ...policy };
    this.baseOpacity = opacity;
    this.positions = new Float32Array(0);
    this.colors = new Float32Array(0);
    this.distances = new Float32Array(0);
    this.times = new Float64Array(0);
    const geometry = new THREE.BufferGeometry();
    this.material = new THREE.LineDashedMaterial({
      vertexColors: true,
      transparent: true,
      opacity,
      depthWrite: false,
      // Same blending as the trail, so the two read as one path whose future
      // half changes treatment, not hue.
      blending: THREE.AdditiveBlending,
      // `lineDistance` is written in dash periods (see `leadDashPeriod`).
      dashSize: 0.55,
      gapSize: 0.45,
      scale: 1,
    });
    this.object = new THREE.LineSegments(geometry, this.material);
    this.object.name = "lead";
    this.object.frustumCulled = false;
    this.object.renderOrder = -1;
    this.object.visible = false;
    this.ensureCapacity(256);
  }

  /** Add, replace, or (with null) remove one consumer's request. */
  setRequest(key: string, request: LeadRequest | null): void {
    if (request) this.requests.set(key, { ...request });
    else if (!this.requests.delete(key)) return;
    this.dirty = true;
  }

  getRequest(key: string): LeadRequest | undefined {
    return this.requests.get(key);
  }

  clearRequests(): void {
    if (this.requests.size === 0) return;
    this.requests.clear();
    this.dirty = true;
  }

  setPolicy(policy: Partial<LeadPolicy>): void {
    this.policy = { ...this.policy, ...policy };
    this.dirty = true;
  }

  /** Whether anything could be drawn: some request is active. */
  get hasRequests(): boolean {
    return this.requests.size > 0;
  }

  /** The windows the last `update` drew. */
  currentWindows(): readonly LeadWindow[] {
    return this.windows;
  }

  /** Drop all samples (the trajectory or its cache changed). */
  invalidate(): void {
    this.sampled = [];
    this.dirty = true;
  }

  /** Emphasis mirrors the trail's: an opacity multiplier over the base. */
  setOpacityScale(scale: number): void {
    this.material.opacity = Math.min(1, this.baseOpacity * scale);
  }

  hide(): void {
    this.object.visible = false;
    this.count = 0;
    this.object.geometry.setDrawRange(0, 0);
  }

  drawnLead(): DrawnLead {
    return {
      positions: this.positions,
      times: this.times,
      count: this.object.visible ? this.count : 0,
      windows: this.windows,
    };
  }

  update(frame: LeadFrame): void {
    if (this.requests.size === 0) {
      this.windows = [];
      this.hide();
      return;
    }
    const [ox, oy, oz] = frame.offset;
    if (isNaN(ox) || isNaN(oy) || isNaN(oz)) {
      this.hide();
      return;
    }

    this.windows = resolveLeadWindows(
      frame.et,
      this.requests.values(),
      frame.coverage,
      this.policy,
    );
    if (this.windows.length === 0) {
      this.hide();
      return;
    }

    this.ensureSamples(frame);

    const targets: LeadSpan[] = [];
    for (const r of this.requests.values()) if (r.target) targets.push(r.target);

    const s = frame.scaleFactor;
    let n = 0;
    for (const w of this.windows) {
      const src = this.sampled.find(
        (sw) => sw.start <= w.start + EPS && sw.end >= w.end - EPS,
      );
      if (!src) continue;
      const period = leadDashPeriod(w.end - w.start);
      // Anchor the dash phase to a fixed grid so dashes stay put on the path.
      const anchor = Math.floor(w.start / (2 * period)) * 2 * period;

      // Walk the window's vertices: start, interior samples, end. The start
      // of a continuous window is the trail's own head, so the two meet.
      let prevT = NaN,
        px = 0,
        py = 0,
        pz = 0;
      const emit = (t: number, x: number, y: number, z: number) => {
        if (isNaN(x)) {
          // Coverage gap: end the run, never bridge it.
          prevT = NaN;
          return;
        }
        if (!isNaN(prevT) && t > prevT) {
          this.ensureCapacity(n + 2);
          this.writeVertex(n++, prevT, px, py, pz, frame, w, targets, period, anchor, s);
          this.writeVertex(n++, t, x, y, z, frame, w, targets, period, anchor, s);
        }
        prevT = t;
        px = x;
        py = y;
        pz = z;
      };

      const head =
        w.kind === "continuous" && frame.head && Math.abs(frame.head.t - w.start) <= EPS
          ? frame.head
          : null;
      if (head) emit(head.t, head.x, head.y, head.z);
      else {
        const p = interpolate(src, w.start);
        emit(w.start, p[0], p[1], p[2]);
      }
      const times = src.times;
      const xyz = src.xyz;
      for (let i = lowerBoundArr(times, w.start + EPS); i < times.length; i++) {
        const t = times[i];
        if (t >= w.end - EPS) break;
        emit(t, xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
      }
      const p = interpolate(src, w.end);
      emit(w.end, p[0], p[1], p[2]);
    }

    this.count = n;
    const geometry = this.object.geometry;
    geometry.setDrawRange(0, n);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.attributes.lineDistance.needsUpdate = true;
    this.object.visible = n > 0;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }

  // ── internals ──

  private writeVertex(
    i: number,
    t: number,
    x: number,
    y: number,
    z: number,
    frame: LeadFrame,
    w: LeadWindow,
    targets: readonly LeadSpan[],
    period: number,
    anchor: number,
    s: number,
  ): void {
    const [ox, oy, oz] = frame.offset;
    this.positions[i * 3] = (x + ox) * s;
    this.positions[i * 3 + 1] = (y + oy) * s;
    this.positions[i * 3 + 2] = (z + oz) * s;
    this.times[i] = t;
    this.distances[i] = (t - anchor) / period;
    let c = frame.color;
    for (const seg of frame.colorSegments) {
      if (t >= seg.startEt && t <= seg.endEt) {
        c = seg.color;
        break;
      }
    }
    const f = leadFade(t, w, targets);
    this.colors[i * 3] = c.r * f;
    this.colors[i * 3 + 1] = c.g * f;
    this.colors[i * 3 + 2] = c.b * f;
  }

  /** (Re)sample any window not already covered by a sampled one. */
  private ensureSamples(frame: LeadFrame): void {
    const covered = (w: LeadWindow) =>
      this.sampled.some((sw) => sw.start <= w.start + EPS && sw.end >= w.end - EPS);
    if (!this.dirty && this.windows.every(covered)) return;
    this.dirty = false;

    const next: SampledWindow[] = [];
    for (const w of this.windows) {
      const keep = this.sampled.find(
        (sw) => sw.start <= w.start + EPS && sw.end >= w.end - EPS,
      );
      if (keep) {
        if (!next.includes(keep)) next.push(keep);
        continue;
      }
      const slack = (w.end - w.start) * SAMPLE_SLACK;
      const end = Math.min(w.end + slack, frame.coverage.end);
      next.push(this.sampleWindow(w.start, end, frame));
    }
    this.sampled = next;
  }

  private sampleWindow(start: number, end: number, frame: LeadFrame): SampledWindow {
    const times: number[] = [];
    const xyz: number[] = [];
    const push = (t: number, p: [number, number, number]) => {
      times.push(t);
      xyz.push(p[0], p[1], p[2]);
    };

    const cache = frame.cache;
    if (cache && cache.count > 0) {
      const [lo, hi] = cache.getWindowIndices(start, end);
      if (hi - lo >= 2) {
        // Cache points inside the window, with exact endpoints.
        if (cache.times[lo] > start) push(start, frame.resolve(start));
        for (let i = lo; i < hi; i++) {
          push(cache.times[i], [
            cache.positions[i * 3],
            cache.positions[i * 3 + 1],
            cache.positions[i * 3 + 2],
          ]);
        }
        if (cache.times[hi - 1] < end) push(end, frame.resolve(end));
        return { start, end, times, xyz };
      }
    }

    // Live sampling. NaN positions (outside kernel coverage) are kept as
    // NaN so the drawn lead breaks there instead of bridging the gap.
    const n = Math.max(2, frame.liveSamples);
    const dt = (end - start) / (n - 1);
    for (let i = 0; i < n; i++) {
      const t = i === n - 1 ? end : start + i * dt;
      push(t, frame.resolve(t));
    }
    return { start, end, times, xyz };
  }

  private ensureCapacity(vertices: number): void {
    if (vertices <= this.capacity) return;
    const cap = Math.max(vertices, this.capacity * 2);
    const positions = new Float32Array(cap * 3);
    const colors = new Float32Array(cap * 3);
    const distances = new Float32Array(cap);
    const times = new Float64Array(cap);
    positions.set(this.positions);
    colors.set(this.colors);
    distances.set(this.distances);
    times.set(this.times);
    this.positions = positions;
    this.colors = colors;
    this.distances = distances;
    this.times = times;
    this.capacity = cap;
    // A new geometry rather than new attributes on the old one: three.js keys
    // its GPU buffers on the attribute, and a resized attribute on a live
    // geometry is not re-uploaded.
    const old = this.object.geometry;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("lineDistance", new THREE.BufferAttribute(distances, 1));
    geometry.setDrawRange(0, 0);
    this.object.geometry = geometry;
    old.dispose();
  }
}

/** First index with `arr[i] >= t`. */
function lowerBoundArr(arr: readonly number[], t: number): number {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Linear position at `t` from a sampled window; NaN if either neighbor is. */
function interpolate(src: SampledWindow, t: number): [number, number, number] {
  const { times, xyz } = src;
  if (times.length === 0) return [NaN, NaN, NaN];
  const i = lowerBoundArr(times, t);
  if (i < times.length && Math.abs(times[i] - t) <= EPS) {
    return [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]];
  }
  if (i === 0 || i >= times.length) return [NaN, NaN, NaN];
  const t0 = times[i - 1],
    t1 = times[i];
  const u = (t - t0) / (t1 - t0);
  const a = (i - 1) * 3,
    b = i * 3;
  return [
    xyz[a] + (xyz[b] - xyz[a]) * u,
    xyz[a + 1] + (xyz[b + 1] - xyz[a + 1]) * u,
    xyz[a + 2] + (xyz[b + 2] - xyz[a + 2]) * u,
  ];
}
