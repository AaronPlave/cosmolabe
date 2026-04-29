/**
 * Patch the global Worker constructor to force `type: "module"` for
 * Cesium worker URLs.
 *
 * Cesium 1.139+ ships ESM-format workers with `import` statements, but
 * its TaskProcessor only creates module workers (`type: "module"`) for
 * cross-origin URLs. Same-origin workers are loaded as classic workers,
 * which silently fail on `import` syntax — terrain mesh is never created,
 * tiles never render.
 *
 * Fix: monkey-patch `window.Worker` to detect Cesium worker URLs and
 * force `type: "module"`.
 *
 * Call this once before creating a Cesium Viewer.
 *
 */
export function patchCesiumWorkers(): void {
  if (typeof window === 'undefined') return;

  const OriginalWorker = window.Worker;

  window.Worker = class PatchedWorker extends OriginalWorker {
    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      const url = scriptURL.toString();
      // Detect Cesium worker URLs and force module type
      if (url.includes('Workers/') && !options?.type) {
        super(scriptURL, { ...options, type: 'module' });
      } else {
        super(scriptURL, options);
      }
    }
  } as typeof Worker;
}
