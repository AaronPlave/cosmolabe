// The committed artifact's heap reservation is a budget two always-on CSPICE
// instances multiply, so it is pinned here rather than left to whatever the
// last `emcc` invocation happened to pass. Issue #88: at 160 MiB a mission
// scene reserved ~320 MiB before kernels, and iOS Safari terminated the page.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  CSPICE_INITIAL_MEMORY_BYTES,
  WASM_PAGE_BYTES,
  encodeUleb,
  memoryLimitsField,
  readWasmMemoryLimits,
} from './wasm-memory.js';

const MIB = 1024 * 1024;

const wasm = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../wasm/cspice.wasm', import.meta.url))),
);

describe('cspice.wasm memory budget', () => {
  const limits = readWasmMemoryLimits(wasm);

  it('reserves exactly the documented budget', () => {
    // Fails two ways on purpose: a rebuild that changes INITIAL_MEMORY without
    // updating the constant, and a constant edit that never reached the
    // artifact (run scripts/set-initial-memory.mjs).
    expect(limits.initialBytes).toBe(CSPICE_INITIAL_MEMORY_BYTES);
  });

  it('keeps the two always-on instances of a mission scene under 256 MiB', () => {
    // A SPICE-backed scene builds one instance on the main thread and one in
    // the trajectory-cache worker. Their fixed reservation is what a
    // memory-constrained device pays before a single kernel is fetched.
    expect(2 * limits.initialBytes).toBeLessThan(256 * MIB);
  });

  it('clears the static floor with working heap to spare', () => {
    // Below `staticEndBytes` there is no heap at all -- the module would fail
    // to instantiate. The margin is what a lightweight scene allocates into
    // before the first memory.grow.
    expect(limits.initialBytes).toBeGreaterThan(limits.staticEndBytes);
    expect(limits.initialBytes - limits.staticEndBytes).toBeGreaterThan(8 * MIB);
  });

  it('can still grow past the reservation', () => {
    // The budget is only safe because the heap is not capped at it: Cassini's
    // kernel set needs far more than this, and grows into it.
    expect(limits.maximumBytes).not.toBeNull();
    expect(limits.maximumBytes!).toBeGreaterThan(limits.initialBytes);
  });

  it('agrees with the INITIAL_MEMORY the build script passes', () => {
    const script = readFileSync(
      fileURLToPath(new URL('../scripts/build-cspice.sh', import.meta.url)),
      'utf8',
    );
    const passed = script.match(/-s INITIAL_MEMORY=(\d+)/);
    expect(passed?.[1]).toBe(String(CSPICE_INITIAL_MEMORY_BYTES));
  });
});

describe('wasm memory reader', () => {
  it('round-trips the page count through its LEB128 encoding', () => {
    const field = memoryLimitsField(wasm);
    expect(field.pages).toBe(CSPICE_INITIAL_MEMORY_BYTES / WASM_PAGE_BYTES);
    expect([...encodeUleb(field.pages)]).toEqual([...wasm.subarray(field.at, field.at + field.length)]);
  });

  it('encodes multi-byte values the way the format requires', () => {
    expect([...encodeUleb(0)]).toEqual([0]);
    expect([...encodeUleb(127)]).toEqual([127]);
    expect([...encodeUleb(128)]).toEqual([0x80, 0x01]);
    expect([...encodeUleb(2560)]).toEqual([0x80, 0x14]);
  });

  it('rejects bytes that are not a wasm module', () => {
    expect(() => readWasmMemoryLimits(new Uint8Array([0, 1, 2]))).toThrow(/too short/);
  });
});
