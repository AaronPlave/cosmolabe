#!/usr/bin/env node
/**
 * Re-pin the committed cspice.wasm's heap reservation to the budget in
 * `src/wasm-memory.ts`, without a full Emscripten rebuild.
 *
 * `INITIAL_MEMORY` reaches the artifact as exactly one number: the `initial`
 * field of the module's memory section. Nothing else in the module or in the
 * JS glue reads it -- the glue takes `wasmExports.memory` as it finds it and
 * derives every heap view from `.buffer` -- so rewriting that one LEB128 is
 * the whole of the change `emcc -sINITIAL_MEMORY=...` would have made.
 *
 * That matters because the toolchain is pinned (build-cspice.sh, EMSDK_VERSION)
 * and a rebuild on a different emcc rewrites the glue wholesale. This keeps a
 * budget change to the bytes it actually touches. `scripts/build-cspice.sh`
 * stays the source of truth: it passes the same number, so a real rebuild
 * produces a module this script would leave alone.
 *
 * Usage: node packages/cspice-wasm/scripts/set-initial-memory.mjs [bytes]
 * Idempotent -- re-running on an already-pinned artifact writes nothing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const wasmPath = fileURLToPath(new URL('../wasm/cspice.wasm', import.meta.url));

// The module is TypeScript, so the constant is read from its source rather than
// imported: this script runs from a bare checkout, before any build step.
const source = readFileSync(fileURLToPath(new URL('../src/wasm-memory.ts', import.meta.url)), 'utf8');
const declared = source.match(/CSPICE_INITIAL_MEMORY_BYTES\s*=\s*([\d_]+)/);
if (!declared) throw new Error('could not find CSPICE_INITIAL_MEMORY_BYTES in src/wasm-memory.ts');

const PAGE = 65_536;
const target = Number((process.argv[2] ?? declared[1]).replaceAll('_', ''));
if (!Number.isInteger(target) || target <= 0 || target % PAGE !== 0) {
  throw new Error(`initial memory must be a positive multiple of ${PAGE}; got ${target}`);
}

const bytes = readFileSync(wasmPath);

function readUleb(at) {
  let value = 0, shift = 0, length = 0;
  for (;;) {
    const byte = bytes[at + length];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    length += 1;
    if ((byte & 0x80) === 0) return { value, length };
  }
}

function encodeUleb(value) {
  const out = [];
  let rest = value;
  do {
    const byte = rest % 0x80;
    rest = Math.floor(rest / 0x80);
    out.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return Buffer.from(out);
}

// Walk to the memory section (id 5), remembering where its size field starts:
// re-encoding `initial` can change the section's length, so both move together.
let at = 8;
let memory = null;
while (at < bytes.length) {
  const id = bytes[at];
  at += 1;
  const sizeField = at;
  const { value: size, length } = readUleb(at);
  at += length;
  if (id === 5) { memory = { sizeField, sizeLength: length, start: at, size }; break; }
  at += size;
}
if (!memory) throw new Error('no memory section: the module imports its memory instead');

let cursor = memory.start;
const count = readUleb(cursor);
if (count.value !== 1) throw new Error(`expected exactly one memory, found ${count.value}`);
cursor += count.length;
const flagsAt = cursor;
cursor += 1;
const initial = readUleb(cursor);

const targetPages = target / PAGE;
if (initial.value === targetPages) {
  console.log(`cspice.wasm already reserves ${target} bytes (${targetPages} pages); nothing to do.`);
  process.exit(0);
}

const encoded = encodeUleb(targetPages);
const rebuiltSection = Buffer.concat([
  bytes.subarray(memory.start, cursor),
  encoded,
  bytes.subarray(cursor + initial.length, memory.start + memory.size),
]);
const patched = Buffer.concat([
  bytes.subarray(0, memory.sizeField),
  encodeUleb(rebuiltSection.length),
  rebuiltSection,
  bytes.subarray(memory.start + memory.size),
]);

writeFileSync(wasmPath, patched);
console.log(
  `cspice.wasm initial memory: ${initial.value * PAGE} -> ${target} bytes ` +
  `(${initial.value} -> ${targetPages} pages, limits flags 0x${bytes[flagsAt].toString(16)}).`,
);
