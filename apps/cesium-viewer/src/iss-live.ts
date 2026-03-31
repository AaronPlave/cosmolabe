/**
 * ISS Live Telemetry — connects to NASA's Lightstreamer feed
 * for real-time ISS attitude quaternion data.
 *
 * Server: https://push.lightstreamer.com
 * Adapter: ISSLIVE
 *
 * Attitude items (LVLH frame quaternion):
 *   USLAB000018 — q0 (scalar)
 *   USLAB000019 — q1
 *   USLAB000020 — q2
 *   USLAB000021 — q3
 */

import {
  LightstreamerClient,
  Subscription,
} from 'lightstreamer-client-web';

export interface ISSAttitude {
  /** LVLH quaternion [q0, q1, q2, q3] (scalar-first) */
  quaternion: [number, number, number, number];
  /** Timestamp of the update */
  timestamp: Date;
}

export type AttitudeCallback = (attitude: ISSAttitude) => void;

const LS_SERVER = 'https://push.lightstreamer.com';
const LS_ADAPTER = 'ISSLIVE';

// LVLH attitude quaternion components
const ATTITUDE_ITEMS = [
  'USLAB000018', // q0
  'USLAB000019', // q1
  'USLAB000020', // q2
  'USLAB000021', // q3
];

/**
 * Connect to NASA's ISS Live Lightstreamer feed and stream
 * real-time attitude data.
 */
export class ISSLiveClient {
  private _client: LightstreamerClient;
  private _subscription: Subscription;
  private _callback: AttitudeCallback;
  private _q: [number, number, number, number] = [1, 0, 0, 0];
  private _connected = false;

  constructor(callback: AttitudeCallback) {
    this._callback = callback;

    this._client = new LightstreamerClient(LS_SERVER, LS_ADAPTER);

    this._subscription = new Subscription(
      'MERGE',
      ATTITUDE_ITEMS,
      ['Value', 'TimeStamp'],
    );
    this._subscription.setRequestedMaxFrequency(1); // 1 update/sec max

    this._subscription.addListener({
      onItemUpdate: (update) => {
        const itemName = update.getItemName();
        const value = parseFloat(update.getValue('Value') ?? '');
        if (isNaN(value)) return;

        // Map item to quaternion component
        const idx = ATTITUDE_ITEMS.indexOf(itemName);
        if (idx >= 0 && idx < 4) {
          this._q[idx] = value;
          this._callback({
            quaternion: [...this._q] as [number, number, number, number],
            timestamp: new Date(),
          });
        }
      },
    });

    this._client.addListener({
      onStatusChange: (status: string) => {
        console.log(`[ISS Live] ${status}`);
        this._connected = status.startsWith('CONNECTED');
      },
    });
  }

  connect(): void {
    this._client.connect();
    this._client.subscribe(this._subscription);
    console.log('[ISS Live] Connecting to NASA Lightstreamer...');
  }

  disconnect(): void {
    this._client.unsubscribe(this._subscription);
    this._client.disconnect();
    this._connected = false;
  }

  get connected(): boolean {
    return this._connected;
  }
}
