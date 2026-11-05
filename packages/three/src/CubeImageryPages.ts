import * as THREE from 'three';
import { cubeTileId, type CubeFace } from './surface/CubeSphere.js';
import type { ImageryAddress } from './surface/CubeImagery.js';
import { imageryParent, type ImageryCover } from './surface/ImageryRefinement.js';

export interface ImageryPage extends ImageryCover { source: number; slot: number }
const WIDTH = 1024;

/** GPU-only image storage plus a small CPU-authored sparse quadtree page table.
 * Pages are copied without resampling. Array layers isolate filtering/mipmaps;
 * source alpha and original gutters survive unchanged. The page table is
 * published only after all uploads for the new cover have completed.
 */
export class CubeImageryPages {
  readonly array: THREE.DataArrayTexture;
  readonly tableUniform = { value: new THREE.DataTexture(new Int32Array(WIDTH * 4), WIDTH, 1, THREE.RGBAIntegerFormat, THREE.IntType) };
  readonly roots = new Map<string, number>();
  private readonly slots = new Map<string, number>();
  private signature: string | null = null;
  private readonly bindings = new Map<string, { root: number; image: Int32Array }>();
  private generation = -1;
  private copyFramebuffer: WebGLFramebuffer | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private properties: THREE.WebGLRenderer['properties'] | null = null;
  private readonly contextLost = () => {
    // Release Three's old-context disposal callbacks while GL is lost (GPU
    // objects are already invalid). Otherwise publishing the next table invokes
    // a stale callback that tries to delete an old-context texture after restore.
    this.array.dispose(); this.tableUniform.value.dispose();
    this.slots.clear(); this.roots.clear(); this.bindings.clear();
    this.signature = null; this.copyFramebuffer = null; this.properties = null;
  };
  private readonly contextRestoring = () => {
    // Capture runs before Three's restore listener rebuilds its default 3D
    // textures. Pixel-store flags from 2D uploads are illegal for texImage3D.
    const gl = this.renderer?.getContext();
    gl?.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl?.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  };
  uploadMs = 0;
  lastError: string | null = null;
  readonly inheritedGlErrors: number[] = [];

  constructor(readonly span: number, readonly capacity: number) {
    this.array = new THREE.DataArrayTexture(null, span, span, capacity);
    this.array.source.dataReady = false;
    this.array.minFilter = THREE.LinearMipmapLinearFilter;
    this.array.magFilter = THREE.LinearFilter;
    // Preserve the old per-image sampler's grazing-view quality. Three clamps
    // this request to the device limit; configure it before allocating pages,
    // since changing the texture descriptor later would replace their storage.
    this.array.anisotropy = 8;
    // Allocate the mip chain once; copies populate each page's own mip chain.
    this.array.generateMipmaps = true;
    this.array.needsUpdate = true;
    this.tableUniform.value.needsUpdate = true;
  }

  has(id: string): boolean { return this.slots.has(id); }
  /** A proven all-zero alpha tile overrides its ancestor, without a GPU page. */
  transparent(id: string): void { this.slots.set(id, -2); }
  slot(id: string): number { return this.slots.get(id) ?? -1; }
  forget(id: string): void { this.slots.delete(id); }

  initialize(renderer: THREE.WebGLRenderer): boolean {
    try {
      this.contextGeneration(renderer);
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (gl.isContextLost()) { this.lastError = 'context lost'; return false; }
      // A shared renderer can arrive with an error from earlier work (including
      // Three's default 3D placeholder initialization). Do not attribute it to
      // this allocation or shrink a healthy pool. Preserve bounded diagnostics.
      for (let i = 0; i < 8; i++) {
        const prior = gl.getError(); if (prior === gl.NO_ERROR) break;
        if (this.inheritedGlErrors.length < 8) this.inheritedGlErrors.push(prior);
      }
      renderer.initTexture(this.array);
      this.generation = (renderer.properties.get(this.array) as { __version?: number }).__version ?? -1;
      const error = gl.getError();
      this.lastError = error === gl.NO_ERROR ? null : `array initialization GL error ${error}`;
      return error === gl.NO_ERROR;
    } catch (error) { this.lastError = String(error); return false; }
  }

