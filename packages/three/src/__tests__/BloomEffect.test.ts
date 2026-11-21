import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BloomEffect } from '../BloomEffect.js';

// Issue #350: the bloom composer must match the drawing buffer it composites
// onto at every DPR, and must not reallocate when nothing changed.

function fakeRenderer(buffer: { x: number; y: number }, pixelRatio: number) {
  return {
    getPixelRatio: () => pixelRatio,
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(buffer.x, buffer.y),
  } as unknown as THREE.WebGLRenderer;
}

describe('BloomEffect sizing', () => {
  it('sizes every target in device pixels from the drawing buffer', () => {
    const buffer = { x: 2560, y: 1600 };
    const bloom = new BloomEffect(fakeRenderer(buffer, 2), new THREE.Scene(), new THREE.PerspectiveCamera(), 1280, 800);
    const composer = (bloom as unknown as { bloomComposer: { renderTarget1: THREE.WebGLRenderTarget; renderTarget2: THREE.WebGLRenderTarget } }).bloomComposer;
    const pass = (bloom as unknown as { bloomPass: { renderTargetBright: THREE.WebGLRenderTarget } }).bloomPass;
    expect([composer.renderTarget1.width, composer.renderTarget1.height]).toEqual([2560, 1600]);
    expect([pass.renderTargetBright.width, pass.renderTargetBright.height]).toEqual([1280, 800]);

    // DPR change plus a fractional-DPR resize: 1111 × 1.25 fitted to 1389.
    buffer.x = 1389; buffer.y = 1000;
    bloom.setSize(1111, 800);
    expect([composer.renderTarget1.width, composer.renderTarget2.width]).toEqual([1389, 1389]);
    expect(pass.renderTargetBright.width).toBe(Math.round(1389 / 2));

    // Unchanged buffer: no reallocation.
    const target = composer.renderTarget1;
    let resized = false;
    const original = target.setSize.bind(target);
    target.setSize = (w, h, d) => { resized = true; original(w, h, d); };
    bloom.setSize(1111, 800);
    expect(resized).toBe(false);
  });
});
