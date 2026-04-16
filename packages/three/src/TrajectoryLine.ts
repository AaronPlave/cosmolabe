import * as THREE from 'three';
import type { Body } from '@spicecraft/core';
import type { TrajectoryCache } from './TrajectoryCache.js';

/** A color segment overrides the trail color for a time range. */
export interface ColorSegment {
  startEt: number;
  endEt: number;
  color: THREE.ColorRepresentation;
}

export interface TrajectoryLineOptions {
  /** Max number of rendered vertices. Default 32000. */
  maxPoints?: number;
  /** Duration of trail behind current time (seconds) */
  trailDuration?: number;
  /** Duration of trail ahead of current time (seconds) */
  leadDuration?: number;
  /** Line color */
  color?: number;
  /** Line opacity (0-1) */
  opacity?: number;
  /** Orbital period in seconds — if set, draws a faint full-orbit ring */
  orbitPeriod?: number;
  /** Opacity for the full orbit ring (default 0.15) */
  orbitOpacity?: number;
  /** Minimum time — hide and don't draw before this time */
  minTime?: number;
  /** Maximum time — freeze trail at this time (for completed arcs) */
  maxTime?: number;
  /** Fixed position resolver that overrides the one passed to update() */
  fixedResolver?: PositionResolver;
  /** Fraction of trail (from oldest end) that fades to transparent (0-1, default 1.0 = full fade) */
  fadeFraction?: number;
  /** Screen-space error threshold in pixels for subdivision. Default 1. */
  subdivisionPixels?: number;
  /** Initial coarse sample count. Default 100. */
  numKeySamples?: number;
  /** @deprecated Use maxPoints instead */
  numPoints?: number;
  /** Pre-computed trajectory cache. When provided, samples are extracted from cache
   *  via binary search instead of live SPICE calls. */
  cache?: TrajectoryCache;
}

/** Resolves a body's absolute position (km) at a given time */
export type PositionResolver = (bodyName: string, et: number) => [number, number, number];

interface Sample {
  t: number;
  x: number; y: number; z: number;
}

export class TrajectoryLine extends THREE.Object3D {
  readonly body: Body;

  private readonly trailLine: THREE.Line;
  private trailPositions: Float32Array;
  private trailColors: Float32Array;
  private maxPoints: number;
  private readonly numCoarse: number;
  private readonly trailDuration: number;
  private readonly leadDuration: number;
  private readonly baseColor: THREE.Color;
  private readonly fadeFraction: number;
  private readonly subdivisionPixels: number;

  // Full orbit ring (faint)
  private orbitLine: THREE.Line | null = null;
  private orbitPositions: Float32Array | null = null;
  private readonly orbitPeriod: number;
  private readonly orbitNumPoints: number;

  // Cache: separate expensive sample computation from cheap offset application
  private lastComputedEt = -Infinity;
  private cachedSamples: Sample[] = [];
  private cachedStartEt = 0;
  private cachedTotalDuration = 0;

  // Set to true when the body's trajectory changes, forcing a full resample
  private _needsResample = false;
  // Dirty flag: true when buffer needs rewriting (resample or offset changed)
  private _bufferDirty = true;
  // Last vertex offset applied (for change detection)
  private _lastOffX = NaN;
  private _lastOffY = NaN;
  private _lastOffZ = NaN;
  // Color segments: override base color for time ranges
  private _colorSegments: Array<{ startEt: number; endEt: number; color: THREE.Color }> = [];

  // Pre-computed trajectory cache (null = live sampling)
  private cache: TrajectoryCache | null = null;
  // Window indices into cache (set by recomputeSamples when cache is used)
  private cacheWindowLo = 0;
  private cacheWindowHi = 0;
  // Live "tail" sample at current time — closes the gap between the last
  // sampled point (cache or legacy) and the actual current position.
  // Updated every frame, costs 1 SPICE call (~5µs).
  private _tailSample: Sample | null = null;
  // Live "bridge" samples: fill the gap between the last cache point and
  // current time with a short adaptive-sampled segment. Without this, a
  // single tail sample draws a visible straight line at periapsis.
  private _bridgeSamples: Sample[] = [];

