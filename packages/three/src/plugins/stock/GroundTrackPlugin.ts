import * as THREE from 'three';
import type { RendererPlugin } from '../RendererPlugin.js';
import type { RendererContext } from '../RendererContext.js';

/** Ground track configuration for a spacecraft. */
export interface GroundTrackConfig {
  /** Spacecraft body name. */
  bodyName: string;
  /** Parent body whose surface the track is drawn on. Inferred from body.parentName if omitted. */
  parentName?: string;
  /** Track color. Default: 0xffff00. */
  color?: number | string;
  /** How many past points to keep in the trail. Default: 500. */
  maxPoints?: number;
  /** Minimum time between samples in seconds. Default: 60. */
  sampleInterval?: number;
}

/**
 * Stock plugin: draws the sub-spacecraft ground track on a parent body's surface.
 * Projects the spacecraft's position onto the surface sphere each frame.
 *
 * Usage:
 *   const plugin = new GroundTrackPlugin();
 *   plugin.setTracks([{ bodyName: 'ISS' }]);
 *   renderer.use(plugin);
 */
export class GroundTrackPlugin implements RendererPlugin {
  readonly name = 'ground-track';

  private configs: GroundTrackConfig[] = [];
  private tracks: Array<{
    config: GroundTrackConfig;
    parentName: string;
    line: THREE.Line;
    positions: Float32Array;
    count: number;
    maxPoints: number;
    lastSampleEt: number;
    sampleInterval: number;
  }> = [];
  private ctx: RendererContext | null = null;

  /** Set the ground track configurations. Rebuilds visuals if already attached. */
  setTracks(configs: GroundTrackConfig[]): void {
    this.configs = configs;
    if (this.ctx) this.rebuild();
  }

  onSceneSetup(ctx: RendererContext): void {
    this.ctx = ctx;
    this.rebuild();
  }

  onBeforeRender(et: number, ctx: RendererContext): void {
    for (const track of this.tracks) {
      const body = ctx.universe.getBody(track.config.bodyName);
      const parent = ctx.universe.getBody(track.parentName);
      const parentBm = ctx.getBodyMesh(track.parentName);
      if (!body || !parent || !parentBm || !parent.radii) {
        track.line.visible = false;
        continue;
      }

      track.line.visible = true;

      // Sample at intervals
      if (et - track.lastSampleEt < track.sampleInterval) continue;
      track.lastSampleEt = et;

      // Compute sub-spacecraft point: project onto parent sphere
      const scState = body.stateAt(et);
      const parentState = parent.stateAt(et);
      const dx = scState.position[0] - parentState.position[0];
      const dy = scState.position[1] - parentState.position[1];
      const dz = scState.position[2] - parentState.position[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist === 0) continue;

      // Point on the surface in the direction of the spacecraft
      const r = Math.max(...parent.radii);
      const surfX = (dx / dist) * r;
      const surfY = (dy / dist) * r;
      const surfZ = (dz / dist) * r;

      // Convert to scene coordinates relative to parent body mesh position
      const sf = ctx.scaleFactor;
      const sx = parentBm.position.x + surfX * sf;
      const sy = parentBm.position.y + surfY * sf;
      const sz = parentBm.position.z + surfZ * sf;

      // Shift buffer if full (ring buffer behavior)
      if (track.count >= track.maxPoints) {
        track.positions.copyWithin(0, 3, track.maxPoints * 3);
        track.count = track.maxPoints - 1;
      }

      const i = track.count * 3;
      track.positions[i] = sx;
      track.positions[i + 1] = sy;
      track.positions[i + 2] = sz;
      track.count++;

      track.line.geometry.setDrawRange(0, track.count);
      track.line.geometry.attributes.position.needsUpdate = true;
      track.line.geometry.computeBoundingSphere();
    }
  }

  dispose(): void {
    for (const track of this.tracks) {
      track.line.geometry.dispose();
      (track.line.material as THREE.Material).dispose();
      this.ctx?.scene.remove(track.line);
    }
    this.tracks = [];
  }

  private rebuild(): void {
    if (!this.ctx) return;
    this.dispose();

    for (const config of this.configs) {
      const body = this.ctx.universe.getBody(config.bodyName);
      const parentName = config.parentName ?? body?.parentName ?? '';
      const maxPoints = config.maxPoints ?? 500;

      const positions = new Float32Array(maxPoints * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setDrawRange(0, 0);

      const material = new THREE.LineBasicMaterial({
        color: config.color ?? 0xffff00,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
      });

      const line = new THREE.Line(geometry, material);
      line.renderOrder = 1; // render on top of body surface
      this.ctx.scene.add(line);

      this.tracks.push({
        config,
        parentName,
        line,
        positions,
        count: 0,
        maxPoints,
        lastSampleEt: -Infinity,
        sampleInterval: config.sampleInterval ?? 60,
      });
    }
  }
}
