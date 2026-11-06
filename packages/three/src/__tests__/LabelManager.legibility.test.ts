import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { LabelManager } from '../LabelManager.js';
import type { BodyMesh } from '../BodyMesh.js';

// #337 live-testing feedback: position glyphs follow a *stable* label decision,
// and a tracked/selected entity keeps its label at any density.

function stubDom(): void {
  vi.stubGlobal('document', {
    createElement: () => {
      const ctx = { font: '', textBaseline: '', shadowColor: '', shadowBlur: 0, fillStyle: '',
        measureText: () => ({ width: 80 }), fillText() {} };
      return { width: 96, height: 24, getContext: () => ctx };
    },
  });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
}
afterEach(() => vi.unstubAllGlobals());

const parent = new THREE.Object3D();
function body(name: string, classification: string, position: THREE.Vector3): BodyMesh {
  return {
    body: { name, classification, geometryType: 'Point', labelColor: undefined, geometryData: undefined },
    position, parent, present: true, displayRadius: 1, scaleFactor: 1e-6, dskOccludes: () => null,
  } as unknown as BodyMesh;
}

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 800 / 600, 0.001, 1e6);
  cam.position.set(0, 0, 100); cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
  return cam;
}

function run(labels: LabelManager, bodies: BodyMesh[], frames: number, onFrame?: (i: number) => void): void {
  const cam = camera();
  for (let i = 0; i < frames; i++) {
    onFrame?.(i);
    labels.update(bodies, cam, { width: 800, height: 600 }, { width: 800, height: 600, pixelRatio: 1 });
  }
}

describe('LabelManager legibility state', () => {
  it('a label culled by collision is not legible; a tracked or selected one always is', () => {
    stubDom();
    const labels = new LabelManager(undefined as unknown as HTMLElement);
    // Three labels that pile onto the same screen spot: only the highest priority survives.
    const planet = body('Planet', 'planet', new THREE.Vector3(0, 0, 0));
    const sat = body('Sat', 'spacecraft', new THREE.Vector3(0, 0, 0));
    const rock = body('Rock', 'asteroid', new THREE.Vector3(0, 0, 0));
    for (const b of [planet, sat, rock]) labels.addLabel(b);
    run(labels, [planet, sat, rock], 80);
    expect(labels.getLabelState('Planet')!.legible).toBe(true);
    expect(labels.getLabelState('Sat')!.legible).toBe(false);
    expect(labels.getLabelState('Rock')!.legible).toBe(false);

    // Tracking the asteroid pins its label (moves it to a free slot instead of hiding it).
    labels.setTrackedName('Rock');
    run(labels, [planet, sat, rock], 80);
    expect(labels.getLabelState('Rock')!.legible).toBe(true);
    expect(labels.isFocused('Rock')).toBe(true);
    expect(labels.isLabelPinnedByHost('Rock')).toBe(false); // tracked, but not a host selection

    // Selecting the satellite (host pin) does the same, and hover alone does not.
    labels.setLabelPinned('Sat', true);
    run(labels, [planet, sat, rock], 80);
    expect(labels.getLabelState('Sat')!.legible).toBe(true);
    expect(labels.isFocused('Sat')).toBe(true);
    labels.setTrackedName(null);
    labels.setLabelPinned('Sat', false);
    labels.setLabelHighlighted('Sat'); // hover: pins transiently so the label shows...
    expect(labels.isFocused('Sat')).toBe(false); // ...but is not focus
  });

  it('the decision has hysteresis: it neither flickers on the way in nor out', () => {
    stubDom();
    const labels = new LabelManager(undefined as unknown as HTMLElement);
    const a = body('A', 'planet', new THREE.Vector3(0, 0, 0));
    const b = body('B', 'spacecraft', new THREE.Vector3(0, 0, 0));
    labels.addLabel(a); labels.addLabel(b);
    // B starts clear of A, is then dragged onto A (collision culls it), then released.
    const states: boolean[] = [];
    run(labels, [a, b], 200, (i) => {
      const t = i < 50 ? 30 : i < 130 ? 0 : 30;
      b.position.set(t, 0, 0);
      states.push(labels.getLabelState('B')!.legible);
    });
    const flips = states.slice(1).filter((s, i) => s !== states[i]).length;
    expect(states.at(0)).toBe(false); // initial frame, before the first decision
    expect(states[49]).toBe(true);
    expect(states[129]).toBe(false);
    expect(states.at(-1)).toBe(true);
    expect(flips).toBeLessThanOrEqual(3); // on, off, on: no chatter in between
  });

  it('a label that wins its collision for only a few frames never counts as legible (no flash-in markers)', () => {
    stubDom();
    const labels = new LabelManager(undefined as unknown as HTMLElement);
    const a = body('A', 'planet', new THREE.Vector3(0, 0, 0));
    const b = body('B', 'spacecraft', new THREE.Vector3(0, 0, 0));
    labels.addLabel(a); labels.addLabel(b);
    const states: boolean[] = [];
    // B sits under A (culled), is free for 7 frames, then is covered again; later it stays free for good.
    run(labels, [a, b], 160, (i) => {
      b.position.set(i >= 60 && i < 67 ? 30 : i >= 100 ? 30 : 0, 0, 0);
      states.push(labels.getLabelState('B')!.legible);
    });
    expect(states.slice(0, 100).some(Boolean)).toBe(false); // the brief gap earned nothing
    expect(states.at(-1)).toBe(true);                       // a lasting gap does
  });

  it('reports a hidden or globally disabled label as not legible, and no state for unlabeled bodies', () => {
    stubDom();
    const labels = new LabelManager(undefined as unknown as HTMLElement);
    const a = body('A', 'planet', new THREE.Vector3(0, 0, 0));
    labels.addLabel(a);
    run(labels, [a], 60);
    expect(labels.getLabelState('A')!.legible).toBe(true);
    labels.setLabelVisible('A', false); run(labels, [a], 10);
    expect(labels.getLabelState('A')!.legible).toBe(false);
    labels.setLabelVisible('A', true); run(labels, [a], 60);
    expect(labels.getLabelState('A')!.legible).toBe(true);
    labels.setAllVisible(false);
    expect(labels.getLabelState('A')!.legible).toBe(false);
    expect(labels.getLabelState('Nope')).toBeNull();
  });
});