  // Time bounds
  private readonly minTime?: number;
  private readonly maxTime?: number;
  private readonly fixedResolver?: PositionResolver;
  private userVisible = true;

  constructor(body: Body, options: TrajectoryLineOptions = {}) {
    super();
    this.body = body;
    this.name = `${body.name}_trajectory`;
    this.cache = options.cache ?? null;
    // When a cache is provided, default buffer size to cache count (ensures the
    // full pre-computed dataset can be displayed). Explicit maxPoints still overrides.
    this.maxPoints = options.maxPoints ?? (this.cache ? this.cache.count : (options.numPoints ?? 32000));
    this.trailDuration = options.trailDuration ?? 86400;
    // Scale coarse count with duration: ~2/day, min 100, max 500
    const defaultCoarse = Math.max(100, Math.min(500, Math.round(this.trailDuration / 43200)));
    this.numCoarse = options.numKeySamples ?? defaultCoarse;
    this.leadDuration = options.leadDuration ?? 0;
    this.orbitPeriod = options.orbitPeriod ?? 0;
    this.orbitNumPoints = 300;
    this.minTime = options.minTime;
    this.maxTime = options.maxTime;
    this.fixedResolver = options.fixedResolver;
    this.fadeFraction = options.fadeFraction ?? 1.0;
    this.subdivisionPixels = options.subdivisionPixels ?? 1;

    this.baseColor = body.labelColor
      ? new THREE.Color(body.labelColor[0], body.labelColor[1], body.labelColor[2])
      : new THREE.Color(0x4488ff);
    const colorHex = options.color ?? this.baseColor.getHex();

    // Trail line with per-vertex color fade
    this.trailPositions = new Float32Array(this.maxPoints * 3);
    this.trailColors = new Float32Array(this.maxPoints * 3);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    trailGeometry.setAttribute('color', new THREE.BufferAttribute(this.trailColors, 3));
    trailGeometry.setDrawRange(0, 0);

    const trailMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: options.opacity ?? 0.8,
      depthWrite: false,
    });
    this.trailLine = new THREE.Line(trailGeometry, trailMaterial);
    this.trailLine.frustumCulled = false;
    this.trailLine.renderOrder = -1;
    this.add(this.trailLine);

    // Full orbit ring (faint)
    if (this.orbitPeriod > 0) {
      this.orbitPositions = new Float32Array(this.orbitNumPoints * 3);
      const orbitGeometry = new THREE.BufferGeometry();
      orbitGeometry.setAttribute('position', new THREE.BufferAttribute(this.orbitPositions, 3));

      const orbitMaterial = new THREE.LineBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: options.orbitOpacity ?? 0.35,
        depthWrite: false,
      });
      this.orbitLine = new THREE.LineLoop(orbitGeometry, orbitMaterial);
      this.orbitLine.frustumCulled = false;
      this.orbitLine.renderOrder = -1;
      this.add(this.orbitLine);
    }
  }

  setUserVisible(visible: boolean): void {
    this.userVisible = visible;
    this.visible = visible;
  }

  /**
   * Hot-swap a pre-computed trajectory cache. Used when an async Web Worker
   * completes a cache build after the line was created with legacy sampling.
   * Reallocates GPU buffers if the cache is larger than the current allocation.
   */
  setCache(cache: TrajectoryCache): void {
    this.cache = cache;
    const requiredPoints = cache.count + 1; // +1 for tail sample
    if (requiredPoints > this.maxPoints) {
      this.maxPoints = requiredPoints;
      this.trailPositions = new Float32Array(requiredPoints * 3);
      this.trailColors = new Float32Array(requiredPoints * 3);
      const geometry = this.trailLine.geometry;
      geometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(this.trailColors, 3));
    }
    this.invalidate();
  }

  /**
   * @param vertexOffset - km offset added to all vertex positions (in Float64) before Float32 conversion.
   *   Keeps vertices near origin for GPU precision. Typically (arcCenter - sceneOrigin) in km.
   */
  update(et: number, scaleFactor: number, resolvePos?: PositionResolver, _camera?: THREE.Camera, _canvasHeight?: number, vertexOffset?: [number, number, number]): void {
    if (!this.userVisible) return;

    const resolver = this.fixedResolver ?? resolvePos;

    if (this.minTime != null && et < this.minTime) {
      this.visible = false;
      return;
    }
    // Hide past arcs once the trail window has moved entirely past their end
    if (this.maxTime != null && et - this.trailDuration > this.maxTime) {
      this.visible = false;
      return;
    }
    this.visible = true;

    if (this.cache) {
      // ── Cache path: throttled resample (binary search) + bridge + tail ──
      const CACHE_RESAMPLE = 300; // 5 min — just a binary search, no SPICE calls
      const needsResample = this._needsResample
        || this.lastComputedEt === -Infinity
        || Math.abs(et - this.lastComputedEt) >= CACHE_RESAMPLE;
      if (needsResample) {
        this._needsResample = false;
        this.lastComputedEt = et;
        this.recomputeSamples(et, resolver);
        this._bufferDirty = true;
      }
      // Tail sample: 1 SPICE call per frame to reach exact current position
      let tailEt = et + this.leadDuration;
      if (this.maxTime != null && tailEt > this.maxTime) tailEt = this.maxTime;
      const pos = this.resolveAt(tailEt, resolver);
      this._tailSample = !isNaN(pos[0]) ? { t: tailEt, x: pos[0], y: pos[1], z: pos[2] } : null;
    } else {
      // ── Legacy path: throttled resample + tail ──
      // Resample when enough ET has elapsed (~1% of trail duration), not every frame.
      // A per-frame tail sample (1 SPICE call) keeps the head position exact.
      // Cap at 3600s so long-period orbits (Jupiter, Saturn) don't accumulate
      // visible straight-line chords between the last sample and the tail.
      const LEGACY_RESAMPLE = Math.min(Math.max(this.trailDuration * 0.01, 60), 3600);
      const needsResample = this._needsResample
        || this.lastComputedEt === -Infinity
        || Math.abs(et - this.lastComputedEt) >= LEGACY_RESAMPLE;
      if (needsResample) {
        this._needsResample = false;
        this.lastComputedEt = et;
        this.recomputeSamples(et, resolver);
        this._bufferDirty = true;
      }
      // Tail sample: 1 SPICE call per frame to reach exact current position
      let tailEt = et + this.leadDuration;
      if (this.maxTime != null && tailEt > this.maxTime) tailEt = this.maxTime;
      const pos = this.resolveAt(tailEt, resolver);
      this._tailSample = !isNaN(pos[0]) ? { t: tailEt, x: pos[0], y: pos[1], z: pos[2] } : null;
      this._bridgeSamples = [];
    }

    // Phase 2: Apply offset and write to Float32 buffers
    this.applyOffset(scaleFactor, vertexOffset);
  }

  /** Recompute trajectory samples — only called when et changes */
  private recomputeSamples(et: number, resolver?: PositionResolver): void {
    let endEt = et + this.leadDuration;
    if (this.maxTime != null && endEt > this.maxTime) endEt = this.maxTime;

    let startEt = endEt - this.trailDuration;
    if (this.minTime != null && startEt < this.minTime) startEt = this.minTime;
    const trajStart = this.body.trajectory.startTime;
    if (trajStart != null && startEt < trajStart) startEt = trajStart;

    const totalDuration = endEt - startEt;
    this.cachedStartEt = startEt;
    this.cachedTotalDuration = totalDuration;

    if (totalDuration <= 0) {
      this.cachedSamples = [];
      this.cacheWindowLo = 0;
      this.cacheWindowHi = 0;
      return;
    }

    // ── Fast path: extract from pre-computed cache ──
    if (this.cache && this.cache.count > 0) {
      const [lo, hi] = this.cache.getWindowIndices(startEt, endEt);
      const windowCount = Math.min(hi, lo + this.maxPoints) - lo;
      if (windowCount > 0) {
        this.cacheWindowLo = lo;
        this.cacheWindowHi = lo + windowCount;
        this.cachedSamples = [];

        // Fill the gap between the last cache point and endEt with a short
        // live-sampled bridge. Without this, a single tail sample draws a
        // visible straight-line chord at periapsis (~30 km/s × 1 hour gap).
        const lastCacheTime = this.cache.times[lo + windowCount - 1];
        const gap = endEt - lastCacheTime;
        this._bridgeSamples = [];
        if (gap > 60 && resolver) { // > 1 minute gap
          const BRIDGE_STEP = Math.max(gap / 50, 30); // ~50 points, min 30s apart
          for (let t = lastCacheTime + BRIDGE_STEP; t < endEt; t += BRIDGE_STEP) {
            const pos = this.resolveAt(t, resolver);
            if (!isNaN(pos[0])) {
              this._bridgeSamples.push({ t, x: pos[0], y: pos[1], z: pos[2] });
            }
          }
        }
        return;
      }
      // Cache has no points in this window — fall through to legacy live sampling.
      // This handles Builtin/analytical trajectories whose cache was built for a
      // limited time range, or SPICE trajectories when the user scrubs past coverage.
      this.cacheWindowLo = 0;
      this.cacheWindowHi = 0;
    }

    // ── Legacy path: live sampling with adaptive subdivision ──
    // Curvature threshold: 0.5% deviation ratio for smooth curves
    const curvatureThreshold = this.subdivisionPixels > 0 ? 0.005 / this.subdivisionPixels : 0;

    // Coarse samples anchored to fixed time grid.
    // NaN positions (from out-of-coverage SPICE queries) are skipped — the trail
    // automatically clips to the time range with valid kernel data.
    const dt = totalDuration / (Math.min(this.numCoarse, this.maxPoints) - 1);
    const gridStart = Math.ceil(startEt / dt) * dt;
    const coarseSamples: Sample[] = [];
    {
      const pos = this.resolveAt(startEt, resolver);
      if (!isNaN(pos[0])) coarseSamples.push({ t: startEt, x: pos[0], y: pos[1], z: pos[2] });
    }
    for (let t = gridStart; t < endEt; t += dt) {
      if (t <= startEt) continue;
      const pos = this.resolveAt(t, resolver);
      if (!isNaN(pos[0])) coarseSamples.push({ t, x: pos[0], y: pos[1], z: pos[2] });
    }
    {
      const pos = this.resolveAt(endEt, resolver);
      if (!isNaN(pos[0])) coarseSamples.push({ t: endEt, x: pos[0], y: pos[1], z: pos[2] });
    }

    // Recursive subdivision with per-pair budget cap.
    // Cap live sampling to keep per-frame SPICE calls manageable. The legacy
    // path resamples every frame — with 9 moons × ~500 calls each = ~4500 SPICE
    // calls/frame. Original main branch had numPoints:300 (~300 calls/trajectory).
    const MAX_LIVE_SAMPLES = 500;
    const liveBudget = Math.min(this.maxPoints, MAX_LIVE_SAMPLES);
    const maxDepth = 12;
    const numPairs = Math.max(coarseSamples.length - 1, 1);
    const maxPerPair = Math.max(Math.floor(liveBudget / numPairs), 16);
    const finalSamples: Sample[] = [];
    let pairBudget = 0;

    const subdivide = (s0: Sample, s1: Sample, depth: number): void => {
      if (pairBudget >= maxPerPair || finalSamples.length >= liveBudget - 1) {
        finalSamples.push(s0);
        return;
      }

      if (curvatureThreshold > 0 && depth < maxDepth) {
        const midT = (s0.t + s1.t) * 0.5;
        const midPos = this.resolveAt(midT, resolver);
        if (isNaN(midPos[0])) {
          // No data at midpoint — don't subdivide, just emit the segment
          finalSamples.push(s0);
          return;
        }
        const linMx = (s0.x + s1.x) * 0.5, linMy = (s0.y + s1.y) * 0.5, linMz = (s0.z + s1.z) * 0.5;
        const devX = midPos[0] - linMx, devY = midPos[1] - linMy, devZ = midPos[2] - linMz;
        const deviation = Math.sqrt(devX * devX + devY * devY + devZ * devZ);

        const chordX = s1.x - s0.x, chordY = s1.y - s0.y, chordZ = s1.z - s0.z;
        const chordLen = Math.sqrt(chordX * chordX + chordY * chordY + chordZ * chordZ);

        if (chordLen > 0 && deviation / chordLen > curvatureThreshold) {
          const mid: Sample = { t: midT, x: midPos[0], y: midPos[1], z: midPos[2] };
          subdivide(s0, mid, depth + 1);
          subdivide(mid, s1, depth + 1);
          return;
        }
      }

      finalSamples.push(s0);
      pairBudget++;
    };

    if (coarseSamples.length >= 2) {
      // Reserve 1 slot for the endpoint so the trail always reaches current time
      for (let i = 0; i < coarseSamples.length - 1 && finalSamples.length < liveBudget - 1; i++) {
        pairBudget = 0;
        subdivide(coarseSamples[i], coarseSamples[i + 1], 0);
      }
      finalSamples.push(coarseSamples[coarseSamples.length - 1]);
    } else if (coarseSamples.length === 1) {
      finalSamples.push(coarseSamples[0]);
    }

    this.cachedSamples = finalSamples;

    // Orbit ring samples (stored separately as they use different time range)
    if (this.orbitLine && this.orbitPositions && this.orbitPeriod > 0) {
      const orbitDt = this.orbitPeriod / this.orbitNumPoints;
      // Store orbit samples in _orbitSamples for offset application
      if (!this._orbitSamples) this._orbitSamples = [];
      this._orbitSamples.length = this.orbitNumPoints;
      let orbitCount = 0;
      for (let i = 0; i < this.orbitNumPoints; i++) {
        const t = this.lastComputedEt + i * orbitDt;
        const pos = this.resolveAt(t);
        if (!isNaN(pos[0])) {
          this._orbitSamples[orbitCount++] = { t, x: pos[0], y: pos[1], z: pos[2] };
        }
      }
      this._orbitSamples.length = orbitCount;
    }
  }

  private _orbitSamples?: Sample[];

  /** Apply vertex offset and write to Float32 buffers — called every frame */
  private applyOffset(scaleFactor: number, vertexOffset?: [number, number, number]): void {
    const offX = vertexOffset?.[0] ?? 0, offY = vertexOffset?.[1] ?? 0, offZ = vertexOffset?.[2] ?? 0;
    // Guard: if offset is NaN (e.g. SPICE kernel out of coverage), hide the line
    if (isNaN(offX) || isNaN(offY) || isNaN(offZ)) {
      this.trailLine.geometry.setDrawRange(0, 0);
      return;
    }

    // Detect whether offset changed enough to affect Float32 vertex positions.
    // Positions relative to parent are ~1-10 scene units; the offset moves ~1e-6
    // scene units per frame at typical time rates. Skip full buffer writes when
    // nothing visually changed — turns a 100K-write loop into a no-op.
    const offDx = Math.abs(offX - this._lastOffX);
    const offDy = Math.abs(offY - this._lastOffY);
    const offDz = Math.abs(offZ - this._lastOffZ);
    const offsetChanged = (offDx + offDy + offDz) * scaleFactor > 1e-7;
    const needsFullWrite = this._bufferDirty || offsetChanged;

    if (needsFullWrite) {
      this._lastOffX = offX;
      this._lastOffY = offY;
      this._lastOffZ = offZ;
      this._bufferDirty = false;
    }

    const startEt = this.cachedStartEt;
    const totalDuration = this.cachedTotalDuration;

    // ── Fast path: read directly from pre-computed cache arrays ──
    // Only use cache path when the window actually has points; otherwise fall
    // through to legacy path (handles cache-miss for Builtin trajectories, etc.)
    if (this.cache && this.cacheWindowHi > this.cacheWindowLo) {
      const lo = this.cacheWindowLo;
      const hi = this.cacheWindowHi;
      const count = hi - lo;
      if (count <= 0) {
        this.trailLine.geometry.setDrawRange(0, 0);
        return;
      }

      if (needsFullWrite) {
        const cTimes = this.cache.times;
        const cPositions = this.cache.positions;
        for (let i = 0; i < count; i++) {
          const ci = (lo + i) * 3;
          this.trailPositions[i * 3] = (cPositions[ci] + offX) * scaleFactor;
          this.trailPositions[i * 3 + 1] = (cPositions[ci + 1] + offY) * scaleFactor;
          this.trailPositions[i * 3 + 2] = (cPositions[ci + 2] + offZ) * scaleFactor;

          const t = cTimes[lo + i];
          const fadeT = (t - startEt) / totalDuration;
          const fade = this.fadeFraction > 0 ? Math.min(fadeT / this.fadeFraction, 1) : 1;
          let cr = this.baseColor.r, cg = this.baseColor.g, cb = this.baseColor.b;
          for (const seg of this._colorSegments) {
            if (t >= seg.startEt && t <= seg.endEt) {
              cr = seg.color.r; cg = seg.color.g; cb = seg.color.b;
              break;
            }
          }
          this.trailColors[i * 3] = cr * fade;
          this.trailColors[i * 3 + 1] = cg * fade;
          this.trailColors[i * 3 + 2] = cb * fade;
        }
      }

      // Append bridge samples + tail — fills the gap to current time with
      // a smooth curve instead of a single straight-line chord.
      let drawCount = count;
      const bridgeAndTail = [...this._bridgeSamples];
      if (this._tailSample) bridgeAndTail.push(this._tailSample);
      for (const s of bridgeAndTail) {
        if (drawCount >= this.maxPoints) break;
        const i = drawCount;
        this.trailPositions[i * 3] = (s.x + offX) * scaleFactor;
        this.trailPositions[i * 3 + 1] = (s.y + offY) * scaleFactor;
        this.trailPositions[i * 3 + 2] = (s.z + offZ) * scaleFactor;
        const fadeT = (s.t - startEt) / totalDuration;
        const fade = this.fadeFraction > 0 ? Math.min(fadeT / this.fadeFraction, 1) : 1;
        let cr = this.baseColor.r, cg = this.baseColor.g, cb = this.baseColor.b;
        for (const seg of this._colorSegments) {
          if (s.t >= seg.startEt && s.t <= seg.endEt) {
            cr = seg.color.r; cg = seg.color.g; cb = seg.color.b;
            break;
          }
        }
        this.trailColors[i * 3] = cr * fade;
        this.trailColors[i * 3 + 1] = cg * fade;
        this.trailColors[i * 3 + 2] = cb * fade;
        drawCount++;
      }

      this.trailLine.geometry.setDrawRange(0, drawCount);
      // Only flag GPU upload when buffer contents actually changed
      if (needsFullWrite || bridgeAndTail.length > 0) {
        this.trailLine.geometry.attributes.position.needsUpdate = true;
        this.trailLine.geometry.attributes.color.needsUpdate = true;
      }
      return;
    }

    // ── Legacy path: read from cachedSamples array ──
    const samples = this.cachedSamples;
    if (samples.length === 0) {
      this.trailLine.geometry.setDrawRange(0, 0);
      return;
    }

    if (needsFullWrite) {
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        this.trailPositions[i * 3] = (s.x + offX) * scaleFactor;
        this.trailPositions[i * 3 + 1] = (s.y + offY) * scaleFactor;
        this.trailPositions[i * 3 + 2] = (s.z + offZ) * scaleFactor;

        const fadeT = (s.t - startEt) / totalDuration;
        const fade = this.fadeFraction > 0 ? Math.min(fadeT / this.fadeFraction, 1) : 1;
        let cr = this.baseColor.r, cg = this.baseColor.g, cb = this.baseColor.b;
        for (const seg of this._colorSegments) {
          if (s.t >= seg.startEt && s.t <= seg.endEt) {
            cr = seg.color.r; cg = seg.color.g; cb = seg.color.b;
            break;
          }
        }
        this.trailColors[i * 3] = cr * fade;
        this.trailColors[i * 3 + 1] = cg * fade;
        this.trailColors[i * 3 + 2] = cb * fade;
      }
    }

    // Append live tail sample — always updated (6 writes, trivial)
    let legacyDrawCount = samples.length;
    if (this._tailSample && legacyDrawCount < this.maxPoints) {
      const s = this._tailSample;
      const i = legacyDrawCount;
      this.trailPositions[i * 3] = (s.x + offX) * scaleFactor;
      this.trailPositions[i * 3 + 1] = (s.y + offY) * scaleFactor;
      this.trailPositions[i * 3 + 2] = (s.z + offZ) * scaleFactor;
      const fadeT = (s.t - startEt) / totalDuration;
      const fade = this.fadeFraction > 0 ? Math.min(fadeT / this.fadeFraction, 1) : 1;
      let cr = this.baseColor.r, cg = this.baseColor.g, cb = this.baseColor.b;
      for (const seg of this._colorSegments) {
        if (s.t >= seg.startEt && s.t <= seg.endEt) {
          cr = seg.color.r; cg = seg.color.g; cb = seg.color.b;
          break;
        }
      }
      this.trailColors[i * 3] = cr * fade;
      this.trailColors[i * 3 + 1] = cg * fade;
      this.trailColors[i * 3 + 2] = cb * fade;
      legacyDrawCount++;
    }

    this.trailLine.geometry.setDrawRange(0, legacyDrawCount);
    if (needsFullWrite || this._tailSample) {
      this.trailLine.geometry.attributes.position.needsUpdate = true;
      this.trailLine.geometry.attributes.color.needsUpdate = true;
    }

    // Orbit ring
    if (this.orbitLine && this.orbitPositions && this._orbitSamples) {
      for (let i = 0; i < this._orbitSamples.length; i++) {
        const s = this._orbitSamples[i];
        this.orbitPositions[i * 3] = (s.x + offX) * scaleFactor;
        this.orbitPositions[i * 3 + 1] = (s.y + offY) * scaleFactor;
        this.orbitPositions[i * 3 + 2] = (s.z + offZ) * scaleFactor;
      }
      this.orbitLine.geometry.attributes.position.needsUpdate = true;
      this.orbitLine.geometry.computeBoundingSphere();
    }
  }

  private resolveAt(t: number, resolver?: PositionResolver): [number, number, number] {
    if (resolver) {
      return resolver(this.body.name, t);
    }
    const state = this.body.stateAt(t);
    return state.position as [number, number, number];
  }

  /** Set color segments that override the base trail color for specific time ranges. */
  setColorSegments(segments: ColorSegment[]): void {
    this._colorSegments = segments.map(s => ({
      startEt: s.startEt,
      endEt: s.endEt,
      color: new THREE.Color(s.color),
    }));
  }

  /** Clear all color segments, reverting to the base color. */
  clearColorSegments(): void {
    this._colorSegments = [];
  }

  /** Force a full resample on the next update (e.g. when the body's trajectory changes). */
  invalidate(): void {
    this._needsResample = true;
    this.cachedSamples = [];
    this.cacheWindowLo = 0;
    this.cacheWindowHi = 0;
    this._tailSample = null;
    this._bridgeSamples = [];
    this._orbitSamples = undefined;
  }

  dispose(): void {
    this.trailLine.geometry.dispose();
    (this.trailLine.material as THREE.Material).dispose();
    if (this.orbitLine) {
      this.orbitLine.geometry.dispose();
      (this.orbitLine.material as THREE.Material).dispose();
    }
  }
}
