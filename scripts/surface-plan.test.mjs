import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const cli = resolve('scripts/plan-surface.mjs');
const fixture = resolve('docs/examples/surface-plans/jezero.plan.json');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000 });
describe('offline surface plan CLI', () => {
  it('has stable JSON output and resolves GeoJSON from the plan directory, independent of cwd', () => {
    const a = run(fixture, '--json'), b = run(fixture, '--json');
    expect(a.status).toBe(0); expect(a.stderr).toBe(''); expect(a.stdout).toBe(b.stdout);
    const result = JSON.parse(a.stdout);
    expect(result.stage).toBe('geometry-only');
    expect(result.bands).toHaveLength(6);
    const elsewhere = spawnSync(process.execPath, [cli, fixture, '--json'], { encoding: 'utf8', cwd: tmpdir(), timeout: 15000 });
    expect(elsewhere.stdout).toBe(a.stdout);
  });
  it('writes summary JSON while printing a readable report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'surface-plan-'));
    try {
      const output = join(dir, 'estimate.json');
      const result = run(fixture, '--sources', resolve('docs/examples/surface-plans/jezero.sources.json'), '--out', output);
      expect(result.status).toBe(0); expect(result.stdout).toContain('Surface data plan — source-aware');
      expect(JSON.parse(await readFile(output, 'utf8')).sourceDownload.candidateIds).toEqual(['synthetic-mars-coarse-dem']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('reports missing and remote references without attempting downloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'surface-plan-'));
    try {
      const p = JSON.parse(await readFile(fixture, 'utf8'));
      const file = join(dir, 'plan.json');
      for (const name of ['missing.geojson', 'https://example.invalid/never-fetch.geojson']) {
        p.layers[0].source = name;
        await writeFile(file, JSON.stringify(p));
        const result = run(file, '--json');
        expect(result.status).toBe(2); expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr).diagnostics[0].code).toBe('unresolved-reference');
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('rejects unknown arguments and input overwrite, and documents invocation', () => {
    expect(run('--help').stdout).toContain('plan:surface');
    expect(run(fixture, '--typo').status).toBe(2);
    expect(run(fixture, '--out', fixture).status).toBe(2);
    const unsupported = run(resolve('docs/examples/surface-plans/lunar-pole-unsupported.plan.json'));
    expect(unsupported.status).toBe(2); expect(unsupported.stderr).toContain('Pole-enclosing');
  });
});
