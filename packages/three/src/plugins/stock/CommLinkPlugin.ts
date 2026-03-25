import * as THREE from 'three';
import type { RendererPlugin } from '../RendererPlugin.js';
import type { RendererContext } from '../RendererContext.js';

/** A communication link between two bodies during a time window. */
export interface CommLink {
  /** Spacecraft body name. */
  spacecraft: string;
  /** Ground station or relay body name. */
  station: string;
  startEt: number;
  endEt: number;
  /** Line color. Default: 0x00cc66. */
  color?: number | string;
}

/**
 * Stock plugin: draws lines between spacecraft and ground stations/relays
 * during active communication windows.
 *
 * Usage:
 *   const plugin = new CommLinkPlugin();
 *   plugin.setLinks([
 *     { spacecraft: 'SC', station: 'DSN-Goldstone', startEt: 100, endEt: 500 },
 *   ]);
 *   renderer.use(plugin);
 */
export class CommLinkPlugin implements RendererPlugin {
  readonly name = 'comm-link';

  private links: CommLink[] = [];
  private lines: Array<{ link: CommLink; line: THREE.Line }> = [];
  private ctx: RendererContext | null = null;

  /** Set the communication links. Rebuilds visuals if already attached. */
  setLinks(links: CommLink[]): void {
    this.links = links;
    if (this.ctx) this.rebuild();
  }

  onSceneSetup(ctx: RendererContext): void {
    this.ctx = ctx;
    this.rebuild();
  }

  onBeforeRender(et: number, ctx: RendererContext): void {
    for (const entry of this.lines) {
      const { link, line } = entry;
      const active = et >= link.startEt && et <= link.endEt;
      if (!active) {
        line.visible = false;
        continue;
      }

      const scBm = ctx.getBodyMesh(link.spacecraft);
      const stBm = ctx.getBodyMesh(link.station);
      if (!scBm || !stBm) {
        line.visible = false;
        continue;
      }

      line.visible = true;
      const positions = line.geometry.attributes.position as THREE.BufferAttribute;
      positions.setXYZ(0, scBm.position.x, scBm.position.y, scBm.position.z);
      positions.setXYZ(1, stBm.position.x, stBm.position.y, stBm.position.z);
      positions.needsUpdate = true;
      line.geometry.computeBoundingSphere();
    }
  }

  dispose(): void {
    for (const entry of this.lines) {
      entry.line.geometry.dispose();
      (entry.line.material as THREE.Material).dispose();
      this.ctx?.scene.remove(entry.line);
    }
    this.lines = [];
  }

  private rebuild(): void {
    if (!this.ctx) return;
    this.dispose();

    for (const link of this.links) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));

      const material = new THREE.LineBasicMaterial({
        color: link.color ?? 0x00cc66,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      });

      const line = new THREE.Line(geometry, material);
      line.visible = false;
      line.renderOrder = -1;
      this.ctx.scene.add(line);
      this.lines.push({ link, line });
    }
  }
}
