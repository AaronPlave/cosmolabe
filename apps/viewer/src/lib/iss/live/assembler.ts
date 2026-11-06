/**
 * Coherent sample assembly for a live telemetry feed (#371).
 *
 * A feed delivers one item at a time (one quaternion component, one joint
 * angle), each with its own source timestamp. A sample is only meaningful when
 * every component belongs to the same moment, so this accumulates items and
 * emits a sample only when all of them agree within a tolerance, newer than
 * anything emitted before, and fresh against the local clock. It never
 * invents a missing component, never reuses an old one under a new
 * timestamp, and counts what it rejects.
 */

export interface ItemUpdate {
  /** The feed's item name. */
  item: string;
  value: number;
  /** The source's own timestamp, ms since the Unix epoch UTC. NaN when it could not be parsed. */
  sourceTimeMs: number;
}

export type RejectReason =
  | 'unknown-item'
  | 'non-finite-value'
  | 'bad-timestamp'
  /** Source time is ahead of the local clock by more than the allowed skew. */
  | 'future'
  /** Source time older than `maxAgeMs`: a replayed snapshot, not a live value. */
  | 'stale'
  /** Older than the newest value already held for this item. */
  | 'out-of-order';

export interface AssembledSample {
  /** The common source time, ms since the Unix epoch UTC (the newest component's). */
  sourceTimeMs: number;
  values: Readonly<Record<string, number>>;
}

export type AssembleResult =
  | { kind: 'sample'; sample: AssembledSample }
  /** Held, waiting for the other components (or already emitted). */
  | { kind: 'pending' }
  | { kind: 'rejected'; reason: RejectReason };

export interface AssemblerOptions {
  /** Largest spread between components' source times that still counts as one moment. Default 0. */
  toleranceMs?: number;
  /** Oldest source time accepted, relative to the local clock. Default 10 000. */
  maxAgeMs?: number;
  /** Furthest ahead of the local clock a source time may be (clock skew allowance). Default 60 000. */
  maxFutureMs?: number;
  now?: () => number;
}

export class CoherentAssembler {
  private readonly latest = new Map<string, { value: number; t: number }>();
  private lastEmittedMs = -Infinity;
  readonly rejected: Record<RejectReason, number> = {
    'unknown-item': 0, 'non-finite-value': 0, 'bad-timestamp': 0, future: 0, stale: 0, 'out-of-order': 0,
  };
  emitted = 0;
  private readonly toleranceMs: number;
  private readonly maxAgeMs: number;
  private readonly maxFutureMs: number;
  private readonly now: () => number;

  constructor(readonly items: readonly string[], options: AssemblerOptions = {}) {
    if (items.length === 0 || new Set(items).size !== items.length) throw new Error('assembler items must be a non-empty set of distinct names');
    this.toleranceMs = options.toleranceMs ?? 0;
    this.maxAgeMs = options.maxAgeMs ?? 10_000;
    this.maxFutureMs = options.maxFutureMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  accept(update: ItemUpdate): AssembleResult {
    const reject = (reason: RejectReason): AssembleResult => { this.rejected[reason]++; return { kind: 'rejected', reason }; };
    if (!this.items.includes(update.item)) return reject('unknown-item');
    if (!Number.isFinite(update.value)) return reject('non-finite-value');
    if (!Number.isFinite(update.sourceTimeMs)) return reject('bad-timestamp');
    const now = this.now();
    if (update.sourceTimeMs - now > this.maxFutureMs) return reject('future');
    if (now - update.sourceTimeMs > this.maxAgeMs) return reject('stale');
    const held = this.latest.get(update.item);
    if (held && update.sourceTimeMs < held.t) return reject('out-of-order');
    this.latest.set(update.item, { value: update.value, t: update.sourceTimeMs });

    if (this.latest.size < this.items.length) return { kind: 'pending' };
    let min = Infinity, max = -Infinity;
    for (const { t } of this.latest.values()) { min = Math.min(min, t); max = Math.max(max, t); }
    if (max - min > this.toleranceMs) return { kind: 'pending' };
    // Nothing new since the last sample: a repeat of what was already emitted.
    if (max <= this.lastEmittedMs) return { kind: 'pending' };
    this.lastEmittedMs = max;
    this.emitted++;
    const values: Record<string, number> = {};
    for (const item of this.items) values[item] = this.latest.get(item)!.value;
    return { kind: 'sample', sample: { sourceTimeMs: max, values } };
  }

  /**
   * Forget partial components (after a disconnect, so a reconnect cannot
   * combine pre- and post-gap values) but keep the emission watermark, so
   * anything older than what was already shown is still refused.
   */
  reset(): void {
    this.latest.clear();
  }

  /** Newest source time emitted, or -Infinity. */
  get lastSourceTimeMs(): number {
    return this.lastEmittedMs;
  }
}
