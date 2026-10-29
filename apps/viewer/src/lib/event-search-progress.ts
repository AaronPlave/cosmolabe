import type { GeometryFinderProvider } from '@cosmolabe/core';

/** Bridges the worker's search-wide reporter to each provider call's callback. */
export function withCallProgress(
  provider: GeometryFinderProvider,
  setReporter: (report: ((fraction: number) => void) | undefined) => void,
): GeometryFinderProvider {
  const track = <T extends (...args: any[]) => any>(fn: T): T =>
    ((...args: any[]) => {
      // Diagnostics have no callback: clear the previous call's reporter while
      // preserving their confinement window and all other SPICE arguments.
      setReporter(typeof args.at(-1) === 'function' ? args.pop() : undefined);
      return fn.apply(provider, args);
    }) as T;
  return {
    ...provider,
    gfdist: track(provider.gfdist),
    gfsep: track(provider.gfsep),
    gfoclt: track(provider.gfoclt),
    gfposc: track(provider.gfposc),
  };
}
