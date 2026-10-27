import { blockBoundingSphere, imageryTileRect, imageryLevelFor, texelGroundSizeKm,
  type BlockSelectionInput, type ImageryAddress, type ImageryBlock } from './CubeImagery.js';

/** Client-only view selection. Kept separate from the locked source registration
 * kernels: camera culling cannot change an immutable scientific data build. */
export interface ImagerySelectionInput extends BlockSelectionInput {
  radiusRangeFor?: (address: ImageryAddress) => readonly [number, number];
}

export function selectImageryBlocks(input: ImagerySelectionInput): ImageryBlock[] {
  const { geometry, availability } = input;
  const queue: ImageryAddress[] = [geometry];
  const leaves: ImageryBlock[] = [];
  let count = 1;
  while (queue.length) {
    const block = queue.shift()!;
    const radiusRangeKm = input.radiusRangeFor?.(block) ?? input.radiusRangeKm;
    const sphere = blockBoundingSphere(block, radiusRangeKm);
    const c = input.cameraKm;
    const distance = Math.max(Math.hypot(c[0] - sphere.centre[0], c[1] - sphere.centre[1], c[2] - sphere.centre[2]) - sphere.radius, 1e-6);
    const { u0, v0, size } = imageryTileRect(block);
    // Nearest point of the square to the face centre carries its largest texel.
    const uc = Math.min(Math.max(0, u0), u0 + size), vc = Math.min(Math.max(0, v0), v0 + size);
    const desiredLevel = Math.min(availability.maxLevel, imageryLevelFor(texelGroundSizeKm(0, uc, vc, radiusRangeKm[1], input.tileSize), distance, input.pixelAngleRad, input.maxScreenTexelError));
    const inView = input.inView ? input.inView(sphere.centre, sphere.radius, block) : true;
    if (inView && (desiredLevel > block.level || block.level < availability.minLevel) && count + 3 <= input.maxBlocks && availability.hasAnyChild(block)) {
      for (let i = 0; i < 4; i++) queue.push({ face: block.face, level: block.level + 1, x: 2 * block.x + (i & 1), y: 2 * block.y + (i >> 1) });
      count += 3;
      continue;
    }
    const wantLevel = Math.min(Math.max(desiredLevel, availability.minLevel), block.level);
    const shift = block.level - wantLevel;
    const image = availability.deepestAncestor({ face: block.face, level: wantLevel, x: block.x >> shift, y: block.y >> shift });
    if (image) leaves.push({ ...block, image, desiredLevel, inView });
  }
  return leaves;
}
