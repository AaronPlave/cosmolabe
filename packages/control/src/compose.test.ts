import { describe, expect, it } from 'vitest';
import { FakeViewer } from './__tests__/fake-host.js';
import { composeView } from './compose.js';
import { checkGoal } from './outcome.js';
import type { ScriptVec3 } from './contracts.js';

/** Psyche close-up at a paused encounter epoch, Mars ~10,000 km away and out of frame (#345). */
function psycheCloseUp(mars: ScriptVec3 = [-6000, 1500, 7800], distanceKm = 0.06) {
  const host = new FakeViewer();
  host.objects = ['Psyche', 'Mars', 'Sun'];
  host.bodies = { Psyche: { position: [0, 0, 0], radiusKm: 0.0125 }, Mars: { position: mars, radiusKm: 3389.5 } };
  host.camera = { position: [0, 0, distanceKm], target: [0, 0, 0], up: [0, 1, 0], fov: 45 };
  host.tracked = 'Psyche';
  host.selected = 'Psyche';
  host.time = 832_000_000;
  host.playing = false;
  return host;
}

const goal = { kind: 'camera-composition', anchor: 'Psyche', include: ['Mars'], maxAnchorRangeKm: 0.07, paused: true, et: 832_000_000 } as const;

describe('composeView', () => {
  it('orbits around the anchor until Mars is in view, keeping distance, clock and selection', () => {
    const host = psycheCloseUp();
    expect(checkGoal(host, goal).status).toBe('unmet');
    const out = composeView(host, 'Psyche', ['Mars']);
    expect(out.status).toBe('composed');
    expect(out.moves.length).toBeLessThanOrEqual(12);
    expect(Math.hypot(...host.camera.position)).toBeCloseTo(0.06, 9);
    expect(host.calls.every(c => c.startsWith('circleCenter'))).toBe(true);
    expect([host.time, host.selected, host.tracked]).toEqual([832_000_000, 'Psyche', 'Psyche']);
    const report = checkGoal(host, goal);
    expect(report.status, JSON.stringify(report.checks)).toBe('met');
  });

  it.each([
    ['behind the camera', [0, 0, 10_000]], ['dead ahead behind Psyche', [0, 0, -10_000]], ['overhead', [0, 10_000, 0]],
    ['below and left', [-7000, -7000, 1000]], ['right', [10_000, 0, 0]],
  ] as const)('handles Mars %s', (_label, mars) => {
    const host = psycheCloseUp(mars as unknown as ScriptVec3);
    composeView(host, 'Psyche', ['Mars']);
    expect(checkGoal(host, goal).status).toBe('met');
  });

  it('converges from any direction within its bounded search', () => {
    let seed = 7, composed = 0;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 300; i++) {
      const [x, y, z] = [rand() - 0.5, rand() - 0.5, rand() - 0.5], n = Math.hypot(x, y, z);
      const host = psycheCloseUp([x / n * 10_000, y / n * 10_000, z / n * 10_000], 0.03 + rand() * 0.2);
      host.camera = { ...host.camera, fov: 30 + rand() * 40 };
      const before = host.camera;
      try { composeView(host, 'Psyche', ['Mars']); } catch (err) {
        // The only acceptable failure: honestly impossible at this distance, camera untouched.
        expect(String(err)).toMatch(/fills the view/);
        expect(host.camera).toBe(before);
        continue;
      }
      expect(checkGoal(host, { ...goal, maxAnchorRangeKm: 0.25 }).status).toBe('met');
      composed++;
    }
    expect(composed).toBeGreaterThan(250);
  });

  it('does nothing when the goal already holds', () => {
    const host = psycheCloseUp([-3600, 0, -10_000]);
    expect(composeView(host, 'Psyche', ['Mars']).status).toBe('unchanged');
    expect(host.calls).toEqual([]);
  });

  it('refuses without moving when the anchor fills the view, and says how far out would work', () => {
    const host = psycheCloseUp(undefined, 0.013);
    const before = host.camera;
    expect(() => composeView(host, 'Psyche', ['Mars'])).toThrow(/fills the view.*km would leave room.*did not move/);
    expect(host.camera).toBe(before);
  });

  it('reports a target hidden behind a nearer body instead of claiming success', () => {
    const host = psycheCloseUp();
    const m = host.bodies.Mars.position, n = Math.hypot(...m);
    host.bodies.Phobos = { position: m.map(v => v / n * 100) as unknown as ScriptVec3, radiusKm: 50 };
    expect(() => composeView(host, 'Psyche', ['Mars'])).toThrow(/Mars is hidden behind Phobos/);
    expect(Math.hypot(...host.camera.position)).toBeCloseTo(0.06, 9);
  });

  it('refuses an anchor the camera does not orbit, and unknown names', () => {
    const host = psycheCloseUp();
    host.tracked = 'Mars';
    expect(() => composeView(host, 'Psyche', ['Mars'])).toThrow(/orbits Mars, not Psyche/);
    host.tracked = 'Psyche';
    expect(() => composeView(host, 'Psyche', ['Deimos'])).toThrow(/not in this scene: Deimos/);
    expect(host.calls).toEqual([]);
  });
});
