import { describe, expect, it, vi, afterEach } from 'vitest';
import { Universe, GEOGRAPHIC_LIMITS, parseGeographicGeoJson } from '@cosmolabe/core';
import { categorizeFiles, resolveCatalogOrder, rememberLocalFilePath } from '../local-files';
import { prepareGeographicCatalogs } from '../geographic-loading';
import { readLocalJsonType } from '../local-json-type';

const coordinates = { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '0..360',
  referenceShape: { kind: 'sphere', radiusKm: 3396.19 } };
const mission = { name: 'Mission', require: ['../bodies/mars.json'], geographicCoordinates: coordinates,
  geographicLayers: [{ id: 'sites', name: 'Sites', body: 'Mars', source: '../vectors/sites.geojson' }] };
const body = { name: 'Mars body', items: [{ name: 'Mars', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, geometry: { type: 'Globe', radius: 3396.19 } }] };
const geo = (name = 'site') => JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', id: name,
  properties: { name }, geometry: { type: 'Point', coordinates: [77.45, 18.45] } }] });
const parser = async (args: Parameters<typeof parseGeographicGeoJson>) => parseGeographicGeoJson(...args);
function file(text: string, path: string, directory = true): File {
  const f = new File([text], path.split('/').at(-1)!);
  if (directory) Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}
afterEach(() => vi.restoreAllMocks());

describe('selected files → local require graph → geographic loading', () => {
  it.each([true, false])('resolves relative requires before the mission, with directory paths=%s', async directory => {
    const files = await categorizeFiles([
      file(JSON.stringify(mission), 'bundle/mission/scene.json', directory),
      file(JSON.stringify(body), 'bundle/bodies/mars.json', directory),
      file(geo(), 'bundle/vectors/sites.geojson', directory),
    ]);
    const graph = resolveCatalogOrder(files.jsonFiles);
    expect(graph.map(x => x.json.name)).toEqual(['Mars body', 'Mission']);
    const loaded = await prepareGeographicCatalogs(graph, new AbortController().signal, files.dataFiles, parser);
    const universe = new Universe();
    graph.forEach(({ json, url }, i) => universe.loadCatalog(json, { source: url, geographicLayers: loaded[i].loads }));
    expect(universe.getBody('Mars')).toBeDefined();
    expect(universe.geographicLayers.get('sites')!.features[0].properties).toEqual({ name: 'site' });
    universe.dispose();
  });

  it.each(['geojson', 'json'])('preserves duplicate .%s basenames through the actual categorizer and rejects directory fallback', async extension => {
    const files = await categorizeFiles([
      file(geo('a'), `a/sites.${extension}`), file(geo('b'), `b/sites.${extension}`),
      file(JSON.stringify({ ...mission, require: [], geographicLayers: [{ ...mission.geographicLayers[0], source: `sites.${extension}` }] }), 'scene.json'),
    ]);
    expect([...files.dataFiles.keys()]).toEqual([`a/sites.${extension}`, `b/sites.${extension}`]);
    const loaded = await prepareGeographicCatalogs(resolveCatalogOrder(files.jsonFiles), new AbortController().signal, files.dataFiles, parser);
    expect(loaded[0].loads[0].status).toBe('error');
    expect(loaded[0].loads[0].diagnostics[0].message).toContain('basename fallback is disabled');
  });

  it('also preserves flat selections containing two physically distinct files with the same name', async () => {
    const files = await categorizeFiles([file(geo('a'), 'sites.geojson', false), file(geo('b'), 'sites.geojson', false)]);
    expect(files.dataFiles.size).toBe(2);
    expect(files.dataFiles.has('sites.geojson')).toBe(false);
    const loaded = await prepareGeographicCatalogs([{ url: 'scene.json', json: { ...mission, require: [],
      geographicLayers: [{ ...mission.geographicLayers[0], source: 'sites.geojson' }] } as any }], new AbortController().signal, files.dataFiles, parser);
    expect(loaded[0].loads[0].diagnostics[0].message).toContain('ambiguous');
  });

  it('uses the declaring catalog directory to disambiguate both required catalogs and vector sources', async () => {
    const files = await categorizeFiles([
      file(JSON.stringify({ ...mission, geographicLayers: [{ ...mission.geographicLayers[0], source: '../a/sites.geojson' }] }), 'bundle/mission/scene.json'),
      file(JSON.stringify(body), 'bundle/bodies/mars.json'), file(JSON.stringify({ name: 'Other Mars', items: [] }), 'other/mars.json'),
      file(geo('a'), 'bundle/a/sites.geojson'), file(geo('b'), 'bundle/b/sites.geojson'),
    ]);
    const graph = resolveCatalogOrder(files.jsonFiles);
    expect(graph.map(x => x.url)).toEqual(['bundle/bodies/mars.json', 'bundle/mission/scene.json']);
    const loaded = await prepareGeographicCatalogs(graph, new AbortController().signal, files.dataFiles, parser);
    expect(loaded[1].loads[0].layer!.features[0].properties).toEqual({ name: 'a' });
  });

  it('diagnoses missing/ambiguous dependencies and cycles instead of loading without required bodies', async () => {
    const missing = await categorizeFiles([file(JSON.stringify(mission), 'scene.json')]);
    expect(() => resolveCatalogOrder(missing.jsonFiles)).toThrow(/require.*mars.json.*scene.json.*missing/);
    const ambiguous = await categorizeFiles([file(JSON.stringify(mission), 'scene.json'),
      file(JSON.stringify(body), 'a/mars.json'), file(JSON.stringify(body), 'b/mars.json')]);
    expect(() => resolveCatalogOrder(ambiguous.jsonFiles)).toThrow('basename fallback is disabled');
    const cyclic = await categorizeFiles([file('{"require":["b.json"]}', 'a.json'), file('{"require":["a.json"]}', 'b.json')]);
    expect(() => resolveCatalogOrder(cyclic.jsonFiles)).toThrow('cycle');
  });

  it('retains FileSystemEntry paths when drag/drop File objects do not carry webkitRelativePath', async () => {
    const f = file(JSON.stringify(mission), 'scene.json', false);
    rememberLocalFilePath(f, '/bundle/mission/scene.json');
    expect([...(await categorizeFiles([f])).jsonFiles.keys()]).toEqual(['bundle/mission/scene.json']);
  });

  it.each([false, true])('rejects a missing relative require despite one same-basename catalog in the wrong directory (dropped=%s)', async dropped => {
    const entries = [[JSON.stringify(mission), 'bundle/mission/scene.json'], [JSON.stringify(body), 'bundle/old/mars.json']];
    const files = await categorizeFiles(entries.map(([text, path]) => {
      const f = file(text, path, !dropped);
      if (dropped) rememberLocalFilePath(f, `/${path}`);
      return f;
    }));
    expect(() => resolveCatalogOrder(files.jsonFiles)).toThrow('Local source missing: "bundle/bodies/mars.json"');
  });

  it.each([false, true])('rejects a missing geographic path despite one same-basename dataset in the wrong directory (dropped=%s)', async dropped => {
    const entries = [[JSON.stringify(mission), 'bundle/mission/scene.json'],
      [JSON.stringify(body), 'bundle/bodies/mars.json'], [geo('wrong dataset'), 'bundle/old/sites.geojson']];
    const files = await categorizeFiles(entries.map(([text, path]) => {
      const f = file(text, path, !dropped);
      if (dropped) rememberLocalFilePath(f, `/${path}`);
      return f;
    }));
    const parseSource = vi.fn(parser);
    const loaded = await prepareGeographicCatalogs(resolveCatalogOrder(files.jsonFiles), new AbortController().signal, files.dataFiles, parseSource);
    expect(loaded[1].loads[0]).toMatchObject({ status: 'error', diagnostics: [{ message: expect.stringContaining('Local source missing: "bundle/vectors/sites.geojson"') }] });
    expect(loaded[1].loads[0].layer).toBeUndefined();
    expect(parseSource).not.toHaveBeenCalled();
  });

  it('retains directory-selection provenance when the only geographic file itself has no directory information', async () => {
    const files = await categorizeFiles([file(JSON.stringify(mission), 'bundle/mission/scene.json'),
      file(JSON.stringify(body), 'bundle/bodies/mars.json'), file(geo(), 'sites.geojson', false)]);
    const loaded = await prepareGeographicCatalogs(resolveCatalogOrder(files.jsonFiles), new AbortController().signal, files.dataFiles, parser);
    expect(loaded[1].loads[0].status).toBe('error');
    expect(loaded[1].loads[0].diagnostics[0].message).toContain('basename fallback is disabled');
  });

  it('still resolves flat selections with unique basenames when duplicate catalog names have synthetic identities', async () => {
    const files = await categorizeFiles([file(JSON.stringify(mission), 'scene.json', false),
      file(JSON.stringify({ ...mission, name: 'Second mission' }), 'scene.json', false),
      file(JSON.stringify(body), 'mars.json', false), file(geo(), 'sites.geojson', false)]);
    const graph = resolveCatalogOrder(files.jsonFiles);
    expect(graph.map(x => x.json.name)).toEqual(['Mars body', 'Mission', 'Second mission']);
    const loaded = await prepareGeographicCatalogs(graph, new AbortController().signal, files.dataFiles, parser);
    expect(loaded.slice(1).map(x => x.loads[0].status)).toEqual(['ready', 'ready']);
  });
});

