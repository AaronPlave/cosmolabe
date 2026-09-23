import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CATALOG_INDEX_VERSION,
  fetchCatalogSource,
  groupEntries,
  loadCatalogSources,
  parseCatalogIndex,
  parseSourceConfig,
  type CatalogSourceState,
  type IndexFetcher,
} from '../catalog-sources';
import { resolveCatalogSourceDeployment } from '../deployment';
import { loadCatalogFromUrl } from '@cosmolabe/core';

const BASE = 'https://viewer.example/app/';

describe('parseSourceConfig', () => {
  it('accepts zero sources', () => {
    expect(parseSourceConfig('[]')).toEqual({ sources: [], errors: [] });
    expect(parseSourceConfig('')).toEqual({ sources: [], errors: [] });
    expect(parseSourceConfig(undefined)).toEqual({ sources: [], errors: [] });
  });

  it('accepts several sources, defaulting the name to the id', () => {
    const { sources, errors } = parseSourceConfig(
      JSON.stringify([
        { id: 'mission', name: 'Europa Clipper', indexUrl: '/catalogs/index.json' },
        { id: 'shared', indexUrl: '/shared/index.json' },
      ]),
    );
    expect(errors).toEqual([]);
    expect(sources).toEqual([
      { id: 'mission', name: 'Europa Clipper', indexUrl: '/catalogs/index.json' },
      { id: 'shared', name: 'shared', indexUrl: '/shared/index.json' },
    ]);
  });

  it('reports bad JSON instead of throwing', () => {
    const { sources, errors } = parseSourceConfig('[{');
    expect(sources).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('drops an invalid or duplicate source and keeps the rest', () => {
    const { sources, errors } = parseSourceConfig([
      { id: 'a', indexUrl: 'a.json' },
      { id: 'b' },
      { id: 'a', indexUrl: 'again.json' },
      'nope',
    ]);
    expect(sources.map((s) => s.id)).toEqual(['a']);
    expect(errors).toHaveLength(3);
  });
});

describe('parseCatalogIndex', () => {
  const indexUrl = 'https://data.example/mission/catalogs/index.json';

  it('keeps featured only when it is exactly true', () => {
    const { index } = parseCatalogIndex(
      {
        version: 1,
        catalogs: [
          { id: 'a', catalog: 'a.json', featured: true },
          { id: 'b', catalog: 'b.json', featured: 'yes' },
          { id: 'c', catalog: 'c.json' },
        ],
      },
      indexUrl,
    );
    expect(index.catalogs.map((e) => e.featured)).toEqual([true, undefined, undefined]);
  });

  it('resolves catalog URLs against the index URL', () => {
    const { index, warnings } = parseCatalogIndex(
      {
        version: 1,
        name: 'Europa Clipper',
        catalogs: [
          { id: 'baseline', name: 'Baseline mission', catalog: './baseline.json' },
          { id: 'up', name: 'Up a level', catalog: '../shared/solarsys.json', group: 'Reference' },
          { id: 'abs', name: 'Absolute', catalog: 'https://other.example/x.json', description: 'Elsewhere' },
        ],
      },
      indexUrl,
    );
    expect(warnings).toEqual([]);
    expect(index.name).toBe('Europa Clipper');
    expect(index.catalogs).toEqual([
      { id: 'baseline', name: 'Baseline mission', catalogUrl: 'https://data.example/mission/catalogs/baseline.json' },
      { id: 'up', name: 'Up a level', catalogUrl: 'https://data.example/mission/shared/solarsys.json', group: 'Reference' },
      { id: 'abs', name: 'Absolute', catalogUrl: 'https://other.example/x.json', description: 'Elsewhere' },
    ]);
  });

  it('rejects a missing or unsupported version', () => {
    expect(() => parseCatalogIndex({ catalogs: [] }, indexUrl)).toThrow(/version/);
    expect(() => parseCatalogIndex({ version: 2, catalogs: [] }, indexUrl)).toThrow(/Unsupported/);
    expect(() => parseCatalogIndex({ version: '1', catalogs: [] }, indexUrl)).toThrow(/Unsupported/);
  });

  it('rejects an index with no catalogs array', () => {
    expect(() => parseCatalogIndex({ version: 1 }, indexUrl)).toThrow(/catalogs/);
    expect(() => parseCatalogIndex([], indexUrl)).toThrow(/object/);
  });

  it('skips malformed and duplicate entries with warnings', () => {
    const { index, warnings } = parseCatalogIndex(
      {
        version: 1,
        catalogs: [
          { id: 'ok', catalog: 'ok.json' },
          { id: 'no-catalog' },
          { id: 'ok', catalog: 'dup.json' },
          null,
        ],
      },
      indexUrl,
    );
    expect(index.catalogs.map((e) => e.id)).toEqual(['ok']);
    expect(index.catalogs[0].name).toBe('ok');
    expect(warnings).toHaveLength(3);
  });
});

describe('fetching sources', () => {
  const indexes: Record<string, unknown> = {
    'https://viewer.example/app/good/index.json': {
      version: 1,
      catalogs: [{ id: 'one', name: 'One', catalog: 'one.json' }],
    },
    'https://viewer.example/shared/index.json': {
      version: 1,
      catalogs: [{ id: 'two', name: 'Two', catalog: 'sub/two.json' }],
    },
    'https://viewer.example/app/future/index.json': { version: 99, catalogs: [] },
  };
  const fetcher: IndexFetcher = async (url) => {
    if (!(url in indexes)) throw new Error('HTTP 404');
    return indexes[url];
  };

  it('resolves a relative indexUrl against the viewer base URL', async () => {
    const state = await fetchCatalogSource({ id: 'g', name: 'G', indexUrl: 'good/index.json' }, BASE, fetcher);
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.indexUrl).toBe('https://viewer.example/app/good/index.json');
    expect(state.index.catalogs[0].catalogUrl).toBe('https://viewer.example/app/good/one.json');
  });

  it('isolates failing sources from working ones', async () => {
    const updates: CatalogSourceState[][] = [];
    const states = await loadCatalogSources(
      [
        { id: 'missing', name: 'Missing', indexUrl: 'nowhere/index.json' },
        { id: 'good', name: 'Good', indexUrl: 'good/index.json' },
        { id: 'future', name: 'Future', indexUrl: 'future/index.json' },
        { id: 'shared', name: 'Shared', indexUrl: '/shared/index.json' },
      ],
      BASE,
      (s) => updates.push(s),
      fetcher,
    );
    expect(states.map((s) => s.status)).toEqual(['error', 'ready', 'error', 'ready']);
    expect(updates[0].every((s) => s.status === 'loading')).toBe(true);
    const shared = states[3];
    if (shared.status !== 'ready') throw new Error('expected ready');
    expect(shared.index.catalogs[0].catalogUrl).toBe('https://viewer.example/shared/sub/two.json');
  });

  it('turns a fetcher that throws a non-Error into an error state', async () => {
    const state = await fetchCatalogSource({ id: 'x', name: 'X', indexUrl: 'x.json' }, BASE, async () => {
      throw 'boom';
    });
    expect(state).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('handles zero sources', async () => {
    expect(await loadCatalogSources([], BASE, undefined, fetcher)).toEqual([]);
  });
});

describe('groupEntries', () => {
  it('groups in first-appearance order', () => {
    const e = (id: string, group?: string) => ({ id, name: id, catalogUrl: `${BASE}${id}.json`, group });
    const groups = groupEntries([e('a', 'G1'), e('b'), e('c', 'G1'), e('d', 'G2')]);
    expect(groups.map((g) => [g.heading, g.entries.map((x) => x.id)])).toEqual([
      ['G1', ['a', 'c']],
      [undefined, ['b']],
      ['G2', ['d']],
    ]);
  });
});

describe('deployment configuration', () => {
  it('assumes no sources when nothing is configured', () => {
    const d = resolveCatalogSourceDeployment({}, '', BASE);
    expect(d.sources).toEqual([]);
    expect(d.errors).toEqual([]);
  });

  it('matches what dev and the Pages deployment configure', () => {
    // The two places the examples are named: they must stay in step with the
    // index they point at.
    const readSources = (file: string, pattern: RegExp) => {
      const m = readFileSync(new URL(file, import.meta.url), 'utf8').match(pattern);
      expect(m, file).not.toBeNull();
      return resolveCatalogSourceDeployment({ VITE_CATALOG_SOURCES: m![1] }, '', BASE);
    };
    for (const d of [
      readSources('../../../.env.development', /^VITE_CATALOG_SOURCES='(.*)'$/m),
      readSources('../../../../../.github/workflows/deploy-pages.yml', /VITE_CATALOG_SOURCES: '(.*)'$/m),
    ]) {
      expect(d.errors).toEqual([]);
      expect(d.sources).toEqual([{ id: 'examples', name: 'Examples', indexUrl: 'index.json' }]);
    }
  });

  it('configures zero sources with an empty list', () => {
    expect(resolveCatalogSourceDeployment({ VITE_CATALOG_SOURCES: '[]' }, '', BASE).sources).toEqual([]);
  });

  it('exposes only a mission deployment’s own sources', () => {
    const d = resolveCatalogSourceDeployment(
      { VITE_CATALOG_SOURCES: '[{"id":"mission","name":"Europa Clipper","indexUrl":"/catalogs/index.json"}]' },
      '',
      BASE,
    );
    expect(d.sources.map((s) => s.id)).toEqual(['mission']);
  });

  it('ignores ?source= unless the deployment allows it', () => {
    const search = '?source=https%3A%2F%2Fdata.example%2Findex.json&source=other.json';
    expect(resolveCatalogSourceDeployment({ VITE_CATALOG_SOURCES: '[]' }, search, BASE).sources).toEqual([]);
    const allowed = resolveCatalogSourceDeployment(
      { VITE_CATALOG_SOURCES: '[{"id":"url-1","indexUrl":"a.json"}]', VITE_ALLOW_CATALOG_SOURCE_PARAM: 'true' },
      search,
      BASE,
    );
    expect(allowed.sources.map((s) => [s.id, s.indexUrl])).toEqual([
      ['url-1', 'a.json'],
      ['url-1-', 'https://data.example/index.json'],
      ['url-2', 'other.json'],
    ]);
  });
});

describe('the repository Examples index', () => {
  const TEST_CATALOGS = new URL('../../../test-catalogs/', import.meta.url);
  const indexUrl = new URL('index.json', TEST_CATALOGS);
  const json = JSON.parse(readFileSync(indexUrl, 'utf8'));
  const { index, warnings } = parseCatalogIndex(json, indexUrl.href);

  it('is a valid, current-version index', () => {
    expect(index.version).toBe(CATALOG_INDEX_VERSION);
    expect(warnings).toEqual([]);
    expect(index.catalogs.length).toBeGreaterThan(0);
  });

  it('points only at existing catalog files in the repository', () => {
    for (const entry of index.catalogs) {
      const path = fileURLToPath(entry.catalogUrl);
      expect(existsSync(path), `${entry.id} -> ${path}`).toBe(true);
      expect(path.startsWith(fileURLToPath(TEST_CATALOGS))).toBe(true);
    }
  });

  it('entries resolve through the ordinary require graph', async () => {
    const fileFetcher = async (url: string) => JSON.parse(readFileSync(new URL(url), 'utf8'));
    const solarsys = index.catalogs.find((e) => e.id === 'base/solarsys');
    expect(solarsys).toBeDefined();
    const graph = await loadCatalogFromUrl(solarsys!.catalogUrl, fileFetcher);
    // `require` composition is the catalog's own business: the index names the
    // top-level file, and the graph pulls in the rest.
    expect(graph.catalogs.length).toBeGreaterThan(1);
    expect(graph.catalogs.at(-1)!.url).toBe(pathToFileURL(fileURLToPath(solarsys!.catalogUrl)).href);
  });
});
