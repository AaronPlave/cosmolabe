/**
 * The heap reservation baked into the committed `wasm/cspice.wasm`, and the
 * reader that tells you what it actually is.
 *
 * This exists because the number is a budget, not an implementation detail. A
 * SPICE-backed viewer scene runs more than one CSPICE instance -- one on the
 * main thread, one in the trajectory-cache worker, and a third, briefly, for
 * event searches -- and each instance reserves this much address space before a
 * single kernel, texture or render target is allocated. Multiply it by the
 * instance count and it is the largest fixed cost a mission scene pays, which
 * is how iOS Safari came to terminate the page on mission examples that used to
 * load (issue #88): at 160 MiB the two always-on instances reserved ~320 MiB
 * between them.
 *
 * `-sALLOW_MEMORY_GROWTH=1` is what makes a smaller reservation safe: the heap
 * still grows to whatever Cassini's kernel set needs, and the declared 2 GiB
 * maximum means engines reserve the address space up front and grow in place,
 * so growth is a bookkeeping change rather than a copy of the whole heap.
 *
 * What cannot be lowered is the floor beneath it. CSPICE is f2c-translated
 * Fortran, so its COMMON blocks are static data: the DAF/DAS buffer pools, the
 * kernel pool and the GF workspaces are all sized at compile time and sit in
 * linear memory below `__heap_base`. `readWasmMemoryLimits` reads that floor
 * out of the module (`staticEndBytes`), and the accompanying test asserts the
 * budget clears it -- a reservation below the floor produces a module that
 * cannot instantiate at all.
 */

/** One WebAssembly page. */
export const WASM_PAGE_BYTES = 65_536;

/**
 * The reservation the committed artifact is built with: 112 MiB.
 *
 * Chosen as the static floor (~100.5 MiB, see above) plus roughly 11 MiB of
 * working heap -- enough that a lightweight scene such as `earth-moon` never
 * grows, while a mission kernel set grows into what it needs. Changing this
 * means rebuilding (`scripts/build-cspice.sh`, which passes it as
 * `INITIAL_MEMORY`) or re-pinning the committed artifact
 * (`scripts/set-initial-memory.mjs`); `wasm-memory.test.ts` holds the two in
 * step.
 */
export const CSPICE_INITIAL_MEMORY_BYTES = 117_440_512;

/** What a wasm module's memory declaration and static layout commit it to. */
export interface WasmMemoryLimits {
  /** Bytes of linear memory reserved at instantiation. */
  readonly initialBytes: number;
  /** The declared ceiling, or null when the module names none. */
  readonly maximumBytes: number | null;
  /**
   * The top of static data -- the initial value of `__stack_pointer`, which
   * Emscripten places above the data segments and the stack. Nothing below it
   * is heap, so a module whose `initialBytes` is under it cannot run.
   */
  readonly staticEndBytes: number;
}

/** Read an unsigned LEB128 at `at`. Returns the value and its byte length. */
function readUleb(bytes: Uint8Array, at: number): { value: number; length: number } {
  let value = 0;
  let shift = 0;
  let length = 0;
  for (;;) {
    const byte = bytes[at + length];
    if (byte === undefined) throw new Error('wasm: truncated LEB128');
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    length += 1;
    if ((byte & 0x80) === 0) return { value, length };
  }
}

/** Encode `value` as unsigned LEB128. */
export function encodeUleb(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) throw new Error(`wasm: cannot encode ${value} as uleb128`);
  const out: number[] = [];
  let rest = value;
  do {
    const byte = rest % 0x80;
    rest = Math.floor(rest / 0x80);
    out.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return new Uint8Array(out);
}

/** The byte range of each top-level section, keyed by section id. */
function sections(bytes: Uint8Array): Map<number, { start: number; end: number }> {
  if (bytes.length < 8) throw new Error('wasm: too short to be a module');
  const found = new Map<number, { start: number; end: number }>();
  let at = 8; // magic + version
  while (at < bytes.length) {
    const id = bytes[at];
    at += 1;
    const { value: size, length } = readUleb(bytes, at);
    at += length;
    // Custom sections (id 0) repeat and carry no layout information; the
    // sections read here are the once-only ones, so first wins is exact.
    if (id !== 0 && !found.has(id)) found.set(id, { start: at, end: at + size });
    at += size;
  }
  return found;
}

/** Where the memory section's `initial` field sits, for a reader or a patcher. */
export function memoryLimitsField(bytes: Uint8Array): { at: number; length: number; pages: number } {
  const memory = sections(bytes).get(5);
  if (!memory) throw new Error('wasm: no memory section (is the memory imported rather than defined?)');
  let at = memory.start;
  const count = readUleb(bytes, at);
  if (count.value !== 1) throw new Error(`wasm: expected exactly one memory, found ${count.value}`);
  at += count.length;
  at += 1; // limits flags
  const initial = readUleb(bytes, at);
  return { at, length: initial.length, pages: initial.value };
}

/** Read the heap reservation and static floor out of a wasm module's bytes. */
export function readWasmMemoryLimits(bytes: Uint8Array): WasmMemoryLimits {
  const found = sections(bytes);
  const memory = found.get(5)!;
  const initial = memoryLimitsField(bytes);
  const flags = bytes[memory.start + readUleb(bytes, memory.start).length];
  let maximumBytes: number | null = null;
  if ((flags & 0x1) !== 0) {
    maximumBytes = readUleb(bytes, initial.at + initial.length).value * WASM_PAGE_BYTES;
  }

  return {
    initialBytes: initial.pages * WASM_PAGE_BYTES,
    maximumBytes,
    staticEndBytes: readStackPointer(bytes, found.get(6)),
  };
}

/**
 * The initial value of `__stack_pointer`.
 *
 * Emscripten emits it as the module's first mutable i32 global, initialized to
 * the top of the stack -- which sits directly above the data segments, so the
 * value is the end of everything that is not heap.
 */
function readStackPointer(bytes: Uint8Array, globals: { start: number; end: number } | undefined): number {
  if (!globals) throw new Error('wasm: no global section, so no __stack_pointer to read');
  let at = globals.start;
  const count = readUleb(bytes, at);
  if (count.value < 1) throw new Error('wasm: global section declares no globals');
  at += count.length;
  if (bytes[at] !== 0x7f) throw new Error('wasm: first global is not an i32');
  at += 2; // valtype + mutability
  if (bytes[at] !== 0x41) throw new Error('wasm: first global is not initialized by i32.const');
  at += 1;
  // The stack pointer is well under 2^31, so its signed LEB128 encoding and the
  // unsigned reading of the same bytes agree.
  return readUleb(bytes, at).value;
}
