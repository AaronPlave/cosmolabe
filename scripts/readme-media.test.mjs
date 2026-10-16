import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const driver = fileURLToPath(new URL('./capture-readme-media.mjs', import.meta.url));
const list = (...args) => execFileSync(process.execPath, [driver, ...args, '--list'], { encoding: 'utf8' }).trim().split('\n');

describe('README capture selection', () => {
  it('defaults to the six standard captures without requiring experimental terrain', () => {
    expect(list()).toEqual(['clipper', 'lro', 'cassini', 'events', 'measurements', 'tour']);
  });
  it('includes Mars only when explicitly requested', () => {
    expect(list('mars')).toEqual(['mars']);
    expect(list('--all')).toEqual(['clipper', 'lro', 'cassini', 'mars', 'events', 'measurements', 'tour']);
  });
  it('rejects ambiguous all-plus-scene requests before launching a browser', () => {
    const result = spawnSync(process.execPath, [driver, '--all', 'mars', '--list'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--all cannot be combined with scene names');
  });
});
