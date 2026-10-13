import * as THREE from 'three';
import { formatSurfaceAngle, wrapLongitude } from '@cosmolabe/core';
import type { LabelManager } from './LabelManager.js';

export interface FrameHit { latDeg: number; lonDeg: number; incidence: number; }
export interface FrameTick { axis: 'latitude' | 'longitude'; value: number; x: number; y: number; edge: number; alignmentPx?: number; }
/** Major-line intersections with an inset screen frame, never interior placement. */
export function frameTicks(width: number, height: number, steps: readonly [number, number], hit: (x: number, y: number) => FrameHit | null): FrameTick[] {
  const inset = 24;
  const edges = [[inset, inset, inset, height - inset], [width - inset, inset, width - inset, height - inset],
    [inset, inset, width - inset, inset], [inset, height - inset, width - inset, height - inset]];
  const cache = new Map<string, FrameHit | null>();
  const cachedHit = (x: number, y: number) => {
    const key = `${x.toFixed(6)}:${y.toFixed(6)}`;
    if (!cache.has(key)) cache.set(key, hit(x, y));
    return cache.get(key)!;
  };
  const counts = new Map<string, number>();
  const result: FrameTick[] = [], seen = new Set<string>();
  [1, 0, 2, 3].forEach(edge => {
    const [x0, y0, x1, y1] = edges[edge];
    const point = (t: number) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    const sample = (t: number) => { const [x, y] = point(t); return cachedHit(x, y); };
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
          const id = `${edge}:${axis}:${canonical.toFixed(6)}`;
          const bucket = `${edge}:${axis}`;
          if (seen.has(id) || (counts.get(bucket) ?? 0) >= 16) continue;
          let left = lo, right = hi, lv = start, rv = end, t = lo, valid = true;
          for (let j = 0; j < 4; j++) {
            if (Math.abs(rv - lv) < 1e-12) { valid = false; break; }
            t = left + (right - left) * THREE.MathUtils.clamp((value - lv) / (rv - lv), 0.01, 0.99);
            const h = sample(t);
            if (!h || h.incidence < 0.45) { valid = false; break; }
            const v = coordinate(h);
            if (Math.abs(v - value) < step * 1e-7) break;
            if ((v < value) === (end > start)) { left = t; lv = v; } else { right = t; rv = v; }
          }
          if (!valid) continue;
          const [x, y] = point(t);
          result.push({ axis, value: canonical, x, y, edge }); seen.add(id); counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
        }
      }
    }
  });
  return fairFrameTicks(result);
}

