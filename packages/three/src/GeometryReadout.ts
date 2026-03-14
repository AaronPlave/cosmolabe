import * as THREE from 'three';
import type { Body, Universe } from '@spicecraft/core';
import type { BodyMesh } from './BodyMesh.js';
import type { RendererPlugin } from './plugins/RendererPlugin.js';

export interface GeometryReadoutOptions {
  /** Container element for the readout panel */
  container?: HTMLElement;
  /** Which fields to show. Default: all available. */
  fields?: string[];
}

/**
 * Click-to-inspect plugin: click a body in 3D to see geometry readouts.
 * Computes range, relative velocity, sun angle, and basic orbital info
 * from the Universe model (no SPICE required for basic readouts).
 */
export class GeometryReadout implements RendererPlugin {
  name = 'geometry-readout';

  private panel: HTMLDivElement | null = null;
  private container: HTMLElement | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private universe: Universe | null = null;
  private bodyMeshes: Map<string, BodyMesh> = new Map();
  private raycaster = new THREE.Raycaster();
  private selectedBody: Body | null = null;
  private canvas: HTMLElement | null = null;
  private readonly fields: string[] | undefined;
  private readonly onClickBound = this.onClick.bind(this);

  constructor(options: GeometryReadoutOptions = {}) {
    this.container = options.container ?? null;
    this.fields = options.fields;
  }

  onSceneSetup(scene: unknown, camera: unknown, universe: Universe): void {
    this.camera = camera as THREE.PerspectiveCamera;
    this.universe = universe;

    const renderer = (camera as THREE.PerspectiveCamera).parent;
    // Find the canvas from the camera's DOM element
    // We'll attach the click handler later when we have access to the canvas
  }

  /** Must be called after construction to enable picking */
  attachTo(canvas: HTMLCanvasElement, bodyMeshes: Map<string, BodyMesh>): void {
    this.canvas = canvas;
    this.bodyMeshes = bodyMeshes;
    canvas.addEventListener('dblclick', this.onClickBound);
    this.createPanel();
  }

  onRender?(et: number, _scene: unknown, _camera: unknown, universe: Universe): void {
    if (!this.selectedBody || !this.panel) return;
    this.updateReadout(et, universe);
  }

  onPick(body: Body, _et: number, _universe: Universe): void {
    this.selectedBody = body;
    if (this.panel) {
      this.panel.style.display = 'block';
    }
  }

  dispose(): void {
    if (this.canvas) {
      this.canvas.removeEventListener('dblclick', this.onClickBound);
    }
    this.panel?.remove();
  }

