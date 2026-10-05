import { describe, expect, it } from 'vitest';
import { chooseCalloutPlacement, type CalloutObstacles } from './EventCallout.js';

const viewport = { width: 800, height: 600 };
const empty: CalloutObstacles = { rects: [], path: [], discs: [] };
const contains = (box: { x0: number; y0: number; x1: number; y1: number }, x: number, y: number) =>
  x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;

describe('chooseCalloutPlacement', () => {
  it('defaults up and to the right, offset from the anchor with a leader', () => {
    const p = chooseCalloutPlacement(400, 300, 160, 34, viewport, empty);
    expect(p.direction).toBe('ne');
    expect(p.box.x0).toBeGreaterThan(400);
    expect(p.box.y1).toBeLessThan(300);
    expect(contains(p.box, 400, 300)).toBe(false);
    // The leader starts outside the glyph and ends on the box edge.
    expect(Math.hypot(p.leader[0] - 400, p.leader[1] - 300)).toBeGreaterThan(7);
    expect(p.leader[4]).toBeCloseTo(p.box.x0);
  });

  it('flips away from viewport edges', () => {
    expect(chooseCalloutPlacement(780, 300, 160, 34, viewport, empty).direction).toMatch(/w$/);
    expect(chooseCalloutPlacement(400, 12, 160, 34, viewport, empty).direction).toMatch(/^s/);
    expect(chooseCalloutPlacement(785, 590, 160, 34, viewport, empty).direction).toBe('nw');
  });

  it('keeps off a pinned label sitting in the default slot', () => {
    const label = { x0: 405, y0: 250, x1: 560, y1: 300, weight: 3 };
    const p = chooseCalloutPlacement(400, 300, 160, 34, viewport, { ...empty, rects: [label] });
    const overlap = Math.min(p.box.x1, label.x1) > Math.max(p.box.x0, label.x0) &&
      Math.min(p.box.y1, label.y1) > Math.max(p.box.y0, label.y0);
    expect(overlap).toBe(false);
  });

  it('prefers the side of the trajectory with empty space', () => {
    // A path running up-right through the anchor occupies the NE quadrant.
    const path: number[] = [];
    for (let t = 0; t < 200; t += 4) path.push(400 + t, 300 - t * 0.35);
    const p = chooseCalloutPlacement(400, 300, 160, 34, viewport, { ...empty, path });
    let covered = 0;
    for (let i = 0; i < path.length; i += 2) if (contains(p.box, path[i], path[i + 1])) covered++;
    expect(covered).toBe(0);
  });

  it('holds its previous placement when alternatives are only marginally better', () => {
    const first = chooseCalloutPlacement(400, 300, 160, 34, viewport, empty, 'se:16');
    expect(first.key).toBe('se:16');
  });

  it('runs the leader into the box corner nearest the anchor', () => {
    const at = (x: number, y: number) => chooseCalloutPlacement(x, y, 160, 34, viewport, empty);
    const ne = at(400, 300); // above right: bottom-left corner, along the border row
    expect([ne.leader[4], ne.leader[5]]).toEqual([ne.box.x0, ne.box.y1 - 1]);
    const sw = at(780, 20); // flipped below left: top-right corner
    expect(sw.direction).toBe('sw');
    expect([sw.leader[4], sw.leader[5]]).toEqual([sw.box.x1, sw.box.y0]);
  });
});
