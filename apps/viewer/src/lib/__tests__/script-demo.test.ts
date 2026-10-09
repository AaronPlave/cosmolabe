import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parse } from '@cosmolabe/control';
import { fetchScript, queueScript, takePendingScript } from '../script-demo.svelte';
import { parseCatalogIndex } from '../catalog-sources';
import { shell } from '../shell.svelte';

const catalogsDir = new URL('../../../test-catalogs/', import.meta.url);
const indexUrl = new URL('index.json', catalogsDir).href;
const { index } = parseCatalogIndex(JSON.parse(readFileSync(new URL(indexUrl), 'utf8')), indexUrl);
const scripted = index.catalogs.filter((e) => e.scriptUrl);

describe('scripted demos', () => {
  it('the Examples index offers at least one', () => {
    expect(scripted.length).toBeGreaterThan(0);
  });

  it.each(scripted.map((e) => [e.id, e.scriptUrl!] as const))('%s parses against the verb table', (_id, url) => {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    expect(() => parse(source)).not.toThrow();
  });

  it('queues a script for the console once, and opens the console', () => {
    queueScript('wait 1');
    expect(shell.openTools).toContain('script');
    expect(takePendingScript()).toEqual({ source: 'wait 1', autorun: true });
    expect(takePendingScript()).toBeNull();
  });

  it('fetches a script, and fails loudly when it cannot', async () => {
    const ok = vi.fn(async () => new Response('wait 1'));
    await expect(fetchScript('https://x/t.cosmo', ok as unknown as typeof fetch)).resolves.toBe('wait 1');
    const missing = vi.fn(async () => new Response('', { status: 404 }));
    await expect(fetchScript('https://x/t.cosmo', missing as unknown as typeof fetch)).rejects.toThrow(/HTTP 404/);
  });
});
