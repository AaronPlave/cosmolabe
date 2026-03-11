export type TimeListener = (et: number) => void;

export class TimeController {
  private _et: number;
  private _rate = 1;
  private _playing = false;
  private _listeners = new Set<TimeListener>();
  private _lastWallMs = 0;
  private _animFrameId = 0;

  constructor(initialEt = 0) {
    this._et = initialEt;
  }

  get et(): number { return this._et; }
  get rate(): number { return this._rate; }
  get playing(): boolean { return this._playing; }

  setTime(et: number): void {
    this._et = et;
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

  /** Step forward by dt seconds (useful for frame-by-frame) */
  step(dt: number): void {
    this._et += dt;
    this.notify();
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
    this._et += wallDt * this._rate;
    this.notify();
    this._animFrameId = requestAnimationFrame(this.tick);
  };

  private notify(): void {
    for (const fn of this._listeners) fn(this._et);
  }
}
