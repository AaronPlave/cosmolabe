import { cubeTileId } from './CubeSphere.js';
import { parseImageryAddress, type ImageryAddress } from './CubeImagery.js';

export const imageryParent = (a: ImageryAddress): ImageryAddress => ({ ...a, level: a.level - 1, x: a.x >> 1, y: a.y >> 1 });
export const imageryChildren = (a: ImageryAddress): ImageryAddress[] => Array.from({ length: 4 }, (_, i) => ({ face: a.face, level: a.level + 1, x: a.x * 2 + (i & 1), y: a.y * 2 + (i >> 1) }));

export interface ImageryCover { patch: ImageryAddress; image: ImageryAddress }
export interface ImageryRefinementFrame {
  cover: ImageryCover[];
  /** Each group must be admitted together; otherwise a full cache can strand half a replacement. */
  loading: ImageryAddress[][];
  committed: number;
  waiting: number;
}

/** A persistent image-only replacement tree. It owns no terrain or GPU objects.
 * A split commits at a frame boundary only when every required sibling has a
 * usable image, and all pending groups on the visible refinement frontier
 * commit together. A fast neighbor cannot run multiple levels ahead. Missing files are not fabricated: a child may reuse its actual
 * ancestor. Parents absent from a sparse inventory are virtual traversal nodes.
 */
export class ImageryRefinement {
  private readonly available: Set<string>;
  readonly branches = new Set<string>();
  private readonly lastSplitWanted = new Map<string, number>();
  readonly topology: Set<string>;

  constructor(ids: Iterable<string>, readonly coarsenDelayFrames = 30) {
    this.available = new Set(ids);
    this.topology = new Set(this.available);
    for (const id of this.available) {
      let a = parseImageryAddress(id);
      while (a.level > 0) { a = imageryParent(a); this.topology.add(cubeTileId(a)); }
    }
  }

  ancestor(a: ImageryAddress): ImageryAddress | null {
    for (;;) {
      if (this.available.has(cubeTileId(a))) return a;
      if (!a.level) return null;
      a = imageryParent(a);
    }
  }

  /** Explicit user level changes are intentional, unlike motion thresholds. */
  resetHysteresis(): void { this.lastSplitWanted.clear(); }

  update(targets: readonly ImageryAddress[], ready: (a: ImageryAddress) => boolean, frame: number,
    needed: (a: ImageryAddress) => boolean = () => true,
    failed: (a: ImageryAddress) => boolean = () => false,
    retainSplit: (a: ImageryAddress) => boolean = () => false): ImageryRefinementFrame {
    const desired = new Set<string>(), roots = new Map<string, ImageryAddress>();
    for (let a of targets) {
      while (a.level > 0) { a = imageryParent(a); desired.add(cubeTileId(a)); }
      roots.set(cubeTileId(a), a);
    }
    const splits = new Map<string, boolean>();
    const wantsSplit = (a: ImageryAddress): boolean => {
      const id = cubeTileId(a), cached = splits.get(id); if (cached !== undefined) return cached;
      if (desired.has(id) || (this.branches.has(id) && retainSplit(a))) this.lastSplitWanted.set(id, frame);
      const value = desired.has(id) || (this.branches.has(id) && frame - (this.lastSplitWanted.get(id) ?? -Infinity) < this.coarsenDelayFrames);
      splits.set(id, value); return value;
    };
    const replacementsFor = (a: ImageryAddress): ImageryAddress[] => [...new Map(imageryChildren(a)
      .filter(c => this.topology.has(cubeTileId(c)) && needed(c))
      .map(c => this.ancestor(c)).filter((c): c is ImageryAddress => c !== null && !failed(c))
      .map(c => [cubeTileId(c), c])).values()];
    // Plan before mutating branches. The shallowest incomplete visible groups
    // form one admission/residency transaction, across all six faces. Complete
    // groups at that frontier wait too; ready groups below it can commit now.
    // Virtual inventory nodes introduce no new pixels and may be traversed.
    const pending: Array<{ address: ImageryAddress; replacements: ImageryAddress[]; missing: boolean }> = [];
    const scan = (a: ImageryAddress): void => {
      if (!needed(a) || !wantsSplit(a)) return;
      if (!this.branches.has(cubeTileId(a))) {
        const replacements = replacementsFor(a);
        if (replacements.some(c => c.level > a.level)) {
          const missing = replacements.some(c => !ready(c));
          pending.push({ address: a, replacements, missing });
          if (missing) return;
        }
      }
      for (const c of imageryChildren(a)) if (this.topology.has(cubeTileId(c))) scan(c);
    };
    for (const root of roots.values()) scan(root);
    const frontier = Math.min(Infinity, ...pending.filter(p => p.missing).map(p => p.address.level));
    const wave = [...new Map(pending.filter(p => p.address.level === frontier)
      .flatMap(p => p.replacements).map(a => [cubeTileId(a), a])).values()];
    const result: ImageryRefinementFrame = { cover: [], loading: wave.length ? [wave] : [], committed: 0, waiting: 0 };
    const visit = (a: ImageryAddress, inherited: ImageryAddress | null): void => {
      if (!needed(a)) return;
      const id = cubeTileId(a), image = this.ancestor(a);
      const usable = image && ready(image) ? image : inherited;
      const split = wantsSplit(a);
      const children = imageryChildren(a).filter(c => this.topology.has(cubeTileId(c)));
      if (split && children.length) {
        const replacements = replacementsFor(a);
        if (!this.branches.has(id) && a.level >= frontier && replacements.some(c => c.level > a.level)) {
          result.waiting++;
        } else {
          if (!this.branches.has(id)) { this.branches.add(id); result.committed++; }
          // Every quadrant still has an explicit fallback, including quadrants
          // absent from a regional inventory. They must not borrow other texels.
          for (const child of imageryChildren(a)) {
            if (this.topology.has(cubeTileId(child))) visit(child, usable);
            else if (usable) result.cover.push({ patch: child, image: usable });
          }
          return;
        }
      } else if (this.branches.has(id) && usable && (!image || ready(image) || failed(image))) {
        // Coarsen only to an already usable parent. Descendants can then be
        // retired without touching any sampler referenced by this frame.
        this.branches.delete(id);
      } else if (this.branches.has(id)) {
        // A missing/evicted parent must never blank an existing child cover.
        for (const child of imageryChildren(a)) visit(child, usable);
        if (image) result.loading.push([image]);
        return;
      }
      if (usable) result.cover.push({ patch: a, image: usable });
      else if (image) result.loading.push([image]);
    };
    for (const root of roots.values()) visit(root, null);
    return result;
  }
}
