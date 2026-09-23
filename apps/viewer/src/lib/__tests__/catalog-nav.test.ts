import { describe, it, expect } from 'vitest';
import {
  allEntries,
  browseLabel,
  catalogLocation,
  featuredEntries,
  findEntry,
  requestedCatalog,
  withCatalogLocation,
} from '../catalog-nav';
import type { CatalogEntry, CatalogSourceState } from '../catalog-sources';

const PAGE = 'https://viewer.example/app/?test=1';

function ready(id: string, name: string, catalogs: CatalogEntry[]): CatalogSourceState {
  return {
    source: { id, name, indexUrl: `${id}/index.json` },
    status: 'ready',
    index: { version: 1, catalogs },
    indexUrl: `https://viewer.example/app/${id}/index.json`,
    warnings: [],
  };
}

const entry = (id: string, catalogUrl: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id,
  name: id,
  catalogUrl,
  ...extra,
});

describe('featuredEntries', () => {
  it('prefers featured entries across sources', () => {
    const states = [
      ready('a', 'A', [entry('a1', 'https://x/a1.json'), entry('a2', 'https://x/a2.json', { featured: true })]),
      ready('b', 'B', [entry('b1', 'https://x/b1.json', { featured: true })]),
    ];
    expect(featuredEntries(states).map((e) => e.entry.id)).toEqual(['a2', 'b1']);
  });

  it('falls back to the first few entries when none is featured', () => {
    const catalogs = Array.from({ length: 10 }, (_, i) => entry(`e${i}`, `https://x/${i}.json`));
    expect(featuredEntries([ready('m', 'Mission', catalogs)], 3).map((e) => e.entry.id)).toEqual(['e0', 'e1', 'e2']);
  });

  it('ignores sources that failed or are still loading', () => {
    const states: CatalogSourceState[] = [
      { source: { id: 'x', name: 'X', indexUrl: 'x' }, status: 'loading' },
      { source: { id: 'y', name: 'Y', indexUrl: 'y' }, status: 'error', indexUrl: 'y', error: 'HTTP 404' },
      ready('m', 'Mission', [entry('baseline', 'https://x/b.json')]),
    ];
    expect(allEntries(states).map((e) => e.sourceId)).toEqual(['m']);
    expect(featuredEntries(states)).toHaveLength(1);
  });

  it('has nothing to list with no sources', () => {
    expect(featuredEntries([])).toEqual([]);
  });
});

describe('browseLabel', () => {
  it('has no browse action with zero sources', () => {
    expect(browseLabel([])).toBeNull();
  });
  it('names a single source, whatever it is called', () => {
    expect(browseLabel([ready('examples', 'Examples', [])])).toBe('Browse examples');
    expect(browseLabel([ready('m', 'Mission', [])])).toBe('Browse mission');
  });
  it('says catalogs for several', () => {
    expect(browseLabel([ready('a', 'A', []), ready('b', 'B', [])])).toBe('Browse catalogs');
  });
});

describe('catalogLocation', () => {
  it('writes a same-origin catalog as the existing ?catalog= deep link', () => {
    const item = { sourceId: 'examples', entry: entry('cassini', 'https://viewer.example/app/cassini-soi.json') };
    expect(catalogLocation(item, PAGE)).toEqual({ catalog: 'cassini-soi' });
  });

  it('keeps subdirectories and parent paths on the same origin', () => {
    const nested = { sourceId: 'examples', entry: entry('base/solarsys', 'https://viewer.example/app/base/solarsys.json') };
    expect(catalogLocation(nested, PAGE)).toEqual({ catalog: 'base/solarsys' });
    const up = { sourceId: 'mission', entry: entry('baseline', 'https://viewer.example/catalogs/baseline.json') };
    const loc = catalogLocation(up, PAGE);
    expect(loc).toEqual({ catalog: '../catalogs/baseline' });
    // Round-trips through loadDemo's resolution.
    expect(new URL(`./${(loc as { catalog: string }).catalog}.json`, PAGE).href).toBe(up.entry.catalogUrl);
  });

  it('names an off-origin catalog by source and entry, never by URL', () => {
    const item = { sourceId: 'mission', entry: entry('baseline', 'https://data.example/m/baseline.json') };
    expect(catalogLocation(item, PAGE)).toEqual({ entry: 'mission/baseline' });
  });

  it('does not squeeze a query-string catalog URL into ?catalog=', () => {
    const item = { sourceId: 's', entry: entry('q', 'https://viewer.example/app/cat.json?v=2') };
    expect(catalogLocation(item, PAGE)).toEqual({ entry: 's/q' });
  });
});

describe('findEntry', () => {
  const states = [ready('examples', 'Examples', [entry('base/solarsys', 'https://x/s.json')])];
  it('splits at the first slash so entry ids may contain one', () => {
    expect(findEntry(states, 'examples/base/solarsys')?.entry.id).toBe('base/solarsys');
  });
  it('finds nothing for an unknown source or entry, or a malformed param', () => {
    expect(findEntry(states, 'other/base/solarsys')).toBeNull();
    expect(findEntry(states, 'examples/nope')).toBeNull();
    expect(findEntry(states, 'examples')).toBeNull();
    expect(findEntry(states, '/x')).toBeNull();
  });
});

describe('URL parameters', () => {
  it('reads ?catalog= ahead of ?entry=', () => {
    expect(requestedCatalog('?catalog=a&entry=s/e')).toEqual({ catalog: 'a' });
    expect(requestedCatalog('?entry=s/e')).toEqual({ entry: 's/e' });
    expect(requestedCatalog('?test=1')).toBeNull();
  });

  it('replaces only the catalog parameters and keeps the rest', () => {
    expect(withCatalogLocation('?test=1&catalog=old', { catalog: 'base/solarsys' })).toBe('?test=1&catalog=base/solarsys');
    expect(withCatalogLocation('?catalog=old&source=x', { entry: 'm/b' })).toBe('?source=x&entry=m/b');
    expect(withCatalogLocation('?catalog=old', null)).toBe('');
  });
});
