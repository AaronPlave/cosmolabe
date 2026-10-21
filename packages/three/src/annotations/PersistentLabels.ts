import type { ScreenRect } from '../EventCallout.js';

export const labelOverlaps = (a: ScreenRect, b: ScreenRect): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
export interface LabelCandidate {
  id: string;
  box: ScreenRect;
  priority: number;
  /** Normalized apparent-size eligibility: enter at 1, exit below .75. */
  eligibility: number;
  selected?: boolean;
}
export interface PersistentLabel extends LabelCandidate {
  accepted: boolean;
  opacity: number;
  targetOpacity: number;
}

/** Renderer-independent identity, arbitration, hysteresis and transition state.
 * Projection belongs to the caller and is refreshed even during fades. Omitted
 * IDs are physically invalid and removed immediately; eligible=false decisions
 * are expressed with eligibility=0 and fade. External obstacles always win. */
export class PersistentLabels {
  readonly states = new Map<string, PersistentLabel>();
  enters = 0;
  exits = 0;
  private lastAt: number | undefined;
  constructor(readonly limit = 32, readonly fadeMs = 250) {}

  update(candidates: readonly LabelCandidate[], obstacles: readonly ScreenRect[], now: number): PersistentLabel[] {
    const dt = this.lastAt === undefined ? 0 : Math.max(0, Math.min(100, now - this.lastAt));
    this.lastAt = now;
    const ids = new Set(candidates.map(c => c.id));
    for (const [id, old] of this.states) if (!ids.has(id)) {
      if (old.accepted) this.exits++;
      this.states.delete(id);
    }
    const sorted = [...candidates].sort((a,b) => Number(!!b.selected) - Number(!!a.selected)
      || (b.priority + (this.states.get(b.id)?.accepted ? 8 : 0)) - (a.priority + (this.states.get(a.id)?.accepted ? 8 : 0)) || a.id.localeCompare(b.id));
    const occupied = obstacles.map(box => ({ box, hard: true }));
    let accepted = 0;
    for (const candidate of sorted) {
      const old = this.states.get(candidate.id);
      const state = old ?? { ...candidate, accepted: false, opacity: 0, targetOpacity: 0 };
      Object.assign(state, candidate);
      const collisions = occupied.filter(r => labelOverlaps(r.box, candidate.box));
      const collision = collisions.length > 0;
      const wanted = accepted < this.limit && !collision && (candidate.selected || candidate.eligibility >= (state.accepted ? .75 : 1));
      if (wanted !== state.accepted) { if (wanted) this.enters++; else this.exits++; }
      state.accepted = !!wanted;
      state.targetOpacity = wanted ? candidate.selected ? 1 : Math.min(1, Math.max(.15, (candidate.eligibility - .75) / .5)) : 0;
      // A higher-priority annotation must not be covered by a departing label.
      if (collisions.some(r => r.hard)) state.opacity = 0;
      const step = dt / this.fadeMs;
      state.opacity += Math.sign(state.targetOpacity - state.opacity) * Math.min(Math.abs(state.targetOpacity - state.opacity), step);
      if (wanted) { accepted++; occupied.push({ box: candidate.box, hard: !!candidate.selected }); }
      else if (state.opacity > 0) occupied.push({ box: candidate.box, hard: !!candidate.selected });
      if (wanted || state.opacity > 0) this.states.set(candidate.id, state);
      else this.states.delete(candidate.id);
    }
    // Limit departing states as well as live placements.
    return [...this.states.values()].filter(s => s.opacity > 0)
      .sort((a,b) => Number(!!b.selected) - Number(!!a.selected) || Number(b.accepted) - Number(a.accepted) || b.priority - a.priority || a.id.localeCompare(b.id))
      .slice(0, this.limit);
  }
  clear(): void { this.states.clear(); this.lastAt = undefined; }
}

/** Expensive work is scheduled, not turned into a visibility decision. The
 * caller retains the last completed result when this frame has no time left. */
export class AnnotationBudget {
  private readonly deadline: number;
  private checks = 0;
  constructor(ms: number, private readonly now: () => number = () => performance.now()) { this.deadline = now() + ms; }
  run<T>(work: () => T): { value: T } | undefined {
    // Always make progress even when a single physical query exceeds the budget.
    if (this.checks > 0 && this.now() >= this.deadline) return undefined;
    this.checks++;
    return { value: work() };
  }
}
