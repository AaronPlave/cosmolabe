/**
 * Test-harness kernel loading. Generalizes the proven `readKernel` helper from
 * lro-validation.test.ts: read a kernel from disk, transparently gunzipping a
 * `.gz` sibling when the plain file is absent (viewer mission kernels ship
 * gzipped to keep the checkout small).
 *
 * NOTE: this file lives under `__tests__/_harness/` (not a `*.test.ts` file) so
 * vitest's `include` glob won't try to run it as a suite, and the package tsc
 * build (which excludes `src/__tests__`) won't compile it.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { SpiceInstance } from '@cosmolabe/spice';

/** Bundled, always-present generic + Cassini kernels (`packages/spice/test-kernels`). */
export const SPICE_TEST_KERNELS = join(__dirname, '../../../../spice/test-kernels');
/** Larger mission kernels shipped with the viewer (LRO, de440s, MSL, ...). */
export const VIEWER_KERNELS = join(__dirname, '../../../../../apps/viewer/test-catalogs/kernels');

/** Read a kernel file as a Buffer, transparently gunzipping `<path>.gz` when
 *  the plain file is missing. `relPath` is resolved against `root`. */
export function readKernelBuffer(relPath: string, root: string = SPICE_TEST_KERNELS): Buffer {
  const full = join(root, relPath);
  try {
    return readFileSync(full);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return gunzipSync(readFileSync(`${full}.gz`));
  }
}

/** A Buffer's own bytes as a standalone ArrayBuffer.
 *
 *  Not `buf.buffer`. `readFileSync` allocates results of 4096 bytes or less out
 *  of Node's shared 8 KB Buffer pool, so for a small kernel `.buffer` is the
 *  whole pool: the file sits at some `byteOffset` inside it, surrounded by
 *  bytes from unrelated reads. Furnishing that hands SPICE a slab that merely
 *  contains the kernel. Text kernels survive it because SPICE ignores anything
 *  outside `\begindata`, which is why it went unnoticed — but it is luck, and
 *  a binary kernel would not be so forgiving.
 *
 *  `tsc` reports the difference as ArrayBufferLike vs ArrayBuffer. This
 *  function previously cast it away (`buf.buffer as ArrayBuffer`), which is
 *  what let the bug in; it surfaced when tests were finally typechecked. */
export function kernelArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Furnish a list of `root`-relative kernel paths into a Spice instance, in
 *  order. Filenames are de-gzipped in the SPICE filesystem (`.gz` stripped). */
export async function furnishKernels(
  spice: SpiceInstance,
  relPaths: string[],
  root: string = SPICE_TEST_KERNELS,
): Promise<void> {
  for (const rel of relPaths) {
    const buf = readKernelBuffer(rel, root);
    const filename = rel.split('/').pop()!.replace(/\.gz$/, '');
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(buf), filename });
  }
}
