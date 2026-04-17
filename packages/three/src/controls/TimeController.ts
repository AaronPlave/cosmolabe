export type TimeListener = (et: number) => void;

/** Preset rate tiers for cycling through with faster()/slower() */
const RATE_TIERS = [
  -31556952,  // -1 yr/s
  -2592000,   // -1 mo/s
  -604800,    // -1 wk/s
  -86400,     // -1 day/s
  -3600,      // -1 hr/s
  -60,        // -1 min/s
  -30,        // -0.5 min/s
  -2,         // -2x
  -1,         // -1x (real-time reverse)
  0,          // paused (special: not selectable via faster/slower, only via pause)
  1,          // 1x (real-time)
  2,          // 2x (real-time)
  30,         // 0.5 min/s
  60,         // 1 min/s
  3600,       // 1 hr/s
  86400,      // 1 day/s
  604800,     // 1 wk/s
  2592000,    // 1 mo/s
  31556952,   // 1 yr/s
];

/** Human-readable label for a rate value */
export function rateLabel(rate: number): string {
  const abs = Math.abs(rate);
  const sign = rate < 0 ? '-' : '';
  if (abs === 0) return 'Paused';
  if (abs === 1) return `${sign}1x`;
  if (abs === 60) return `${sign}1 min/s`;
  if (abs === 3600) return `${sign}1 hr/s`;
  if (abs === 86400) return `${sign}1 day/s`;
  if (abs === 604800) return `${sign}1 wk/s`;
  if (abs === 2592000) return `${sign}1 mo/s`;
  if (abs === 31556952) return `${sign}1 yr/s`;
  if (abs >= 86400) return `${sign}${(abs / 86400).toFixed(0)} day/s`;
  if (abs >= 3600) return `${sign}${(abs / 3600).toFixed(0)} hr/s`;
  if (abs >= 60) return `${sign}${(abs / 60).toFixed(0)} min/s`;
  return `${sign}${abs}x`;
}

export class TimeController {
  private _et: number;
  private _rate = 1;
  private _playing = false;
  private _listeners = new Set<TimeListener>();
  private _lastWallMs = 0;
  private _animFrameId = 0;

  /** Optional time bounds — if set, ET is clamped to [minEt, maxEt] */
  private _minEt = -Infinity;
  private _maxEt = Infinity;

  constructor(initialEt = 0) {
    this._et = initialEt;
  }

  get et(): number { return this._et; }
  get rate(): number { return this._rate; }
  get playing(): boolean { return this._playing; }
  get minEt(): number { return this._minEt; }
  get maxEt(): number { return this._maxEt; }

  /** Set time bounds. Pass -Infinity/Infinity to remove a bound. */
  setBounds(minEt: number, maxEt: number): void {
    this._minEt = minEt;
    this._maxEt = maxEt;
    // Clamp current time if outside new bounds
    this._et = Math.max(minEt, Math.min(maxEt, this._et));
  }

  setTime(et: number): void {
    this._et = this.clamp(et);
    this.notify();
  }

  setRate(rate: number): void {
    this._rate = rate;
  }

  play(): void {
    if (this._playing) return;
    this._playing = true;
    this._lastWallMs = performance.now();
    this.tick();
  }

  pause(): void {
    this._playing = false;
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = 0;
    }
  }

  toggle(): void {
    this._playing ? this.pause() : this.play();
  }

  /** Reverse the current playback direction (negate rate) */
  reverse(): void {
    this._rate = -this._rate;
  }

  /** Step forward by dt seconds (useful for frame-by-frame) */
  step(dt: number): void {
    this._et = this.clamp(this._et + dt);
    this.notify();
  }

  /** Step forward by one interval (default: 60s, scales with |rate|) */
  stepForward(seconds?: number): void {
    this.step(seconds ?? this.defaultStepSize());
  }

  /** Step backward by one interval (default: 60s, scales with |rate|) */
  stepBackward(seconds?: number): void {
    this.step(-(seconds ?? this.defaultStepSize()));
  }

  /** Increase playback speed to the next tier. If paused, starts at 1x forward. */
  faster(): void {
    const idx = this.closestTierIndex(this._rate);
    // Skip the 0 (paused) tier
    let next = Math.min(idx + 1, RATE_TIERS.length - 1);
    if (RATE_TIERS[next] === 0) next = Math.min(next + 1, RATE_TIERS.length - 1);
    this._rate = RATE_TIERS[next];
  }

  /** Decrease playback speed to the previous tier. If paused, starts at -1x reverse. */
  slower(): void {
    const idx = this.closestTierIndex(this._rate);
    let prev = Math.max(idx - 1, 0);
    if (RATE_TIERS[prev] === 0) prev = Math.max(prev - 1, 0);
    this._rate = RATE_TIERS[prev];
  }

  /** Get the available rate tiers (for building UI controls) */
  static get rateTiers(): readonly number[] {
    return RATE_TIERS;
  }

  onTimeChange(listener: TimeListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  dispose(): void {
    this.pause();
    this._listeners.clear();
  }

  private tick = (): void => {
    if (!this._playing) return;
    const now = performance.now();
    const wallDt = (now - this._lastWallMs) / 1000;
    this._lastWallMs = now;
    const unclamped = this._et + wallDt * this._rate;
    const newEt = this.clamp(unclamped);
    // If clamping actually constrained the value, we've hit a bound — pause
    if (unclamped !== newEt) {
      this._et = newEt;
      this.notify();
      this.pause();
      return;
    }
    this._et = newEt;
    this.notify();
    this._animFrameId = requestAnimationFrame(this.tick);
  };

  private notify(): void {
    for (const fn of this._listeners) fn(this._et);
  }

  private clamp(et: number): number {
    return Math.max(this._minEt, Math.min(this._maxEt, et));
  }

  /** Default step size: one "screen second" worth of ET, minimum 1s */
  private defaultStepSize(): number {
    return Math.max(1, Math.abs(this._rate));
  }

  private closestTierIndex(rate: number): number {
    let best = 0;
    let bestDist = Math.abs(rate - RATE_TIERS[0]);
    for (let i = 1; i < RATE_TIERS.length; i++) {
      const dist = Math.abs(rate - RATE_TIERS[i]);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }
}