/** Round-robin opportunities across edges and axes, without admission quotas. */
export function fairFrameTicks(ticks: readonly FrameTick[], phase = 0): FrameTick[] {
  const groups = [1, 2, 0, 3].flatMap(edge => ['latitude', 'longitude'].map(axis => ticks.filter(t => t.edge === edge && t.axis === axis)));
  const result: FrameTick[] = [];
  for (let depth = 0; groups.some(g => depth < g.length); depth++) for (let i = 0; i < 8; i++) {
    const tick = groups[(i + phase) % 8][depth]; if (tick) result.push(tick);
  }
  return result;
}
/** Solve on a rendered facet plane; the host checks the final current geometry. */
export function refineFrameTick(tick: FrameTick, width: number, height: number, sample: (x: number, y: number) => FrameHit | null): FrameTick | null {
  const vertical = tick.edge < 2, max = (vertical ? height : width) - 24;
  let t = vertical ? tick.y : tick.x;
  const at = (v: number) => sample(vertical ? tick.x : v, vertical ? v : tick.y);
  for (let i = 0; i < 5; i++) {
    const sign = t + 1 <= max ? 1 : -1, h = at(t), near = at(t + sign);
    if (!h || !near || h.incidence < 0.45) return null;
    const derivative = (tick.axis === 'latitude' ? near.latDeg - h.latDeg : wrapLongitude(near.lonDeg - h.lonDeg)) / sign;
    const error = tick.axis === 'latitude' ? h.latDeg - tick.value : wrapLongitude(h.lonDeg - tick.value);
    const move = error / derivative;
    if (!Number.isFinite(move) || Math.abs(move) > 48) return null;
    if (Math.abs(move) <= 0.02) return { ...tick, x: vertical ? tick.x : t, y: vertical ? t : tick.y };
    t -= move; if (t < 24 || t > max) return null;
  }
  return null;
}
interface FrameElement { sprite: THREE.Sprite; canvas: HTMLCanvasElement; key: string; drawingKey: string; x: number; y: number; width: number; height: number; }
const lineId = (t: FrameTick) => `${t.axis}:${t.value.toFixed(6)}`;
/** Bounded small caption textures: movement changes transforms, not pixels. */
export class GraticuleFrame {
  readonly elements: FrameElement[] = [];
  ticks: FrameTick[] = [];
  textureUploads = 0;
  discoverySamples = 0;
  private discovered: FrameTick[] = [];
  private discoveryKey = '';
  private lastDiscovery = -Infinity;
  private phase = 0;
  private preferredEdges = new Map<string, number>();
  constructor(private readonly group: THREE.Group) {}
  get visible(): boolean { return this.elements.some(e => e.sprite.visible); }
  get textureBytes(): number { return this.elements.reduce((sum, e) => sum + e.canvas.width * e.canvas.height * 4, 0); }
  hide(): void { this.ticks = []; for (const e of this.elements) e.sprite.visible = false; }
  update(width: number, height: number, steps: readonly [number, number], manager: LabelManager,
    hit: (x: number, y: number) => FrameHit | null, refine: (tick: FrameTick) => FrameTick | null, now = performance.now()): void {
    this.hide();
    const discoveryKey = `${width}:${height}:${steps.join(':')}`;
    if (discoveryKey !== this.discoveryKey || now - this.lastDiscovery >= 150) {
      this.discoverySamples = 0;
      this.discovered = frameTicks(width, height, steps, (x, y) => { this.discoverySamples++; return hit(x, y); });
      this.discoveryKey = discoveryKey; this.lastDiscovery = now;
    }
    const accepted = new Set<string>(), attempted = new Set<string>(), used = new Set<FrameElement>();
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);
    const preferred = new Map(this.discovered.filter(t => this.preferredEdges.get(lineId(t)) === t.edge).map(t => [lineId(t), t]));
    const candidates = [...this.discovered].sort((a, b) => Number(this.preferredEdges.has(lineId(b))) - Number(this.preferredEdges.has(lineId(a))));
    const phase = this.phase++ % 8;
    const retained = candidates.filter(t => this.preferredEdges.has(lineId(t)));
    const fresh = candidates.filter(t => !this.preferredEdges.has(lineId(t)));
    for (const candidate of [...fairFrameTicks(retained, phase), ...fairFrameTicks(fresh, phase)]) {
      if (this.ticks.length >= 8) break;
      const wanted = preferred.get(lineId(candidate));
      const proposed = wanted && !attempted.has(`${lineId(wanted)}:${wanted.edge}`) ? wanted : candidate;
      const key = lineId(proposed), attempt = `${key}:${proposed.edge}`;
      if (accepted.has(key) || attempted.has(attempt)) continue;
      attempted.add(attempt);
      const tick = refine(proposed); if (!tick) continue;
      const text = formatSurfaceAngle(tick.value, tick.axis, steps[tick.axis === 'latitude' ? 0 : 1]), w = text.length * 7.3 + 8;
      const x = tick.edge === 0 ? tick.x + w / 2 + 9 : tick.edge === 1 ? tick.x - w / 2 - 9 : tick.x;
      const y = tick.edge === 2 ? tick.y + 17 : tick.edge === 3 ? tick.y - 17 : tick.y;
      const rect = { x0: x - w / 2, x1: x + w / 2, y0: y - 9, y1: y + 9 };
      if (rect.x0 < 0 || rect.x1 > width || rect.y0 < 0 || rect.y1 > height || manager.canReserveContextRect?.(rect) === false || !manager.reserveContextRect(rect)) continue;
      accepted.add(key); this.ticks.push(tick);
      let e = this.elements.find(e => e.key === key && !used.has(e)) ?? this.elements.find(e => !used.has(e));
      if (!e) {
        const canvas = document.createElement('canvas'), sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false }));
        sprite.renderOrder = 10; sprite.userData.gridFrameElement = true; this.group.add(sprite);
        e = { sprite, canvas, key, drawingKey: '', x: 0, y: 0, width: 0, height: 0 }; this.elements.push(e);
      }
      used.add(e); e.key = key;
      const x0 = Math.min(rect.x0, tick.x) - 2, y0 = Math.min(rect.y0, tick.y) - 2;
      e.width = Math.ceil(w + (tick.edge < 2 ? 13 : 4)); e.height = tick.edge < 2 ? 22 : 30;
      e.x = x0 + e.width / 2; e.y = y0 + e.height / 2;
      const drawingKey = `${text}:${tick.edge}:${dpr}`;
      if (e.drawingKey !== drawingKey) {
        const pixelWidth = Math.ceil(e.width * dpr), pixelHeight = Math.ceil(e.height * dpr);
        const resized = e.canvas.width !== pixelWidth || e.canvas.height !== pixelHeight;
        e.canvas.width = pixelWidth; e.canvas.height = pixelHeight;
        // WebGL textures cannot change dimensions after their first upload.
        if (resized) {
          e.sprite.material.map?.dispose(); e.sprite.material.map = new THREE.CanvasTexture(e.canvas);
          e.sprite.material.needsUpdate = true;
        }
        const ctx = e.canvas.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.font = '12px monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
        ctx.strokeStyle = '#101725'; ctx.lineWidth = 1; ctx.strokeText(text, x - x0, y - y0); ctx.fillStyle = '#bac8d8'; ctx.fillText(text, x - x0, y - y0);
        ctx.strokeStyle = '#91a4b9'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(tick.x - x0, tick.y - y0);
        ctx.lineTo(tick.x - x0 + (tick.edge === 0 ? 6 : tick.edge === 1 ? -6 : 0), tick.y - y0 + (tick.edge === 2 ? 6 : tick.edge === 3 ? -6 : 0)); ctx.stroke();
        e.sprite.material.map!.needsUpdate = true; e.drawingKey = drawingKey; this.textureUploads++;
      }
      e.sprite.userData.gridFrameText = text; e.sprite.userData.gridFrameId = key; e.sprite.visible = true;
    }
    this.preferredEdges = new Map(this.ticks.map(t => [lineId(t), t.edge]));
  }
  dispose(): void { for (const { sprite } of this.elements) { sprite.removeFromParent(); sprite.material.map?.dispose(); sprite.material.dispose(); } this.elements.length = 0; this.ticks = []; }
}
