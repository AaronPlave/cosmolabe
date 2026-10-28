import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as THREE from 'three';
import { TilesFadePlugin } from '3d-tiles-renderer/three/plugins';
// @ts-expect-error -- the library's own fade wrapper, which ships no type declarations
import { wrapFadeMaterial } from '3d-tiles-renderer/src/three/plugins/fade/wrapFadeMaterial.js';
import { tileFade, TILE_FADE_TESTED_VERSION } from '../geographic/TileFade.js';

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

  it('says when a tile fades but its fade cannot be read, rather than treating it as settled', () => {
    const material = new THREE.MeshBasicMaterial();
    material.defines = { FEATURE_FADE: 1 };
    expect(tileFade(material)).toBe('unreadable');
  });

  // The contract as the app uses it: the bundled TilesFadePlugin (the build TerrainManager
  // imports), driven through its own material manager the way it fades a tile. If an upgrade
  // changes where or how the fade is kept, this fails rather than overlays silently doubling.
  it('reads the fade the bundled TilesFadePlugin applies, on the tested library version', () => {
    // The package exports no package.json; find it beside the entry the app imports.
    const entry = fileURLToPath(import.meta.resolve('3d-tiles-renderer/three/plugins'));
    const pkg = JSON.parse(readFileSync(join(entry, '..', '..', 'package.json'), 'utf8')) as { name: string; version: string };
    expect(pkg.name).toBe('3d-tiles-renderer');
    expect(pkg.version).toBe(TILE_FADE_TESTED_VERSION);
    const plugin = new TilesFadePlugin() as unknown as { _fadeMaterialManager: { prepareScene(s: THREE.Object3D): void; setFade(s: THREE.Object3D, i: number, o: number): void } };
    const manager = plugin._fadeMaterialManager;
    expect(manager, 'TilesFadePlugin keeps its material manager where TileFade expects').toBeDefined();
    const tile = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    tile.add(mesh);
    manager.prepareScene(tile);
    expect(tileFade(mesh.material)).toBeNull();
    manager.setFade(tile, 0.375, 0);
    expect(tileFade(mesh.material)).toEqual({ fadeIn: 0.375, fadeOut: 0 });
    manager.setFade(tile, 1, 0.625);
    expect(tileFade(mesh.material)).toEqual({ fadeIn: 1, fadeOut: 0.625 });
    manager.setFade(tile, 1, 0);
    expect(tileFade(mesh.material)).toBeNull();
  });
});
