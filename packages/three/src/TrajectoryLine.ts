import * as THREE from 'three';
import type { Body } from '@spicecraft/core';

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
    });
    this.trailLine = new THREE.Line(trailGeometry, trailMaterial);
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
      });
      this.orbitLine = new THREE.LineLoop(orbitGeometry, orbitMaterial);
      this.add(this.orbitLine);
    }
  }

  setUserVisible(visible: boolean): void {
    this.userVisible = visible;
    this.visible = visible;
  }

  update(et: number, scaleFactor: number, resolvePos?: PositionResolver, camera?: THREE.Camera, canvasHeight?: number): void {
    if (!this.userVisible) return;

    const resolver = this.fixedResolver ?? resolvePos;

    if (this.minTime != null && et < this.minTime) {
      this.visible = false;
      return;
    }
    this.visible = true;

    // Compute time window
    let endEt = et + this.leadDuration;
    if (this.maxTime != null && endEt > this.maxTime) endEt = this.maxTime;

    let startEt = endEt - this.trailDuration;
    if (this.minTime != null && startEt < this.minTime) startEt = this.minTime;
    const trajStart = this.body.trajectory.startTime;
    if (trajStart != null && startEt < trajStart) startEt = trajStart;

    const totalDuration = endEt - startEt;
    if (totalDuration <= 0) {
      this.trailLine.geometry.setDrawRange(0, 0);
      return;
    }

    // Screen-space threshold for subdivision (radians per pixel × pixels)
    let threshold = 0; // 0 = no adaptive
    let camLocalX = 0, camLocalY = 0, camLocalZ = 0;
    if (camera && canvasHeight && canvasHeight > 0 && camera instanceof THREE.PerspectiveCamera) {
      const pixelScale = 2 * Math.tan(camera.fov * Math.PI / 360) / canvasHeight;
      threshold = this.subdivisionPixels * pixelScale;
      camLocalX = camera.position.x - this.position.x;
      camLocalY = camera.position.y - this.position.y;
      camLocalZ = camera.position.z - this.position.z;
    }

    // Phase 1: Coarse uniform samples
    const coarseCount = Math.min(this.numCoarse, this.maxPoints);
    const coarseSamples: Sample[] = new Array(coarseCount);
    const dt = totalDuration / (coarseCount - 1);
    for (let i = 0; i < coarseCount; i++) {
      const t = startEt + i * dt;
      const pos = this.resolveAt(t, resolver);
      coarseSamples[i] = { t, x: pos[0], y: pos[1], z: pos[2] };
    }

    // Phase 2: Pure recursive subdivision like Cosmographia's curveplot.cpp.
    // Each coarse segment recurses to whatever depth it needs.
    // Segments near the camera get deeply subdivided; distant segments stay coarse.

    const maxDepth = 14;
    let vertIdx = 0;

    const emitVertex = (s: Sample): void => {
      if (vertIdx >= this.maxPoints) return;
      this.trailPositions[vertIdx * 3] = s.x * scaleFactor;
      this.trailPositions[vertIdx * 3 + 1] = s.y * scaleFactor;
      this.trailPositions[vertIdx * 3 + 2] = s.z * scaleFactor;

      const fadeT = (s.t - startEt) / totalDuration;
      const fade = this.fadeFraction > 0 ? Math.min(fadeT / this.fadeFraction, 1) : 1;
      this.trailColors[vertIdx * 3] = this.baseColor.r * fade;
      this.trailColors[vertIdx * 3 + 1] = this.baseColor.g * fade;
      this.trailColors[vertIdx * 3 + 2] = this.baseColor.b * fade;
      vertIdx++;
    };

    // Recursively subdivide segment [s0, s1). Emits s0, subdivides interior, but NOT s1.
    const subdivide = (s0: Sample, s1: Sample, depth: number): void => {
      if (vertIdx >= this.maxPoints) return;

      if (threshold > 0 && depth < maxDepth) {
        const midT = (s0.t + s1.t) * 0.5;
        const midPos = this.resolveAt(midT, resolver);
        const linMx = (s0.x + s1.x) * 0.5, linMy = (s0.y + s1.y) * 0.5, linMz = (s0.z + s1.z) * 0.5;
        const devX = midPos[0] - linMx, devY = midPos[1] - linMy, devZ = midPos[2] - linMz;
        const deviationScene = Math.sqrt(devX * devX + devY * devY + devZ * devZ) * scaleFactor;

        const mx = linMx * scaleFactor, my = linMy * scaleFactor, mz = linMz * scaleFactor;
        const dx = mx - camLocalX, dy = my - camLocalY, dz = mz - camLocalZ;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // Only subdivide based on curvature (midpoint deviation from chord),
        // not chord length. Long straight segments don't need splitting.
        if (dist > 0 && deviationScene / dist >= threshold) {
          const mid: Sample = { t: midT, x: midPos[0], y: midPos[1], z: midPos[2] };
          subdivide(s0, mid, depth + 1);
          subdivide(mid, s1, depth + 1);
          return;
        }
      }

      emitVertex(s0);
    };

    for (let i = 0; i < coarseCount - 1 && vertIdx < this.maxPoints; i++) {
      subdivide(coarseSamples[i], coarseSamples[i + 1], 0);
    }
    if (vertIdx < this.maxPoints) {
      emitVertex(coarseSamples[coarseCount - 1]);
    }

    const count = vertIdx;

    this.trailLine.geometry.setDrawRange(0, count);
    this.trailLine.geometry.attributes.position.needsUpdate = true;
    this.trailLine.geometry.attributes.color.needsUpdate = true;
    this.trailLine.geometry.computeBoundingSphere();

    // Full orbit ring
    if (this.orbitLine && this.orbitPositions && this.orbitPeriod > 0) {
      const orbitDt = this.orbitPeriod / this.orbitNumPoints;
      for (let i = 0; i < this.orbitNumPoints; i++) {
        const t = et + i * orbitDt;
        const pos = this.resolveAt(t, resolver);
        this.orbitPositions[i * 3] = pos[0] * scaleFactor;
        this.orbitPositions[i * 3 + 1] = pos[1] * scaleFactor;
        this.orbitPositions[i * 3 + 2] = pos[2] * scaleFactor;
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

  dispose(): void {
    this.trailLine.geometry.dispose();
    (this.trailLine.material as THREE.Material).dispose();
    if (this.orbitLine) {
      this.orbitLine.geometry.dispose();
      (this.orbitLine.material as THREE.Material).dispose();
    }
  }
}
