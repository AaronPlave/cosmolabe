import * as THREE from 'three';
import { exploratoryData, hasLineOfSight, PLUGIN_DATA_COLORS, type ContactWindow, type HostData, type PluginData } from '@cosmolabe/core';
import type { RendererPlugin } from '../RendererPlugin.js';
import type { RendererContext } from '../RendererContext.js';

/** A communication link between two bodies during a time window. */
export interface CommLink extends ContactWindow {
  /** @deprecated Colors follow data authority; this override is ignored. */
  color?: number | string;
}

/**
 * Stock plugin: draws lines between spacecraft and ground stations/relays
 * during host contact windows, or exploratory line-of-sight within candidate windows.
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
  private contacts: HostData<readonly ContactWindow[]> | undefined;

  /** Undefined enables geometry fallback. An empty host schedule means no
   * contacts: it must not fall back to viewer computations. */
  setContactWindows(contacts: HostData<readonly ContactWindow[]> | undefined): void {
    if (contacts) {
      for (const window of contacts.value) {
        if (!Number.isFinite(window.startEt) || !Number.isFinite(window.endEt) || window.endEt < window.startEt) {
          throw new Error('Invalid contact window');
        }
      }
    }
    this.contacts = contacts;
    if (this.ctx) this.rebuild();
  }

  /** The current strategy's product, available to inspectors and hosts. */
  get data(): PluginData<readonly ContactWindow[]> {
    return this.contacts ?? exploratoryData(this.links, {
      id: 'comm-link:line-of-sight', kind: 'analysis', classification: 'exploratory',
      source: 'Viewer straight-line geometry; link intervals are candidate bounds',
    });
  }
  private lines: Array<{ link: ContactWindow; line: THREE.Line }> = [];
  private ctx: RendererContext | null = null;

  /** Set the communication links. Rebuilds visuals if already attached. */
  setLinks(links: CommLink[]): void {
    this.links = links.map(link => ({ ...link }));
    if (this.ctx) this.rebuild();
  }

  onSceneSetup(ctx: RendererContext): void {
    this.ctx = ctx;
    this.rebuild();
  }

  onBeforeRender(et: number, ctx: RendererContext): void {
    for (const entry of this.lines) {
      const { link, line } = entry;
      const validity = this.contacts?.provenance.validity;
      const active = Number.isFinite(et) && et >= link.startEt && et <= link.endEt
        && (!validity || (et >= validity.startEt && et <= validity.endEt))
        && (this.contacts !== undefined || hasLineOfSight(ctx.universe, link.spacecraft, link.station, et));
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
    this.ctx = null;
  }

  private rebuild(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    this.dispose();
    this.ctx = ctx;

    for (const link of this.contacts?.value ?? this.links) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));

      const material = new THREE.LineBasicMaterial({
        color: this.contacts ? PLUGIN_DATA_COLORS.host : PLUGIN_DATA_COLORS.exploratory,
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
