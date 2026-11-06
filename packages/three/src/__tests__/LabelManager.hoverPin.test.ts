import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { LabelManager } from '../LabelManager.js';
import type { BodyMesh } from '../BodyMesh.js';

// #337 review: hover temporarily pins a label so it survives decluttering, but
// that transient pin must not read as a selected/tracked focus.

function stubCanvas(): void {
  vi.stubGlobal('document', {
    createElement: () => {
      const ctx = { font: '', textBaseline: '', shadowColor: '', shadowBlur: 0, fillStyle: '',
        measureText: () => ({ width: 40 }), fillText() {} };
      return { width: 64, height: 24, getContext: () => ctx };
    },
  });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
}

const body = (name: string) => ({
  body: { name, classification: 'spacecraft', geometryType: 'Point', labelColor: undefined, geometryData: undefined },
  position: new THREE.Vector3(), parent: new THREE.Object3D(), present: true, displayRadius: 1, scaleFactor: 1e-6,
}) as unknown as BodyMesh;

afterEach(() => vi.unstubAllGlobals());

describe('LabelManager.isLabelPinnedByHost', () => {
  it('is false for a hover-only pin, true for a host pin, and survives hover on a host-pinned label', () => {
    stubCanvas();
    const labels = new LabelManager(undefined as unknown as HTMLElement);
    labels.addLabel(body('Clipper'));
    labels.addLabel(body('Other'));

    labels.setLabelHighlighted('Clipper');
    expect(labels.isLabelPinnedByHost('Clipper')).toBe(false);
    labels.setLabelHighlighted(null);
    expect(labels.isLabelPinnedByHost('Clipper')).toBe(false);

    labels.setLabelPinned('Clipper', true);
    expect(labels.isLabelPinnedByHost('Clipper')).toBe(true);
    labels.setLabelHighlighted('Clipper'); // hovering a selected body keeps it selected
    expect(labels.isLabelPinnedByHost('Clipper')).toBe(true);
    labels.setLabelHighlighted(null);
    expect(labels.isLabelPinnedByHost('Clipper')).toBe(true);

    labels.setLabelPinned('Clipper', false);
    expect(labels.isLabelPinnedByHost('Clipper')).toBe(false);
    expect(labels.isLabelPinnedByHost('Other')).toBe(false);
  });
});
