// Type declaration for the Emscripten-generated CSPICE glue (wasm/cspice.mjs).
// The glue itself is a build artifact (eslint-disabled, ts-nocheck). We expose
// only the runtime surface cspice-wasm uses.

declare module 'cspice-wasm/wasm/cspice.mjs' {
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
    // SPICE entry points are exported as _<name>_c. Indexed access is typed loosely
    // because the marshaling layer (bindings.ts) owns the per-function contract.
    [exported: `_${string}`]: (...args: number[]) => number;
  }

  const factory: (overrides?: Record<string, unknown>) => Promise<CSpiceModule>;
  export default factory;
}
