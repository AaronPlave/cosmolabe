/**
 * Whether this device can afford the viewer's second always-on CSPICE instance.
 *
 * A SPICE-backed scene normally runs two: one on the main thread that the
 * renderer and every readout query, and one in the trajectory-cache worker that
 * bakes spacecraft trails off-thread. Each reserves the wasm heap budget
 * documented in `cspice-wasm/src/wasm-memory.ts`, on top of the kernels it
 * furnishes — and a mission kernel set is the larger half of that. On a phone
 * the pair is enough for WebKit to terminate the page mid-load, which is what
 * issue #88 reports: the tab appears to finish loading and then reloads itself.
 *
 * So on a constrained device the viewer builds one instance and bakes its
 * trails synchronously on the main thread (`UniverseRenderer.buildCacheSync`,
 * already the path used when no worker is supplied). That trades a slower,
 * jankier load for a load that survives, which on a device with no headroom is
 * not much of a trade. Desktop is untouched.
 *
 * The detection is deliberately a policy in one place, testable without a
 * browser, because the signals are poor: `navigator.deviceMemory` is
 * Chromium-only, and the platform that actually kills the page — iOS Safari —
 * reports nothing at all. What it does report is a coarse pointer, so a
 * touch-primary device with no memory figure is read as constrained. That is a
 * heuristic: it also catches Android tablets and touchscreen laptops running
 * WebKit-like engines, which pay a slower load for a risk they may not have
 * had. `?spiceWorkers=1` forces the two-instance path back on for anyone who
 * would rather have the faster load, and `?spiceWorkers=0` forces the
 * single-instance path on a desktop, which is how this gets exercised without
 * a phone in hand.
 */

/** The browser facts the policy reads. Injected so a test can state them. */
export interface DeviceBudgetSignals {
  /** `navigator.deviceMemory` — approximate RAM in GiB, Chromium only. */
  readonly deviceMemory?: number;
  /** `matchMedia('(pointer: coarse)').matches` — a touch-primary device. */
  readonly coarsePointer?: boolean;
  /** `location.search`, for the `spiceWorkers` override. */
  readonly search?: string;
}

/**
 * At or below this many GiB of reported RAM, the second instance is skipped.
 *
 * 4 GiB rather than something lower because `deviceMemory` is rounded down to a
 * power of two and capped at 8: a 6 GiB phone reports 4, and a phone is the
 * device this is about.
 */
export const CONSTRAINED_DEVICE_MEMORY_GIB = 4;

/** Read the override, if the URL carries one. `undefined` when it does not. */
function workerOverride(search: string | undefined): boolean | undefined {
  if (!search) return undefined;
  const raw = new URLSearchParams(search).get('spiceWorkers');
  if (raw === null) return undefined;
  return raw !== '0' && raw !== 'false';
}

/** Whether a scene should run the trajectory-cache worker's CSPICE instance. */
export function shouldRunSpiceWorkers(signals: DeviceBudgetSignals): boolean {
  const override = workerOverride(signals.search);
  if (override !== undefined) return override;
  if (typeof signals.deviceMemory === 'number') {
    return signals.deviceMemory > CONSTRAINED_DEVICE_MEMORY_GIB;
  }
  // No figure to go on. A coarse pointer is the only remaining signal, and it
  // is the one iOS Safari — the engine that terminates the page — does give.
  return !signals.coarsePointer;
}

/** The same question, asked of the real browser. */
export function shouldRunSpiceWorkersHere(): boolean {
  if (typeof navigator === 'undefined') return true;
  return shouldRunSpiceWorkers({
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    coarsePointer:
      typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : undefined,
    search: typeof location !== 'undefined' ? location.search : undefined,
  });
}
