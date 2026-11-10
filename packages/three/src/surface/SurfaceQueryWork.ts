/** Cooperative CPU work for analytical queries; cancellation never becomes coverage. */
export interface SurfaceQueryWork {
  signal?: { readonly aborted: boolean };
  checkpoint(): Promise<void>;
}
export function surfaceQueryWork(signal?: SurfaceQueryWork['signal']): SurfaceQueryWork {
  let deadline = performance.now() + 8;
  return { signal, async checkpoint() {
    if (signal?.aborted) throw new DOMException('Surface query cancelled', 'AbortError');
    if (performance.now() >= deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      deadline = performance.now() + 8;
      if (signal?.aborted) throw new DOMException('Surface query cancelled', 'AbortError');
    }
  } };
}