describe('large local JSON classification', () => {
  it('continues to accept legitimate catalogs larger than the geographic byte limit', async () => {
    const text = JSON.stringify({ metadata: 'x'.repeat(GEOGRAPHIC_LIMITS.maxBytes), ...body });
    const files = await categorizeFiles([file(text, 'large-catalog.json')]);
    expect(resolveCatalogOrder(files.jsonFiles)[0].json.items![0].name).toBe('Mars');
  });

  it('rejects oversized geographic .json before file.text/JSON.parse, even when type follows the features', async () => {
    const f = file(`{"features":[],"padding":"${'x'.repeat(GEOGRAPHIC_LIMITS.maxBytes)}","type":"FeatureCollection"}`, 'large.json');
    const text = vi.spyOn(f, 'text');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const files = await categorizeFiles([f]);
    expect(text).not.toHaveBeenCalled();
    expect(files.jsonFiles.size).toBe(0);
    expect(files.dataFiles.size).toBe(0);
    expect(warn.mock.calls[0][1]).toMatchObject({ message: expect.stringContaining('2 MiB') });
  });

  it('classifies only the root type, decodes escapes across chunks and honors the last duplicate key', async () => {
    const text = String.raw`{"nested":{"type":"wrong"},"label":"escaped \" { } ","ty\u0070e":"first","type":"FeatureCollection"}`;
    const f = file(text, 'type.json');
    const bytes = new TextEncoder().encode(text);
    vi.spyOn(f, 'stream').mockImplementation(() => new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } }));
    expect(await readLocalJsonType(f)).toBe('FeatureCollection');
    expect(await readLocalJsonType(file('{"type":"FeatureCollection","type":null}', 'type.json'))).toBeUndefined();
    expect(await readLocalJsonType(file('{"nested":{"type":"FeatureCollection"}}', 'type.json'))).toBeUndefined();
  });
});
