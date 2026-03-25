export type StateListener<T> = (value: T, prev: T) => void;

/**
 * Shared reactive state for cross-plugin coordination.
 * get/set/watch pattern with change deduplication.
 */
export class StateStore<S extends {}> {
  private state: S;
  private listeners = new Map<string, Set<StateListener<any>>>();

  constructor(initial: S) {
    this.state = { ...initial };
  }

  get<K extends keyof S>(key: K): S[K] {
    return this.state[key];
  }

  /** Set a value. No-op if value is the same (Object.is). */
  set<K extends keyof S>(key: K, value: S[K]): void {
    const prev = this.state[key];
    if (Object.is(prev, value)) return;
    this.state[key] = value;
    const set = this.listeners.get(key as string);
    if (set) {
      for (const fn of set) {
        try { fn(value, prev); } catch (e) { console.error(`StateStore listener error for '${String(key)}':`, e); }
      }
    }
  }

  /** Watch a key for changes. Returns unsubscribe function. */
  watch<K extends keyof S>(key: K, listener: StateListener<S[K]>): () => void {
    const k = key as string;
    let set = this.listeners.get(k);
    if (!set) { set = new Set(); this.listeners.set(k, set); }
    set.add(listener);
    return () => set!.delete(listener);
  }

  /** Snapshot of all state (for debugging/serialization). */
  snapshot(): Readonly<S> {
    return { ...this.state };
  }

  dispose(): void {
    this.listeners.clear();
  }
}
