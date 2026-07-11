// Heap-lifecycle test for the bindings arena: every C string and scratch block a
// SPICE call allocates must be freed when the call returns or throws, so the
// Emscripten heap does not grow monotonically (the leak the per-call scope() fixes).
// This drives SpiceBindings against a mock CSpiceModule with malloc/free counters
// instead of the real WASM build, so it isolates pointer lifetime from numerics.

import { describe, it, expect } from 'vitest';
import type { CSpiceModule, CValueType } from 'cspice-wasm/wasm/cspice.mjs';
import { SpiceBindings } from './bindings.ts';

interface MockModule extends CSpiceModule {
  readonly stats: { mallocs: number; frees: number; live: Set<number> };
}

/**
 * A mock CSPICE module: a flat byte heap with a bump allocator and a free set, so
 * we can count allocations and assert none leak. SPICE entry points are stubbed to
 * write plausible outputs (and never fail), which is all the arena test needs.
 */
function makeMockModule(): MockModule {
  const HEAP = new ArrayBuffer(1 << 20);
  const dv = new DataView(HEAP);
  const bytes = new Uint8Array(HEAP);
  let bump = 8; // never hand out 0 (the C null pointer)
  const live = new Set<number>();
  const stats = { mallocs: 0, frees: 0, live };

  const readCString = (ptr: number): string => {
    let end = ptr;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(ptr, end));
  };

  const stubs: Record<string, (...args: number[]) => number> = {
    // erract_c / errprt_c / reset_c: no-ops the constructor and checkFailed call.
    _erract_c: () => 0,
    _errprt_c: () => 0,
    _reset_c: () => 0,
    _failed_c: () => 0, // never failed in the happy path
    // str2et_c(utc, outPtr): write a fixed ET so the call has an observable result.
    _str2et_c: (_utc: number, out: number) => {
      dv.setFloat64(out, 123456.789, true);
      return 0;
    },
    // et2utc_c(et, format, prec, len, outPtr): write a calendar string.
    _et2utc_c: (_et: number, _fmt: number, _prec: number, _len: number, out: number) => {
      const s = new TextEncoder().encode('2004-07-01T00:00:00.000');
      bytes.set(s, out);
      bytes[out + s.length] = 0;
      return 0;
    },
    // timout_c(et, pic, len, outPtr): the et2tdb path.
    _timout_c: (_et: number, _pic: number, _len: number, out: number) => {
      const s = new TextEncoder().encode('2004-07-01T00:01:04.184');
      bytes.set(s, out);
      bytes[out + s.length] = 0;
      return 0;
    },
    // spkpos_c(target, et, frame, abcorr, observer, posPtr, ltPtr).
    _spkpos_c: (..._args: number[]) => {
      const pos = _args[5]!;
      const lt = _args[6]!;
      dv.setFloat64(pos, 1, true);
      dv.setFloat64(pos + 8, 2, true);
      dv.setFloat64(pos + 16, 3, true);
      dv.setFloat64(lt, 4, true);
      return 0;
    },
  };

  return {
    _malloc(size: number): number {
      const ptr = bump;
      bump += Math.max(8, size + (8 - (size % 8 || 8)));
      live.add(ptr);
      stats.mallocs++;
      return ptr;
    },
    _free(ptr: number): void {
      // Double-free or freeing an untracked pointer would be a real bug; surface it.
      if (!live.has(ptr)) throw new Error(`free of untracked pointer ${ptr}`);
      live.delete(ptr);
      stats.frees++;
    },
    getValue(ptr: number, type: CValueType) {
      return type === 'double' ? dv.getFloat64(ptr, true) : dv.getInt32(ptr, true);
    },
    setValue(ptr: number, value: number, type: CValueType) {
      if (type === 'double') dv.setFloat64(ptr, value, true);
      else dv.setInt32(ptr, value, true);
    },
    stringToUTF8(str: string, outPtr: number, _maxBytes: number) {
      const enc = new TextEncoder().encode(str);
      bytes.set(enc, outPtr);
      bytes[outPtr + enc.length] = 0;
    },
    UTF8ToString(ptr: number) {
      return readCString(ptr);
    },
    lengthBytesUTF8(str: string) {
      return new TextEncoder().encode(str).length;
    },
    FS: {
      writeFile: () => undefined,
      readFile: () => new Uint8Array(),
      unlink: () => undefined,
      mkdir: () => undefined,
      analyzePath: () => ({ exists: true }),
    },
    stats,
    // The indexed CSPICE entry-point accessor.
    ...stubs,
  } as unknown as MockModule;
}

describe('cspice-wasm bindings arena (heap lifecycle)', () => {
  it('frees every allocation the constructor makes (no live pointers carried)', () => {
    const mod = makeMockModule();
    new SpiceBindings(mod);
    expect(mod.stats.live.size).toBe(0);
    expect(mod.stats.frees).toBe(mod.stats.mallocs);
  });

  it('str2et balances malloc and free (the str() C string is reclaimed)', () => {
    const mod = makeMockModule();
    const b = new SpiceBindings(mod);
    const before = { ...mod.stats };
    const et = b.str2et('2004-07-01T00:00:00');
    expect(et).toBeCloseTo(123456.789, 3);
    // The call allocated (a C string plus a scratch double) and freed all of them.
    expect(mod.stats.mallocs).toBeGreaterThan(before.mallocs);
    expect(mod.stats.live.size).toBe(0);
    expect(mod.stats.frees).toBe(mod.stats.mallocs);
  });

  it('et2utc does not leak its output buffer on the early return path', () => {
    const mod = makeMockModule();
    const b = new SpiceBindings(mod);
    const out = b.et2utc(123456.789, 'ISOC', 3);
    expect(out.startsWith('2004-07-01')).toBe(true);
    expect(mod.stats.live.size).toBe(0);
    expect(mod.stats.frees).toBe(mod.stats.mallocs);
  });

  it('et2tdb does not leak its output buffer on the early return path', () => {
    const mod = makeMockModule();
    const b = new SpiceBindings(mod);
    const out = b.et2tdb(123456.789, 3);
    expect(out.startsWith('2004-07-01')).toBe(true);
    expect(mod.stats.live.size).toBe(0);
    expect(mod.stats.frees).toBe(mod.stats.mallocs);
  });

  it('repeated spkpos calls do not grow the live-pointer set (no monotonic leak)', () => {
    const mod = makeMockModule();
    const b = new SpiceBindings(mod);
    for (let i = 0; i < 50; i++) {
      b.spkpos('6', 123456.789, 'J2000', 'NONE', '10');
      expect(mod.stats.live.size).toBe(0);
    }
    expect(mod.stats.frees).toBe(mod.stats.mallocs);
  });
});
