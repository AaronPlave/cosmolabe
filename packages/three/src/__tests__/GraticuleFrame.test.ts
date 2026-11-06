import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { LabelManager } from '../LabelManager.js';
import { frameTicks, fairFrameTicks, refineFrameTick, GraticuleFrame } from '../GraticuleFrame.js';

describe('regional coordinate frame', () => {
  it('tracks the same major lines continuously along edges and never duplicates a coordinate', () => {
    const sample = (offset: number) => (x: number, y: number) => ({ latDeg: y / 100 - 4 + offset, lonDeg: x / 100 - 4, incidence: 1 });
    const first = frameTicks(800, 800, [1, 1], sample(0));
    const moved = frameTicks(800, 800, [1, 1], sample(0.01));
    expect(new Set(first.map(t => `${t.axis}:${t.value}:${t.edge}`)).size).toBe(first.length);
    expect(new Set(first.map(t => t.axis)).size).toBe(2);
    for (const t of first) {
      expect(t.value).toBe(Math.round(t.value));
      const next = moved.find(n => n.axis === t.axis && n.value === t.value && n.edge === t.edge)!;
      expect(next.edge).toBe(t.edge);
      if (t.axis === 'latitude') expect(next.y - t.y).toBeCloseTo(-1, 3);
    }
  });
  it('respects rotation and suppresses sky and grazing surface samples', () => {
    const rotated = frameTicks(800, 800, [1, 1], (x, y) => ({ latDeg: x / 100 - 4, lonDeg: y / 100 - 4, incidence: 1 }));
    expect(rotated.filter(t => t.axis === 'latitude').every(t => t.edge >= 2)).toBe(true);
    expect(frameTicks(800, 800, [1, 1], () => null)).toEqual([]);
    expect(frameTicks(800, 800, [1, 1], (x, y) => ({ latDeg: x, lonDeg: y, incidence: 0.2 }))).toEqual([]);
  });
  it('keeps longitude canonical through the seam', () => {
    const ticks = frameTicks(800, 800, [1, 1], (x, y) => ({ latDeg: y / 100 - 4, lonDeg: ((179 + x / 200 + 180) % 360) - 180, incidence: 1 }));
    const longs = ticks.filter(t => t.axis === 'longitude');
    expect(longs.some(t => t.value === -180)).toBe(true);
    expect(longs.every(t => t.value >= -180 && t.value < 180)).toBe(true);
  });
});

afterEach(() => vi.unstubAllGlobals());
function fakeCanvas() { vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ setTransform() {}, strokeText() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} }) }) }); }
it('refines a crossing displaced by rendered tessellation', () => {
  const tick = { axis: 'latitude' as const, value: 0, edge: 1, x: 776, y: 400 };
  expect(refineFrameTick(tick, 800, 800, (x, y) => ({ latDeg: (y - 403) / 100, lonDeg: x, incidence: 1 }))!.y).toBeCloseTo(403, 5);
  expect(refineFrameTick(tick, 800, 800, () => null)).toBeNull();
});
it('interleaves edge and axis opportunities', () => {
  const ticks = [0, 1, 2, 3].flatMap(edge => (['latitude', 'longitude'] as const).flatMap(axis => [0, 1, 2].map(value => ({ axis, edge, value, x: 24, y: 24 }))));
  expect(new Set(fairFrameTicks(ticks).slice(0, 8).map(t => `${t.edge}:${t.axis}`)).size).toBe(8);
});
it('allows a rejected line on another edge and reuses unchanged small textures', () => {
  fakeCanvas(); vi.stubGlobal('devicePixelRatio', 2); const group = new THREE.Group(), frame = new GraticuleFrame(group);
  const manager = { reserveContextRect: () => true } as unknown as LabelManager;
  const hit = vi.fn((x: number, y: number) => ({ latDeg: y / 100 - 4, lonDeg: x / 100 - 4, incidence: 1 }));
  const refine = (t: import('../GraticuleFrame.js').FrameTick) => t.edge === 1 ? null : t;
  frame.update(1920, 1080, [1, 1], manager, hit, refine, 0);
  expect(frame.ticks.some(t => t.edge === 0 && t.axis === 'latitude')).toBe(true);
  const keys = frame.ticks.map(t => `${t.axis}:${t.value}:${t.edge}`).sort(), samples = hit.mock.calls.length, uploads = frame.textureUploads;
  for (let i = 1; i < 8; i++) frame.update(1920, 1080, [1, 1], manager, hit, refine, i * 16);
  expect(frame.ticks.map(t => `${t.axis}:${t.value}:${t.edge}`).sort()).toEqual(keys);
  expect(hit.mock.calls.length).toBe(samples); expect(frame.textureUploads).toBe(uploads);
  expect(frame.textureBytes).toBeLessThan(1920 * 1080 * 16 / 100);
  expect(new Set(frame.ticks.map(t => `${t.axis}:${t.value}`)).size).toBe(frame.ticks.length);
  frame.update(1920, 1080, [1, 1], manager, hit, () => null, 128);
  expect(frame.visible).toBe(false); expect(frame.textureUploads).toBe(uploads);
  frame.dispose(); expect(group.children).toHaveLength(0);
});

it('replaces a texture when DPR changes its allocated dimensions', () => {
  fakeCanvas(); vi.stubGlobal('devicePixelRatio', 1);
  const frame = new GraticuleFrame(new THREE.Group()), manager = { reserveContextRect: () => true } as unknown as LabelManager;
  const hit = (x: number, y: number) => ({ latDeg: y / 100 - 4, lonDeg: x / 100 - 4, incidence: 1 });
  frame.update(800, 800, [1, 1], manager, hit, t => t, 0);
  const maps = frame.elements.map(e => e.sprite.material.map), bytes = frame.textureBytes;
  vi.stubGlobal('devicePixelRatio', 2); frame.update(800, 800, [1, 1], manager, hit, t => t, 16);
  frame.elements.forEach((e, i) => expect(e.sprite.material.map).not.toBe(maps[i]));
  expect(frame.textureBytes).toBe(bytes * 4); frame.dispose();
});
