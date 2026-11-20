import type { SpiceInstance, Vec3 } from '../spice-injection.js';
import type { CoverageInterval, StateAvailability } from '../availability.js';
import type { CartesianState, Trajectory } from './Trajectory.js';

export class SpiceTrajectory implements Trajectory {
  private errorLogged = false;
  private _coverageQueried = false;
  private _startTime: number | undefined;
  private _endTime: number | undefined;
  private _coverage: CoverageInterval[] = [];

  /** True if SPICE calls have failed for this trajectory */
  get failed(): boolean { return this.errorLogged; }

  /** SPICE target name or NAIF ID string (e.g. 'CASSINI', '-82') */
  get spiceTarget(): string { return this.target; }
  /** SPICE center body name (e.g. 'SATURN', 'SUN') */
  get spiceCenter(): string { return this.center; }
  /** SPICE reference frame (e.g. 'ECLIPJ2000', 'J2000') */
  get spiceFrame(): string { return this.spiceFrameName; }
  /** The frame states are returned in: the SPICE frame they are queried in. */
  get frame(): string { return this.spiceFrameName; }

  get startTime(): number | undefined {
    this.queryCoverage();
    return this._startTime;
  }

  get endTime(): number | undefined {
    this.queryCoverage();
    return this._endTime;
  }

  constructor(
    private readonly spice: SpiceInstance,
    private readonly target: string,
    private readonly center: string,
    private readonly spiceFrameName: string,
  ) {}

  private queryCoverage(): void {
    if (this._coverageQueried) return;
    this._coverageQueried = true;
    try {
      // Resolve target to NAIF ID — target may already be numeric string
      let idcode = Number(this.target);
      if (!Number.isInteger(idcode)) {
        const resolved = this.spice.bodn2c(this.target);
        if (resolved == null) return;
        idcode = resolved;
      }
      const windows = this.spice.spkcov(idcode);
      if (windows.length === 0) return;
      this._coverage = [...windows].sort((a, b) => a.start - b.start);
      // Union all coverage windows to get the overall bounds
      let min = Infinity;
      let max = -Infinity;
      for (const w of windows) {
        if (w.start < min) min = w.start;
        if (w.end > max) max = w.end;
      }
      this._startTime = min;
      this._endTime = max;
    } catch {
      // Coverage query failed — leave times undefined
    }
  }

  /**
   * SPK coverage (`spkcov`) is the authoritative answer to where this target
   * has data, holes between segments included. Inside it, `spkezr` must still
   * answer: the target's own segments say nothing of the chain to its center.
   */
  availabilityAt(et: number): StateAvailability {
    this.queryCoverage();
    const coverage = this._coverage;
    const answers = () => !isNaN(this.stateAt(et).position[0]);
    if (coverage.length === 0) return { available: answers() };
    if (coverage.some(c => et >= c.start && et <= c.end)) {
      return answers()
        ? { available: true, coverage }
        : { available: false, coverage, reason: 'error', message: `SPICE has no state for ${this.target} relative to ${this.center} at this epoch.` };
    }
    return { available: false, coverage, reason: et < coverage[0].start ? 'before-coverage' : et > coverage[coverage.length - 1].end ? 'after-coverage' : 'gap' };
  }

  stateAt(et: number): CartesianState {
    try {
      const result = this.spice.spkezr(this.target, et, this.spiceFrameName, 'NONE', this.center);
      return {
        position: [result.state[0], result.state[1], result.state[2]] as Vec3,
        velocity: [result.state[3], result.state[4], result.state[5]] as Vec3,
      };
    } catch (e) {
      if (!this.errorLogged) {
        console.warn(`SPICE trajectory failed for ${this.target}: ${e instanceof Error ? e.message : e}`);
        this.errorLogged = true;
      }
      return { position: [NaN, NaN, NaN], velocity: [NaN, NaN, NaN] };
    }
  }
}