  upload(id: string, texture: THREE.Texture, renderer: THREE.WebGLRenderer | null): boolean {
    if (renderer) this.contextGeneration(renderer);
    if (this.slots.has(id)) return true;
    if ([...this.slots.values()].filter(slot => slot >= 0).length >= this.capacity) return false;
    const occupied = new Set(this.slots.values());
    let slot = 0; while (occupied.has(slot)) slot++;
    if (renderer) {
      const started = performance.now();
      if (!this.initialize(renderer)) return false;
      try {
        this.array.generateMipmaps = false;
        renderer.initTexture(texture);
        const gl = renderer.getContext() as WebGL2RenderingContext;
        // Own the copy framebuffer: Three's copyTextureToTexture scratch
        // framebuffers are not recreated by its context-restoration path.
        this.copyFramebuffer ??= gl.createFramebuffer();
        if (!this.copyFramebuffer) throw Error('Image copy framebuffer allocation failed');
        const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, this.copyFramebuffer);
        renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, (renderer.properties.get(this.array) as { __webglTexture: WebGLTexture }).__webglTexture);
        try {
          for (let mip = 0; mip <= Math.floor(Math.log2(this.span)); mip++) {
            gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
              (renderer.properties.get(texture) as { __webglTexture: WebGLTexture }).__webglTexture, mip);
            if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Incomplete image copy framebuffer');
            const size = Math.max(1, Math.floor(this.span / 2 ** mip));
            gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, mip, 0, 0, slot, 0, 0, size, size);
          }
        } finally {
          gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
          renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, previous);
          renderer.state.unbindTexture();
        }
        const error = gl.getError();
        if (error !== gl.NO_ERROR || gl.isContextLost()) { this.lastError = `page copy GL error ${error}`; return false; }
      } catch (error) { this.lastError = String(error); return false; }
      finally {
        texture.dispose(); this.array.generateMipmaps = true;
        this.uploadMs += performance.now() - started;
      }
      // Preserve the decoded image for context restoration and diagnostic reads,
      // while releasing the staging 2D texture's GPU allocation.
    }
    this.slots.set(id, slot);
    return true;
  }

  /** Context loss invalidates the GPU pages, even though CPU bitmaps survive. */
  contextGeneration(renderer: THREE.WebGLRenderer): boolean {
    const version = (renderer.properties.get(this.array) as { __version?: number }).__version;
    // Three replaces the properties store on restoration. The array may already
    // have been reinitialized by a material before our next update, so its
    // numeric version alone cannot identify a new GPU context.
    const changed = this.renderer !== renderer || this.properties !== renderer.properties || (this.generation >= 0 && version === undefined);
    if (changed) {
      this.slots.clear(); this.roots.clear(); this.bindings.clear(); this.signature = null; this.array.generateMipmaps = true;
      this.copyFramebuffer = null;
    }
    if (this.renderer !== renderer) {
      this.renderer?.domElement?.removeEventListener('webglcontextlost', this.contextLost);
      this.renderer?.domElement?.removeEventListener('webglcontextrestored', this.contextRestoring, true);
      renderer.domElement?.addEventListener('webglcontextlost', this.contextLost);
      renderer.domElement?.addEventListener('webglcontextrestored', this.contextRestoring, true);
    }
    this.renderer = renderer; this.properties = renderer.properties;
    this.generation = version ?? -1;
    return changed;
  }

  publish(pages: ImageryPage[]): void {
    const signature = pages.map(p => `${p.source}:${cubeTileId(p.patch)}=${p.slot}/${cubeTileId(p.image)}`).join(';');
    if (signature === this.signature) return;
    this.signature = signature;
    this.bindings.clear();
    const nodes = new Map<string, { children: number[]; image: number[]; index: number }>();
    const ensure = (source: number, a: ImageryAddress): number => {
      const key = `${source}:${cubeTileId(a)}`, existing = nodes.get(key);
      if (existing) return existing.index;
      const index = nodes.size;
      nodes.set(key, { index, children: [-1, -1, -1, -1], image: [-1, 0, 0, 0] });
      if (a.level) {
        const parent = imageryParent(a); ensure(source, parent);
        nodes.get(`${source}:${cubeTileId(parent)}`)!.children[(a.x & 1) + 2 * (a.y & 1)] = index;
      } else this.roots.set(`${source}:${a.face}`, index);
      return index;
    };
    this.roots.clear();
    for (const p of pages) {
      ensure(p.source, p.patch);
      nodes.get(`${p.source}:${cubeTileId(p.patch)}`)!.image = [p.slot, p.image.level, p.image.x, p.image.y];
    }
    const height = Math.max(1, Math.ceil(nodes.size * 2 / WIDTH));
    const data = new Int32Array(WIDTH * height * 4).fill(-1);
    for (const node of nodes.values()) {
      data.set(node.children, node.index * 8);
      data.set(node.image, node.index * 8 + 4);
    }
    const previous = this.tableUniform.value;
    this.tableUniform.value = new THREE.DataTexture(data, WIDTH, height, THREE.RGBAIntegerFormat, THREE.IntType);
    this.tableUniform.value.needsUpdate = true;
    previous.dispose();
  }

  root(source: number, face: CubeFace): number { return this.roots.get(`${source}:${face}`) ?? -1; }
  /** Resolve the uniform prefix once on the CPU. Most terrain tiles are finer
   * than imagery, so fragments need a direct page binding, not a root walk. Only
   * imagery finer than the terrain requires per-fragment subtree traversal. */
  binding(source: number, address: ImageryAddress): { root: number; image: Int32Array } {
    const key = `${source}:${cubeTileId(address)}`, cached = this.bindings.get(key); if (cached) return cached;
    const data = this.tableUniform.value.image.data as Int32Array;
    let node = this.root(source, address.face);
    const image = new Int32Array([-1, 0, 0, 0]);
    for (let depth = 0; node >= 0; depth++) {
      const offset = node * 8;
      if (data[offset + 4] !== -1) image.set(data.subarray(offset + 4, offset + 8));
      if (depth === address.level) {
        if (data.subarray(offset, offset + 4).every(child => child < 0)) node = -1;
        break;
      }
      const shift = address.level - depth - 1, quadrant = ((address.x >> shift) & 1) + 2 * ((address.y >> shift) & 1);
      node = data[offset + quadrant];
    }
    const result = { root: node, image }; this.bindings.set(key, result); return result;
  }
  dispose(): void {
    this.renderer?.domElement?.removeEventListener('webglcontextlost', this.contextLost);
    this.renderer?.domElement?.removeEventListener('webglcontextrestored', this.contextRestoring, true);
    if (this.copyFramebuffer) this.renderer?.getContext().deleteFramebuffer(this.copyFramebuffer);
    this.array.dispose(); this.tableUniform.value.dispose();
  }
}
