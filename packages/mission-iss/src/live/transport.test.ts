import { describe, it, expect } from 'vitest';
import { connectionFromStatus, lightstreamerTransport, type LightstreamerLike } from './transport.js';

function fakeLs() {
  const log: string[] = [];
  let itemListener: ((u: { getItemName(): string; getValue(f: string): string | null }) => void) | undefined;
  let statusListener: ((s: string) => void) | undefined;
  const ls: LightstreamerLike = {
    LightstreamerClient: class {
      constructor(server: string, adapter: string) { log.push(`new ${server} ${adapter}`); }
      addListener(l: { onStatusChange?: (s: string) => void }) { statusListener = l.onStatusChange; }
      connect() { log.push('connect'); }
      disconnect() { log.push('disconnect'); }
      subscribe() { log.push('subscribe'); }
      unsubscribe() { log.push('unsubscribe'); }
    },
    Subscription: class {
      constructor(mode: string, items: string[], fields: string[]) { log.push(`sub ${mode} ${items.join(',')} ${fields.join(',')}`); }
      addListener(l: { onItemUpdate?: typeof itemListener }) { itemListener = l.onItemUpdate; }
      setRequestedMaxFrequency(f: number | string) { log.push(`freq ${f}`); }
    },
  };
  return { ls, log, emit: (item: string, fields: Record<string, string | null>) => itemListener!({ getItemName: () => item, getValue: (f) => fields[f] ?? null }), status: (s: string) => statusListener!(s) };
}

const config = { server: 'https://ls.example', adapterSet: 'SET', items: ['A', 'B'], fields: ['Value', 'T'], valueField: 'Value', timeField: 'T', parseSourceTime: (raw: string) => Number(raw), maxFrequency: 1 };

describe('lightstreamerTransport', () => {
  it('subscribes, forwards parsed items and statuses, and tears down once', () => {
    const f = fakeLs();
    const items: unknown[] = [], conns: string[] = [];
    const stop = lightstreamerTransport(f.ls, config).start({ onItem: (u) => items.push(u), onConnection: (s) => conns.push(s) });
    expect(f.log).toEqual(['new https://ls.example SET', 'sub MERGE A,B Value,T', 'freq 1', 'connect', 'subscribe']);
    f.emit('A', { Value: '0.5', T: '1700' });
    f.emit('B', { Value: null, T: 'junk' });
    expect(items).toEqual([{ item: 'A', value: 0.5, sourceTimeMs: 1700 }, expect.objectContaining({ item: 'B', value: NaN })]);
    f.status('CONNECTING'); f.status('CONNECTED:WS-STREAMING'); f.status('DISCONNECTED:WILL-RETRY'); f.status('STALLED');
    expect(conns).toEqual(['connecting', 'connected', 'disconnected', 'disconnected']);
    stop(); stop();
    expect(f.log.filter((l) => l === 'disconnect')).toHaveLength(1);
  });

  it('maps client status strings conservatively', () => {
    expect(connectionFromStatus('CONNECTED:HTTP-POLLING')).toBe('connected');
    expect(connectionFromStatus('DISCONNECTED')).toBe('disconnected');
    expect(connectionFromStatus('whatever')).toBe('disconnected');
  });
});
