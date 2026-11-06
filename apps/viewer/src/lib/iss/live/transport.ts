/**
 * Transports for the live ISS feed (#371): a narrow seam between the network
 * client and the assembler, a deterministic replay transport for tests and
 * CI, and a Lightstreamer adapter that takes the client library as an
 * argument (no dependency is added to the app; the host imports it).
 *
 * The Lightstreamer adapter is written against the provider documentation and
 * the earlier prototype and has NOT been run against the real server from this
 * environment: its item and field names, and the time-stamp format, are
 * configuration the host must confirm (see docs/live-iss.md).
 */
import type { ItemUpdate } from './assembler.js';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface TransportHandlers {
  onItem(update: ItemUpdate): void;
  onConnection(state: ConnectionState, detail?: string): void;
}

export interface LiveTransport {
  /** Begin delivering; returns a stop function. Safe to call stop more than once. */
  start(handlers: TransportHandlers): () => void;
}

/** A transport driven by hand: tests push what a recorded session would have delivered. */
export class ReplayTransport implements LiveTransport {
  private handlers: TransportHandlers | null = null;
  starts = 0;
  stops = 0;

  start(handlers: TransportHandlers): () => void {
    this.starts++;
    this.handlers = handlers;
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.stops++;
      if (this.handlers === handlers) this.handlers = null;
    };
  }

  get active(): boolean {
    return this.handlers !== null;
  }

  connection(state: ConnectionState, detail?: string): void {
    this.handlers?.onConnection(state, detail);
  }

  item(update: ItemUpdate): void {
    this.handlers?.onItem(update);
  }

  items(updates: readonly ItemUpdate[]): void {
    for (const u of updates) this.item(u);
  }
}

// ── Lightstreamer ──

export interface LightstreamerConfig {
  server: string;
  adapterSet: string;
  /** Items to subscribe to. */
  items: readonly string[];
  /** Subscription fields, e.g. ['Value', 'TimeStamp']. */
  fields: readonly string[];
  /** Field carrying the numeric value. */
  valueField: string;
  /** Field carrying the source timestamp. */
  timeField: string;
  /**
   * Convert the raw time field to ms since the Unix epoch UTC, or NaN. Required
   * and deliberately has no default: the format is not confirmed.
   */
  parseSourceTime(raw: string): number;
  /** Requested maximum update frequency (items/s), or undefined for unfiltered. */
  maxFrequency?: number;
}

/** The slice of `lightstreamer-client-web` used here; pass the real module's exports. */
export interface LightstreamerLike {
  LightstreamerClient: new (server: string, adapterSet: string) => {
    addListener(l: { onStatusChange?: (status: string) => void }): void;
    connect(): void;
    disconnect(): void;
    subscribe(s: unknown): void;
    unsubscribe(s: unknown): void;
  };
  Subscription: new (mode: string, items: string[], fields: string[]) => {
    addListener(l: { onItemUpdate?: (u: { getItemName(): string; getValue(f: string): string | null }) => void }): void;
    setRequestedMaxFrequency(f: number | string): void;
  };
}

/** Lightstreamer client status strings to connection states. */
export function connectionFromStatus(status: string): ConnectionState {
  if (status.startsWith('CONNECTED')) return 'connected';
  if (status.startsWith('CONNECTING')) return 'connecting';
  // DISCONNECTED, DISCONNECTED:WILL-RETRY, STALLED: no data is flowing.
  return 'disconnected';
}

export function lightstreamerTransport(ls: LightstreamerLike, config: LightstreamerConfig): LiveTransport {
  return {
    start(handlers) {
      const client = new ls.LightstreamerClient(config.server, config.adapterSet);
      const subscription = new ls.Subscription('MERGE', [...config.items], [...config.fields]);
      if (config.maxFrequency !== undefined) subscription.setRequestedMaxFrequency(config.maxFrequency);
      subscription.addListener({
        onItemUpdate: (update) => {
          const raw = update.getValue(config.valueField);
          const rawTime = update.getValue(config.timeField);
          handlers.onItem({
            item: update.getItemName(),
            value: raw === null ? NaN : Number(raw),
            sourceTimeMs: rawTime === null ? NaN : config.parseSourceTime(rawTime),
          });
        },
      });
      client.addListener({ onStatusChange: (status) => handlers.onConnection(connectionFromStatus(status), status) });
      client.connect();
      client.subscribe(subscription);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        client.unsubscribe(subscription);
        client.disconnect();
      };
    },
  };
}