  private createPanel(): void {
    const parent = this.container ?? this.canvas?.parentElement;
    if (!parent) return;

    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'absolute',
      top: '70px',
      left: '12px',
      width: '280px',
      background: 'rgba(0, 0, 0, 0.85)',
      color: '#eee',
      fontFamily: 'monospace',
      fontSize: '12px',
      padding: '12px',
      borderRadius: '4px',
      border: '1px solid #444',
      display: 'none',
      pointerEvents: 'auto',
      zIndex: '100',
      maxHeight: '80vh',
      overflowY: 'auto',
    });

    // Close button
    const close = document.createElement('span');
    close.textContent = '\u00d7';
    Object.assign(close.style, {
      position: 'absolute',
      top: '4px',
      right: '8px',
      cursor: 'pointer',
      fontSize: '16px',
      color: '#888',
    });
    close.addEventListener('click', () => {
      this.selectedBody = null;
      if (this.panel) this.panel.style.display = 'none';
    });
    this.panel.appendChild(close);

    parent.appendChild(this.panel);
  }

  private onClick(event: MouseEvent): void {
    if (!this.camera || !this.bodyMeshes.size) return;

    const rect = (event.target as HTMLElement).getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );

    this.raycaster.setFromCamera(mouse, this.camera);

    const meshes: THREE.Object3D[] = [];
    for (const bm of this.bodyMeshes.values()) {
      meshes.push(bm);
    }

    const intersects = this.raycaster.intersectObjects(meshes, true);
    if (intersects.length > 0) {
      // Walk up to find the BodyMesh
      let obj = intersects[0].object;
      while (obj.parent && !this.bodyMeshes.has(obj.name)) {
        obj = obj.parent;
      }
      const bm = this.bodyMeshes.get(obj.name);
      if (bm) {
        this.selectedBody = bm.body;
        if (this.panel) this.panel.style.display = 'block';
      }
    }
  }

  private updateReadout(et: number, universe: Universe): void {
    if (!this.panel || !this.selectedBody) return;
    
    const body = this.selectedBody;
    const state = body.stateAt(et);
    const [x, y, z] = state.position;
    const [vx, vy, vz] = state.velocity;

    const range = Math.sqrt(x * x + y * y + z * z);
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const rangeRate = range > 0 ? (x * vx + y * vy + z * vz) / range : 0;

    // Compute sun angle if Sun exists and this isn't the Sun
    let sunAngle: number | undefined;
    const sun = universe.getBody('Sun');
    if (sun && body.name !== 'Sun') {
      const sunState = sun.stateAt(et);
      const toSun = [
        sunState.position[0] - x,
        sunState.position[1] - y,
        sunState.position[2] - z,
      ];
      const toSunMag = Math.sqrt(toSun[0] ** 2 + toSun[1] ** 2 + toSun[2] ** 2);
      if (range > 0 && toSunMag > 0) {
        // Sun-Origin-Body angle
        const dot = -(x * toSun[0] + y * toSun[1] + z * toSun[2]) / (range * toSunMag);
        sunAngle = Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI);
      }
    }

    // Altitude above parent body surface
    let altitude: number | undefined;
    if (body.parentName) {
      const parent = universe.getBody(body.parentName);
      if (parent?.radii) {
        const parentState = parent.stateAt(et);
        const dx = state.position[0] - parentState.position[0];
        const dy = state.position[1] - parentState.position[1];
        const dz = state.position[2] - parentState.position[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        altitude = dist - Math.max(...parent.radii);
      }
    }

    // Orbital period estimate (vis-viva) if we have parent with mu
    let orbitalPeriod: string | undefined;
    if (body.parentName) {
      const parent = universe.getBody(body.parentName);
      if (parent?.mu && parent.mu > 0) {
        const parentState = parent.stateAt(et);
        const dx = state.position[0] - parentState.position[0];
        const dy = state.position[1] - parentState.position[1];
        const dz = state.position[2] - parentState.position[2];
        const dvx = state.velocity[0] - parentState.velocity[0];
        const dvy = state.velocity[1] - parentState.velocity[1];
        const dvz = state.velocity[2] - parentState.velocity[2];
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const v2 = dvx * dvx + dvy * dvy + dvz * dvz;
        const sma = 1 / (2 / r - v2 / parent.mu);
        if (sma > 0) {
          const T = 2 * Math.PI * Math.sqrt(sma ** 3 / parent.mu);
          orbitalPeriod = formatDuration(T);
        }
      }
    }

    // Build readout HTML
    const lines: string[] = [];
    lines.push(`<div style="color:#88ccff;font-size:14px;margin-bottom:8px;font-weight:bold">${body.name}</div>`);
    if (body.classification) {
      lines.push(`<div style="color:#888">${body.classification}</div>`);
    }
    lines.push('<hr style="border-color:#333;margin:6px 0">');

    lines.push(row('Range from origin', formatDistance(range)));
    lines.push(row('Speed', `${speed.toFixed(2)} km/s`));
    lines.push(row('Range rate', `${rangeRate.toFixed(3)} km/s`));

    if (altitude != null) {
      lines.push(row('Altitude', formatDistance(altitude)));
    }
    if (sunAngle != null) {
      lines.push(row('Sun angle', `${sunAngle.toFixed(1)}\u00b0`));
    }
    if (orbitalPeriod) {
      lines.push(row('Orbital period', orbitalPeriod));
    }

    lines.push('<hr style="border-color:#333;margin:6px 0">');
    lines.push(row('Position X', `${x.toFixed(1)} km`));
    lines.push(row('Position Y', `${y.toFixed(1)} km`));
    lines.push(row('Position Z', `${z.toFixed(1)} km`));

    // Keep close button, replace rest
    while (this.panel.childNodes.length > 1) {
      this.panel.removeChild(this.panel.lastChild!);
    }
    const content = document.createElement('div');
    content.innerHTML = lines.join('');
    this.panel.appendChild(content);
  }
}

function row(label: string, value: string): string {
  return `<div style="display:flex;justify-content:space-between;margin:2px 0"><span style="color:#aaa">${label}</span><span>${value}</span></div>`;
}

function formatDistance(km: number): string {
  const abs = Math.abs(km);
  if (abs >= 1e6) return `${(km / 149597870.7).toFixed(4)} AU`;
  if (abs >= 1000) return `${km.toFixed(0)} km`;
  return `${km.toFixed(2)} km`;
}

function formatDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs >= 365.25 * 86400) return `${(seconds / (365.25 * 86400)).toFixed(2)} years`;
  if (abs >= 86400) return `${(seconds / 86400).toFixed(2)} days`;
  if (abs >= 3600) return `${(seconds / 3600).toFixed(2)} hours`;
  return `${seconds.toFixed(1)} s`;
}
