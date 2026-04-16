/**
 * ISS Comm Status — subscribes to NASA Lightstreamer for real-time
 * communication link telemetry.
 *
 * Exposes AOS/LOS (signal acquired/lost), Ku-band transmit status,
 * and SGANT antenna gimbal angles. Uses the same Lightstreamer server
 * and adapter as ISSLiveClient (attitude data).
 *
 * Items:
 *   TIME_000001         — Master timestamp; Status.Class '24' = AOS
 *   Z1000013            — Ku-band transmit on/off
 *   Z1000014 / Z1000015 — SGANT elevation / cross-elevation (degrees)
 */

import {
  LightstreamerClient,
  Subscription,
} from 'lightstreamer-client-web';

export interface CommStatus {
  /** Signal acquired (AOS) — Lightstreamer feed is live from ISS. */
  signalAcquired: boolean;
  /** Ku-band transmitter active (TDRS link up). */
  kuTransmit: boolean;
  /** SGANT (Ku-band antenna) elevation angle in degrees. */
  sgantEl: number;
  /** SGANT cross-elevation angle in degrees. */
  sgantXel: number;
}

const LS_SERVER = 'https://push.lightstreamer.com';
const LS_ADAPTER = 'ISSLIVE';

const COMM_ITEMS = [
  'TIME_000001', // AOS/LOS via Status.Class
  'Z1000013',    // KU XMIT
  'Z1000014',    // SGANT EL
  'Z1000015',    // SGANT XEL
];

/**
 * Connect to NASA's ISS Live Lightstreamer feed and stream
 * real-time communication status.
 */
export class ISSCommClient {
  private _client: LightstreamerClient;
  private _sub: Subscription;
  private _status: CommStatus = {
    signalAcquired: false,
    kuTransmit: false,
    sgantEl: 0,
    sgantXel: 0,
  };
  private _connected = false;

  get status(): Readonly<CommStatus> { return this._status; }
  get connected(): boolean { return this._connected; }

  constructor() {
    this._client = new LightstreamerClient(LS_SERVER, LS_ADAPTER);

    this._sub = new Subscription('MERGE', COMM_ITEMS, ['Value', 'TimeStamp', 'Status.Class']);
    this._sub.setRequestedMaxFrequency(0.5); // 1 update per 2 sec

    this._sub.addListener({
      onItemUpdate: (update) => {
        const item = update.getItemName();
        if (item === 'TIME_000001') {
          const statusClass = update.getValue('Status.Class');
          this._status.signalAcquired = statusClass === '24';
        } else if (item === 'Z1000013') {
          const val = update.getValue('Value') ?? '';
          this._status.kuTransmit = val === '1' || val.toLowerCase() === 'on';
        } else if (item === 'Z1000014') {
          this._status.sgantEl = parseFloat(update.getValue('Value') ?? '0') || 0;
        } else if (item === 'Z1000015') {
          this._status.sgantXel = parseFloat(update.getValue('Value') ?? '0') || 0;
        }
      },
    });

    this._client.addListener({
      onStatusChange: (status: string) => {
        this._connected = status.startsWith('CONNECTED');
      },
    });
  }

  connect(): void {
    this._client.connect();
    this._client.subscribe(this._sub);
    console.log('[ISS Comm] Connecting to NASA Lightstreamer...');
  }

  disconnect(): void {
    this._client.unsubscribe(this._sub);
    this._client.disconnect();
    this._connected = false;
  }
}
