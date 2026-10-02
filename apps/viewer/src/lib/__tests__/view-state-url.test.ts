import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requestedView, viewLink } from '../view-state-url';

const frozen = readFileSync(new URL('../../../test-permalinks/earth-moon-v1.url', import.meta.url), 'utf8').trim();
const page = 'https://viewer.example/';

describe('view URLs', () => {
  it('decodes the frozen v1 link without inferring time or camera semantics', () => {
    expect(requestedView(new URL(frozen, page).search)).toMatchObject({ version: 1,
      catalog: { catalog: 'earth-moon' }, time: { kind: 'fixed', source: 'ET', et: 773323269.184 },
      view: { kind: 'named', name: 'Lunar Orbit', fov: 42 }, navigation: { selected: 'Moon', tracked: 'Earth' } });
  });

  it('keeps deployment sources, replaces catalog identity and omits test mode', () => {
    const state = requestedView(new URL(frozen, page).search)!;
    const url = new URL(viewLink(state, `${page}?entry=other/id&source=https://data.example/index.json&test=1`));
    expect(url.searchParams.get('entry')).toBeNull();
    expect(url.searchParams.get('catalog')).toBe('earth-moon');
    expect(url.searchParams.get('source')).toBe('https://data.example/index.json');
    expect(url.searchParams.get('test')).toBeNull();
    expect(requestedView(url.search)).toEqual(state);
  });

  it('distinguishes no state from malformed and unsupported state', () => {
    expect(requestedView('?catalog=earth-moon')).toBeNull();
    expect(() => requestedView('?view=')).toThrow(/JSON/);
    expect(() => requestedView('?view=%7B%22version%22%3A99%7D')).toThrow(/version/);
  });

  it('round-trips the frozen event query/selection extension through the same URL', () => {
    const fixture = readFileSync(new URL('../../../test-permalinks/earth-moon-events-v1.url', import.meta.url), 'utf8').trim();
    const state = requestedView(new URL(fixture, page).search)!;
    expect(state.events).toMatchObject({ version: 1, current: 0, queries: [{
      query: { kind: 'closest-approach', bodies: { observer: 'Earth', target: 'Moon' }, abcorr: 'NONE' },
      searched: true, windowMode: 'explicit',
    }], selected: { query: 0, temporality: 'instant' } });
    expect(state.time.kind === 'fixed' && state.time.et).not.toBe(state.events!.selected!.start);
    expect(requestedView(new URL(viewLink(state, page)).search)).toEqual(state);
    const bad = { ...state, events: { ...state.events, version: 99 } };
    expect(() => requestedView(`?view=${encodeURIComponent(JSON.stringify(bad))}`)).toThrow(/Event context.*version/);
  });
});
