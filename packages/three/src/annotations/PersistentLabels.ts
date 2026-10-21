import type { ScreenRect } from '../EventCallout.js';

export const labelOverlaps = (a: ScreenRect, b: ScreenRect): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
export interface LabelCandidate {
  id: string;
  box: ScreenRect;
  priority: number;
  /** Extra clearance for entry; accepted labels retain the smaller footprint. */
  entryBox?: ScreenRect;
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
 * Ordinary omission fades; callers explicitly invalidate proven unsafe anchors.
 * A contested slot belongs to its incumbent until a challenger exceeds the
 * priority margin. A replacement reserves the slot while its predecessor fades,
 * then enters: competing names never crossfade over one another. */
export class PersistentLabels {
  readonly states = new Map<string, PersistentLabel>();
  enters = 0;
  exits = 0;
  handoffs = 0;
  private lastAt: number | undefined;
  constructor(readonly limit = 32, readonly fadeMs = 250, readonly takeoverMargin = 20) {}

  update(candidates: readonly LabelCandidate[], obstacles: readonly ScreenRect[], now: number,
    invalidated: ReadonlySet<string> = new Set()): PersistentLabel[] {
    const dt = this.lastAt === undefined ? 0 : Math.max(0, Math.min(100, now - this.lastAt));
    this.lastAt = now;
    for (const id of invalidated) {
      if (this.states.get(id)?.accepted) this.exits++;
      this.states.delete(id);
    }
    const items = new Map(candidates.filter(c => !invalidated.has(c.id)).map(c => [c.id, c]));
    for (const [id, old] of this.states) if (!items.has(id)) items.set(id, { ...old, eligibility: 0, selected: false });
    const sorted = [...items.values()].sort((a,b) => Number(!!b.selected) - Number(!!a.selected)
      || (b.priority + (this.states.get(b.id)?.accepted ? this.takeoverMargin : 0))
       - (a.priority + (this.states.get(a.id)?.accepted ? this.takeoverMargin : 0)) || a.id.localeCompare(b.id));
    const occupied = obstacles.map(box => ({ box, hard: true }));
    const winners: PersistentLabel[] = [];
    for (const candidate of sorted) {
      const state = this.states.get(candidate.id) ?? { ...candidate, accepted: false, opacity: 0, targetOpacity: 0 };
      Object.assign(state, candidate);
      const entryBox = candidate.entryBox ?? {x0:candidate.box.x0-8, x1:candidate.box.x1+8, y0:candidate.box.y0-8, y1:candidate.box.y1+8};
      const footprint = state.accepted || candidate.selected ? candidate.box : entryBox;
      const collisions = occupied.filter(r => labelOverlaps(r.box, footprint));
      const wanted = winners.length < this.limit && !collisions.length
        && (candidate.selected || candidate.eligibility >= (state.accepted ? .75 : 1));
      if (wanted !== state.accepted) {
        if (wanted) this.enters++;
        else { this.exits++; if (collisions.length) this.handoffs++; }
      }
      state.accepted = !!wanted;
      state.targetOpacity = wanted ? 1 : 0;
      if (collisions.some(r => r.hard)) state.opacity = 0;
      if (wanted) { winners.push(state); occupied.push({ box: candidate.box, hard: !!candidate.selected }); }
      this.states.set(candidate.id, state);
    }
    const step = dt / this.fadeMs;
    // Departures own their pixels until completely transparent. Selected/safety
    // obstacles already evicted conflicting departures above.
    for (const state of this.states.values()) if (!state.accepted) state.opacity = Math.max(0, state.opacity - step);
    // If camera motion makes two previously separated visible footprints
    // intersect, keep the live owner (or strongest departure). There is no
    // non-overlapping fade path for an already intersecting pair.
    const visible = winners.filter(s => s.opacity > 0);
    const departing = [...this.states.values()].filter(s => !s.accepted && s.opacity > 0)
      .sort((a,b) => b.priority-a.priority || a.id.localeCompare(b.id));
    for (const state of departing) {
      if (visible.some(other => labelOverlaps(state.box, other.box))) state.opacity = 0;
      else visible.push(state);
    }
    for (const state of winners) {
      const blocked = [...this.states.values()].some(other => other !== state && other.opacity > 0
        && !other.accepted && labelOverlaps(state.box, other.box));
      if (!blocked) state.opacity = Math.min(1, state.opacity + step);
    }
    for (const [id, state] of this.states) if (!state.accepted && state.opacity === 0) this.states.delete(id);
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
