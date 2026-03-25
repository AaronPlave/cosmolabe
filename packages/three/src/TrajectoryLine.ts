import * as THREE from 'three';
import type { Body } from '@spicecraft/core';

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
  private readonly trailPositions: Float32Array;
  private readonly trailColors: Float32Array;
  private readonly maxPoints: number;
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
  // Color segments: override base color for time ranges
  private _colorSegments: Array<{ startEt: number; endEt: number; color: THREE.Color }> = [];

  // Time bounds
  private readonly minTime?: number;
  private readonly maxTime?: number;
  private readonly fixedResolver?: PositionResolver;
  private userVisible = true;

  constructor(body: Body, options: TrajectoryLineOptions = {}) {
    super();
    this.body = body;
    this.name = `${body.name}_trajectory`;
    this.maxPoints = options.maxPoints ?? options.numPoints ?? 32000;
    this.numCoarse = options.numKeySamples ?? 100;
    this.trailDuration = options.trailDuration ?? 86400;
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
      this.orbitLine.renderOrder = -1;
      this.add(this.orbitLine);
    }
  }

  setUserVisible(visible: boolean): void {
    this.userVisible = visible;
    this.visible = visible;
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

    // Phase 1: Recompute trajectory samples only when time changes (expensive)
    if (et !== this.lastComputedEt || this._needsResample) {
      this._needsResample = false;
      this.lastComputedEt = et;
      this.recomputeSamples(et, resolver);
    }
    // Phase 2: Apply offset and write to Float32 buffers (cheap, every frame)
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
      return;
    }

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

    // Recursive subdivision
    const maxDepth = 12;
    const finalSamples: Sample[] = [];

    const subdivide = (s0: Sample, s1: Sample, depth: number): void => {
      if (finalSamples.length >= this.maxPoints) return;

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
    };

    if (coarseSamples.length >= 2) {
      for (let i = 0; i < coarseSamples.length - 1 && finalSamples.length < this.maxPoints; i++) {
        subdivide(coarseSamples[i], coarseSamples[i + 1], 0);
      }
      if (finalSamples.length < this.maxPoints) {
        finalSamples.push(coarseSamples[coarseSamples.length - 1]);
      }
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
    const samples = this.cachedSamples;
    if (samples.length === 0) {
      this.trailLine.geometry.setDrawRange(0, 0);
      return;
    }

    const offX = vertexOffset?.[0] ?? 0, offY = vertexOffset?.[1] ?? 0, offZ = vertexOffset?.[2] ?? 0;
    // Guard: if offset is NaN (e.g. SPICE kernel out of coverage), hide the line
    if (isNaN(offX) || isNaN(offY) || isNaN(offZ)) {
      this.trailLine.geometry.setDrawRange(0, 0);
      return;
    }
    const startEt = this.cachedStartEt;
    const totalDuration = this.cachedTotalDuration;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      this.trailPositions[i * 3] = (s.x + offX) * scaleFactor;
      this.trailPositions[i * 3 + 1] = (s.y + offY) * scaleFactor;
      this.trailPositions[i * 3 + 2] = (s.z + offZ) * scaleFactor;

      const fadeT = (s.t - startEt) / totalDuration;
      const fade = this.fadeFraction > 0 ? Math.min(fadeT / this.fadeFraction, 1) : 1;
      // Use segment color if this sample falls within a color segment, else base color
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

    this.trailLine.geometry.setDrawRange(0, samples.length);
    this.trailLine.geometry.attributes.position.needsUpdate = true;
    this.trailLine.geometry.attributes.color.needsUpdate = true;
    this.trailLine.geometry.computeBoundingSphere();

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
