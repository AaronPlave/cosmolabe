declare module 'timecraftjs' {
  export const ASM_SPICE_FULL: number;
  export const ASM_SPICE_LITE: number;
  export class Spice {
    module: {
      ccall(ident: string, returnType: string | null, argTypes: string[], args: unknown[]): unknown;
      getValue(ptr: number, type: string): number;
      setValue(ptr: number, value: number, type: string): void;
      _malloc(size: number): number;
      _free(ptr: number): void;
      UTF8ToString(ptr: number, maxLength?: number): string;
      stringToUTF8(str: string, ptr: number, maxLength: number): void;
      FS: {
        writeFile(path: string, data: Uint8Array, opts?: { encoding: string }): void;
        unlink(path: string): void;
      };
    };
    ready: boolean;
    init(type?: number): Promise<Spice>;
    loadKernel(buffer: ArrayBuffer | Uint8Array, key?: string | null): void;
    unloadKernel(key: string): void;
  }
}
