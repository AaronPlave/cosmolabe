import * as THREE from 'three';
import type { Body } from '@spicecraft/core';
import type { PositionResolver } from './TrajectoryLine.js';

export type EventMarkerType = 'periapsis' | 'apoapsis' | 'ascending_node' | 'descending_node' | 'custom';

export interface EventMarker {
  et: number;
  type: EventMarkerType;
  label?: string;
}

export interface EventMarkersOptions {
  /** Marker size in scene units */
  markerSize?: number;
  /** Colors by event type */
  colors?: Partial<Record<EventMarkerType, number>>;
  /** Max number of markers to display */
  maxMarkers?: number;
}

const DEFAULT_COLORS: Record<EventMarkerType, number> = {
  periapsis: 0x00ff88,
  apoapsis: 0xff4444,
  ascending_node: 0x4488ff,
  descending_node: 0xff8844,
  custom: 0xffffff,
};

/**
 * Displays markers on trajectory lines for orbital events.
 *
 * Can detect periapsis/apoapsis automatically by sampling the trajectory
 * and finding local distance extrema relative to the parent body,
 * or accept pre-computed event markers (e.g., from SPICE geometry finders).
 */
export class EventMarkers extends THREE.Object3D {
  readonly body: Body;
  private markers: EventMarker[] = [];
  private sprites: THREE.Sprite[] = [];
  private readonly options: EventMarkersOptions;
  private readonly parentBody: Body | undefined;
  private readonly textures = new Map<EventMarkerType, THREE.Texture>();
  /** Last window used for auto-detection, so we know when to re-detect */
  private detectionStart = 0;
  private detectionEnd = 0;
  /** Per-body trail/lead durations so markers align with the trajectory line */
  trailDuration = 86400;
  leadDuration = 0;

  constructor(body: Body, parentBody: Body | undefined, options: EventMarkersOptions = {}) {
    super();
    this.body = body;
    this.parentBody = parentBody;
    this.name = `${body.name}_events`;
    this.options = options;
  }

  /** Set pre-computed event markers (e.g., from SPICE EventFinder) */
  setMarkers(markers: EventMarker[]): void {
    this.markers = markers;
    this.rebuildSprites();
  }

  /**
   * Auto-detect periapsis/apoapsis by sampling the trajectory over a time window.
   * This is a simple local-extrema search — no SPICE required.
   */
  detectExtrema(startEt: number, endEt: number, numSamples = 500): void {
    if (!this.parentBody) return;

    this.detectionStart = startEt;
    this.detectionEnd = endEt;

    const dt = (endEt - startEt) / (numSamples - 1);
    const distances: number[] = [];
    const times: number[] = [];

    for (let i = 0; i < numSamples; i++) {
      const t = startEt + i * dt;
      try {
        // body.stateAt(t) gives position relative to its center (parent) body,
        // so the distance to the parent is simply the magnitude of that vector.
        const s = this.body.stateAt(t);
        const dx = s.position[0];
        const dy = s.position[1];
        const dz = s.position[2];
        distances.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
        times.push(t);
      } catch {
        // Trajectory data may not cover this time — skip sample
      }
    }

    const detected: EventMarker[] = [];
    const maxMarkers = this.options.maxMarkers ?? 10;

    for (let i = 1; i < times.length - 1 && detected.length < maxMarkers; i++) {
      if (distances[i] < distances[i - 1] && distances[i] < distances[i + 1]) {
        detected.push({ et: times[i], type: 'periapsis', label: 'Pe' });
      } else if (distances[i] > distances[i - 1] && distances[i] > distances[i + 1]) {
        detected.push({ et: times[i], type: 'apoapsis', label: 'Ap' });
      }
    }

    this.markers = detected;
    this.rebuildSprites();
  }

  /** Update marker positions for current time and scale */
  update(et: number, scaleFactor: number, resolvePos?: PositionResolver): void {
    // Visible window derived from per-body trail/lead durations
    const winStart = et - this.trailDuration;
    const winEnd = et + this.leadDuration;

    // Re-detect when the visible window has drifted past 25% of the detection range
    if (this.parentBody && this.detectionEnd > this.detectionStart) {
      const detectionSpan = this.detectionEnd - this.detectionStart;
      const windowCenter = (winStart + winEnd) / 2;
      const detectionCenter = (this.detectionStart + this.detectionEnd) / 2;
      if (Math.abs(windowCenter - detectionCenter) > detectionSpan * 0.25) {
        this.detectExtrema(winStart, winEnd);
      }
    }

    for (let i = 0; i < this.sprites.length; i++) {
      const marker = this.markers[i];
      const sprite = this.sprites[i];

      sprite.visible = marker.et >= winStart && marker.et <= winEnd;
      if (!sprite.visible) continue;

      try {
        const pos = resolvePos
          ? resolvePos(this.body.name, marker.et)
          : this.body.stateAt(marker.et).position as [number, number, number];
        sprite.position.set(
          pos[0] * scaleFactor,
          pos[1] * scaleFactor,
          pos[2] * scaleFactor,
        );
      } catch {
        sprite.visible = false;
      }
    }
  }

  dispose(): void {
    for (const sprite of this.sprites) {
      sprite.geometry.dispose();
      (sprite.material as THREE.Material).dispose();
    }
    for (const tex of this.textures.values()) tex.dispose();
    this.sprites = [];
    this.textures.clear();
  }

  private rebuildSprites(): void {
    // Remove old sprites
    for (const sprite of this.sprites) {
      this.remove(sprite);
      sprite.geometry.dispose();
      (sprite.material as THREE.Material).dispose();
    }
    this.sprites = [];

    const size = this.options.markerSize ?? 0.02;

    for (const marker of this.markers) {
      const colorHex = this.options.colors?.[marker.type] ?? DEFAULT_COLORS[marker.type];
      const texture = this.getMarkerTexture(marker.type);

      const material = new THREE.SpriteMaterial({
        map: texture,
        color: colorHex,
        transparent: true,
        depthTest: false,
        sizeAttenuation: false,
      });

      const sprite = new THREE.Sprite(material);
      sprite.scale.set(size, size, 1);
      sprite.name = `${marker.type}_${marker.et.toFixed(0)}`;

      this.add(sprite);
      this.sprites.push(sprite);
    }
  }

  private getMarkerTexture(type: EventMarkerType): THREE.Texture {
    let tex = this.textures.get(type);
    if (tex) return tex;

    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = '#ffffff';
    if (type === 'periapsis') {
      // Down-pointing triangle
      ctx.beginPath();
      ctx.moveTo(16, 28);
      ctx.lineTo(4, 4);
      ctx.lineTo(28, 4);
      ctx.closePath();
      ctx.fill();
    } else if (type === 'apoapsis') {
      // Up-pointing triangle
      ctx.beginPath();
      ctx.moveTo(16, 4);
      ctx.lineTo(4, 28);
      ctx.lineTo(28, 28);
      ctx.closePath();
      ctx.fill();
    } else {
      // Diamond
      ctx.beginPath();
      ctx.moveTo(16, 2);
      ctx.lineTo(30, 16);
      ctx.lineTo(16, 30);
      ctx.lineTo(2, 16);
      ctx.closePath();
      ctx.fill();
    }

    tex = new THREE.CanvasTexture(canvas);
    this.textures.set(type, tex);
    return tex;
  }
}
