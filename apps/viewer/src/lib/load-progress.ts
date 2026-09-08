/**
 * The loading bar's arithmetic, kept apart from the reactive state so it can be
 * tested — the property that matters ("one bar, one direction, one run") is not
 * something you want to verify by watching a 175 MB catalog load.
 *
 * A load has two phases with very different units: kernels are bytes over the
 * network, and assets are a count of models, textures and trajectory caches.
 * Spanning both with one bar means weighting them, and only the kernel side can
 * be measured up front — the catalog declares its kernel sizes, while the asset
 * count is unknown until the scene is built and then *grows* as nested assets
 * (a `.cmod`'s material textures) are discovered.
 *
 * So the kernel phase is weighted by its real byte total against a nominal
 * budget for everything after it: a kernel-heavy catalog gives most of the bar
 * to kernels (cassini-soi, ~175 MB declared, gives them 81%), a texture-heavy
 * one gives most of it to assets, and a catalog with no kernels gives the bar
 * entirely to assets. The split is an estimate; the label and detail lines under
 * the bar are what actually say where the load is.
 */

export type LoadPhase = 'kernels' | 'assets';

/** Nominal size of the model/texture/trajectory phase, used only to weigh it
 *  against the kernel phase. Never learned for real: assets are fetched without
 *  a HEAD pass, and a trajectory cache is computed rather than downloaded. */
export const ASSET_PHASE_BUDGET_BYTES = 40 * 1024 * 1024;

export class LoadProgress {
  private weight: Record<LoadPhase, number> = { kernels: 0, assets: 1 };
  private fraction: Record<LoadPhase, number> = { kernels: 0, assets: 0 };
  private percent = 0;

  /** Bar position, 0-100. */
  get value(): number {
    return this.percent;
  }

  /** Share of the bar a phase owns, 0-1. Exposed for tests and diagnostics. */
  weightOf(phase: LoadPhase): number {
    return this.weight[phase];
  }

  /**
   * Start a load: back to zero, with the phase weights fixed for its duration.
   * Fixed on purpose — weights that shifted mid-load (as the asset count grew)
   * would move the bar for reasons that have nothing to do with progress.
   */
  begin(opts: { kernelBytes?: number } = {}): void {
    const kernelBytes = Math.max(0, opts.kernelBytes ?? 0);
    const kernels = kernelBytes > 0
      ? kernelBytes / (kernelBytes + ASSET_PHASE_BUDGET_BYTES)
      : 0;
    this.weight = { kernels, assets: 1 - kernels };
    this.fraction = { kernels: 0, assets: 0 };
    this.percent = 0;
  }

  /** Report a phase's own 0-1 progress; returns the bar's new position. */
  set(phase: LoadPhase, fraction: number): number {
    this.fraction[phase] = clamp01(Number.isFinite(fraction) ? fraction : 0);
    const overall =
      (this.fraction.kernels * this.weight.kernels +
        this.fraction.assets * this.weight.assets) * 100;
    // Monotonic. The asset phase's denominator grows as nested assets are
    // discovered, so its raw fraction genuinely drops — and a bar that walks
    // backwards reads as a bug even when the work behind it is fine.
    this.percent = Math.max(this.percent, Math.min(100, overall));
    return this.percent;
  }

  /** Load finished (or gave up): the bar is full. */
  finish(): void {
    this.percent = 100;
  }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
