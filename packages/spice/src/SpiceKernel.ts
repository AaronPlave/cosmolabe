export type KernelSource =
  | { type: 'file'; path: string }
  | { type: 'url'; url: string }
  | { type: 'buffer'; data: ArrayBuffer; filename: string };

export interface SpiceKernelManager {
  furnish(source: KernelSource): Promise<void>;
  unload(filename: string): void;
  clear(): void;
  totalLoaded(): number;
}
