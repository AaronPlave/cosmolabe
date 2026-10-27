import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
// @ts-expect-error -- the library's own fade wrapper, which ships no type declarations
import { wrapFadeMaterial } from '3d-tiles-renderer/src/three/plugins/fade/wrapFadeMaterial.js';
import { tileFade } from '../geographic/TileFade.js';

describe('tileFade', () => {
  it('reads the cross-fade TilesFadePlugin set on a tile material, only while it fades', () => {
    const material = new THREE.MeshBasicMaterial();
    expect(tileFade(material)).toBeNull();
    const params = wrapFadeMaterial(material, material.onBeforeCompile);
    params.fadeIn.value = 0.25; params.fadeOut.value = 0.5;
    // Wrapped but not fading: the plugin leaves the dither off.
    expect(tileFade(material)).toBeNull();
    material.defines!.FEATURE_FADE = 1;
    expect(tileFade(material)).toEqual({ fadeIn: 0.25, fadeOut: 0.5 });
    expect(tileFade([material])).toEqual({ fadeIn: 0.25, fadeOut: 0.5 });
    expect(tileFade(undefined)).toBeNull();
  });
});
