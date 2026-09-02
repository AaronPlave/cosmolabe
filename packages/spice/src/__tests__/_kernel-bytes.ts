/**
 * Byte-exact kernel bytes for `furnish`. Mirrors `kernelArrayBuffer` in
 * @cosmolabe/core's test harness; duplicated rather than shared because
 * @cosmolabe/spice sits below core in the dependency graph.
 *
 * Not a `*.test.ts` name, so vitest will not run it as a suite.
 */

/** A Buffer's own bytes as a standalone ArrayBuffer.
 *
 *  Not `buf.buffer`: `readFileSync` allocates results of 4096 bytes or less out
 *  of Node's shared 8 KB Buffer pool, so for a small kernel `.buffer` is the
 *  whole pool with the file at some `byteOffset` inside it, surrounded by bytes
 *  from unrelated reads. `test_instruments.ti` is 878 bytes and was being
 *  furnished exactly that way; it passed only because SPICE ignores text
 *  outside `\begindata`.
 */
export function kernelArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
