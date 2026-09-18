// Type declarations for the Emscripten-generated CSPICE glue (cspice.mjs),
// shipped as a sibling .d.mts so both source-mode consumers (bessel tests,
// the root rig) and dist-mode consumers (the cosmolabe tree through the
// symlinked package) resolve the same types through the exports map. The glue
// itself is a build artifact (eslint-disabled, ts-nocheck); this file exposes
// only the runtime surface cspice-wasm uses.

export interface CSpiceFS {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
  mkdir(path: string): void;
  analyzePath(path: string): { exists: boolean };
}

export type CValueType = 'i8' | 'i16' | 'i32' | 'i64' | 'float' | 'double' | '*';

export interface CSpiceModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  getValue(ptr: number, type: CValueType): number;
  setValue(ptr: number, value: number, type: CValueType): void;
  stringToUTF8(str: string, outPtr: number, maxBytes: number): void;
  UTF8ToString(ptr: number, maxBytes?: number): string;
  lengthBytesUTF8(str: string): number;
  FS: CSpiceFS;
  /**
   * Progress sink for the reporting GF entry points (native/gf-report.c). The
   * C reporter calls it from inside the running CSPICE search, with the
   * fraction of the current pass's confinement window searched so far and the
   * 1-based pass number.
   */
  onGfProgress?: (fraction: number, pass: number) => void;
  /**
   * Bail-out poll for the reporting GF entry points. Returning true aborts the
   * running CSPICE search; it is called from inside that search, so it must not
   * re-enter SPICE and must answer from state the worker already has.
   */
  onGfBail?: () => boolean;
  // SPICE entry points are exported as _<name>_c. Indexed access is typed loosely
  // because the marshaling layer (bindings.ts) owns the per-function contract.
  [exported: `_${string}`]: (...args: number[]) => number;
}

declare const factory: (overrides?: Record<string, unknown>) => Promise<CSpiceModule>;
export default factory;
