export type EventHandler<T> = (data: T) => void;

/**
 * Typed event bus for cross-component communication.
 * Core events are typed via TMap; plugins can use onCustom/emitCustom for untyped events.
 */
export class EventBus<TMap extends {}> {
  private handlers = new Map<string, Set<EventHandler<any>>>();

  /** Subscribe to a typed event. Returns unsubscribe function. */
  on<K extends keyof TMap & string>(event: K, handler: EventHandler<TMap[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Subscribe once — auto-unsubscribes after first call. */
  once<K extends keyof TMap & string>(event: K, handler: EventHandler<TMap[K]>): () => void {
    const unsub = this.on(event, (data) => { unsub(); handler(data); });
    return unsub;
  }

  /** Emit a typed event. Errors in handlers are caught and logged. */
  emit<K extends keyof TMap & string>(event: K, data: TMap[K]): void {
    const set = this.handlers.get(event);
    if (set) {
      for (const h of set) {
        try { h(data); } catch (e) { console.error(`EventBus handler error for '${event}':`, e); }
      }
    }
  }

  /** Subscribe to a custom (untyped) event for plugin-to-plugin communication. */
  onCustom(event: string, handler: EventHandler<unknown>): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Emit a custom (untyped) event. */
  emitCustom(event: string, data: unknown): void {
    const set = this.handlers.get(event);
    if (set) {
      for (const h of set) {
        try { h(data); } catch (e) { console.error(`EventBus handler error for '${event}':`, e); }
      }
    }
  }

  dispose(): void {
    this.handlers.clear();
  }
}
