import * as THREE from 'three';
import { formatSurfaceAngle, wrapLongitude } from '@cosmolabe/core';
import type { LabelManager } from './LabelManager.js';

export interface FrameHit { latDeg: number; lonDeg: number; incidence: number; }
export interface FrameTick { axis: 'latitude' | 'longitude'; value: number; x: number; y: number; edge: number; }
/** Major-line intersections with an inset screen frame, never interior placement. */
export function frameTicks(width: number, height: number, steps: readonly [number, number], hit: (x: number, y: number) => FrameHit | null): FrameTick[] {
  const inset = 24;
  const edges = [[inset, inset, inset, height - inset], [width - inset, inset, width - inset, height - inset],
    [inset, inset, width - inset, inset], [inset, height - inset, width - inset, height - inset]];
  const result: FrameTick[] = [], seen = new Set<string>();
  [1, 0, 2, 3].forEach(edge => {
    const [x0, y0, x1, y1] = edges[edge];
    const point = (t: number) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    const sample = (t: number) => { const [x, y] = point(t); return hit(x, y); };
    for (let i = 0; i < 32; i++) {
      const lo = i / 32, hi = (i + 1) / 32, a = sample(lo), b = sample(hi);
      if (!a || !b || Math.min(a.incidence, b.incidence) < 0.45) continue;
      for (const axis of ['latitude', 'longitude'] as const) {
        const step = steps[axis === 'latitude' ? 0 : 1], start = axis === 'latitude' ? a.latDeg : a.lonDeg;
        const coordinate = (h: FrameHit) => axis === 'latitude' ? h.latDeg : start + wrapLongitude(h.lonDeg - start);
        const end = coordinate(b);
        if (Math.abs(end - start) > step * 8) continue;
        for (let n = Math.ceil(Math.min(start, end) / step); n <= Math.floor(Math.max(start, end) / step); n++) {
          const value = n * step, canonical = axis === 'longitude' ? wrapLongitude(value) : value;
          const id = `${axis}:${canonical.toFixed(6)}`;
          if (seen.has(id)) continue;
          let left = lo, right = hi, valid = true;
          for (let j = 0; j < 18; j++) {
            const middle = (left + right) / 2, h = sample(middle);
            if (!h || h.incidence < 0.45) { valid = false; break; }
            if ((coordinate(h) < value) === (end > start)) left = middle; else right = middle;
          }
          if (!valid) continue;
          const [x, y] = point((left + right) / 2);
          result.push({ axis, value: canonical, x, y, edge }); seen.add(id);
        }
      }
    }
  });
  return result;
}

/** Explicit optional overlay; surface/terrain validation is supplied by the host. */
export class GraticuleFrame {
  readonly sprite: THREE.Sprite;
  readonly canvas = document.createElement('canvas');
  ticks: FrameTick[] = [];
  constructor(group: THREE.Group) {
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(this.canvas), transparent: true,
      depthTest: false, depthWrite: false, sizeAttenuation: false }));
    this.sprite.visible = false; this.sprite.renderOrder = 10; group.add(this.sprite);
  }
  hide(): void { this.sprite.visible = false; this.ticks = []; }
  update(width: number, height: number, steps: readonly [number, number], manager: LabelManager,
    hit: (x: number, y: number) => FrameHit | null, validate: (tick: FrameTick) => boolean): void {
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);
    const wPixels = Math.ceil(width * dpr), hPixels = Math.ceil(height * dpr);
    if (this.canvas.width !== wPixels || this.canvas.height !== hPixels) { this.canvas.width = wPixels; this.canvas.height = hPixels; }
    const ctx = this.canvas.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.font = '12px monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    this.ticks = []; let queries = 0;
    for (const tick of frameTicks(width, height, steps, hit)) {
      if (this.ticks.length >= 8 || queries >= 8) break;
      const text = formatSurfaceAngle(tick.value, tick.axis, steps[tick.axis === 'latitude' ? 0 : 1]);
      const w = text.length * 7.3 + 8;
      const x = tick.edge === 0 ? tick.x + w / 2 + 9 : tick.edge === 1 ? tick.x - w / 2 - 9 : tick.x;
      const y = tick.edge === 2 ? tick.y + 17 : tick.edge === 3 ? tick.y - 17 : tick.y;
      const rect = { x0: x - w / 2, x1: x + w / 2, y0: y - 9, y1: y + 9 };
      if (rect.x0 < 0 || rect.x1 > width || rect.y0 < 0 || rect.y1 > height || manager.canReserveContextRect?.(rect) === false) continue;
      queries++; if (!validate(tick) || !manager.reserveContextRect(rect)) continue;
      ctx.strokeStyle = '#101725'; ctx.lineWidth = 1; ctx.strokeText(text, x, y);
      ctx.fillStyle = '#bac8d8'; ctx.fillText(text, x, y);
      ctx.strokeStyle = '#91a4b9'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(tick.x, tick.y);
      ctx.lineTo(tick.x + (tick.edge === 0 ? 6 : tick.edge === 1 ? -6 : 0), tick.y + (tick.edge === 2 ? 6 : tick.edge === 3 ? -6 : 0)); ctx.stroke();
      this.ticks.push(tick);
    }
    this.sprite.material.map!.needsUpdate = true; this.sprite.visible = this.ticks.length > 0;
  }
  dispose(): void { this.sprite.removeFromParent(); this.sprite.material.map?.dispose(); this.sprite.material.dispose(); }
}
