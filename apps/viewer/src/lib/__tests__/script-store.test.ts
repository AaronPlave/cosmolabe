import { describe, expect, it } from 'vitest';
import {
  deleteProgram, listPrograms, saveProgram, storeProblem, type ScriptStorage,
} from '../script-store';

function memory(initial?: string): ScriptStorage & { raw: () => string | null } {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_k, v) => { value = v; },
    raw: () => value,
  };
}

describe('script-store', () => {
  it('saves, lists most-recent first, and replaces by name', () => {
    const s = memory();
    expect(saveProgram('a', 'deselect', s, 1)).toBeNull();
    expect(saveProgram('b', 'untrack', s, 2)).toBeNull();
    expect(listPrograms(s).map((p) => p.name)).toEqual(['b', 'a']);
    expect(saveProgram('a', 'setPlaying off', s, 3)).toBeNull();
    const list = listPrograms(s);
    expect(list.map((p) => p.name)).toEqual(['a', 'b']);
    expect(list[0].program.source).toBe('setPlaying off');
  });

  it('deletes by name, and deleting a missing name is not a failure', () => {
    const s = memory();
    saveProgram('a', 'deselect', s, 1);
    expect(deleteProgram('nope', s)).toBeNull();
    expect(deleteProgram('a', s)).toBeNull();
    expect(listPrograms(s)).toEqual([]);
  });

  it('keeps its own key, separate from the viewer prefs', () => {
    const keys: string[] = [];
    const s: ScriptStorage = { getItem: () => null, setItem: (k) => { keys.push(k); } };
    saveProgram('a', 'deselect', s);
    expect(keys).toEqual(['cosmolabe-viewer-scripts']);
  });

  it('refuses to overwrite text it could not read', () => {
    for (const bad of ['not json', '[1,2]', '{"a":{"source":3,"updated":1}}']) {
      const s = memory(bad);
      expect(storeProblem(s)).toBe('unreadable');
      expect(listPrograms(s)).toEqual([]);
      expect(saveProgram('a', 'deselect', s)).toBe('unreadable');
      expect(deleteProgram('a', s)).toBe('unreadable');
      expect(s.raw()).toBe(bad);
    }
  });

  it('reports storage that throws or is absent as unavailable', () => {
    const throwing: ScriptStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(storeProblem(throwing)).toBe('unavailable');
    expect(saveProgram('a', 'x', throwing)).toBe('unavailable');
    expect(storeProblem(null)).toBe('unavailable');

    const full: ScriptStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(saveProgram('a', 'x', full)).toBe('unavailable');
  });
});
