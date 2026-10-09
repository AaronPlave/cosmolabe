import { describe, expect, it } from 'vitest';
import {
  deleteProgram, listPrograms, saveProgram, storeProblem, type ScriptStorage,
  readLibrary, saveToLibrary, deleteFromLibrary,
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

describe('program library', () => {
  it('keeps a write failure visible when the store still reads fine', () => {
    // Reads succeed, writes fail: a quota error. Re-reading after the save
    // finds a perfectly readable store, which must not erase the failure.
    const s = memory(JSON.stringify({ kept: { source: 'deselect', updated: 1 } }));
    const full: ScriptStorage = { getItem: s.getItem, setItem: () => { throw new Error('QuotaExceededError'); } };

    const lib = saveToLibrary('new one', 'untrack', full);
    expect(lib.readProblem).toBeNull();
    expect(lib.writeProblem).toEqual({ op: 'save', name: 'new one', reason: 'unavailable' });
    expect(lib.programs.map((p) => p.name)).toEqual(['kept']);

    expect(deleteFromLibrary('kept', full).writeProblem).toEqual({ op: 'delete', name: 'kept', reason: 'unavailable' });
  });

  it('clears the write failure once a write succeeds', () => {
    const s = memory();
    expect(saveToLibrary('a', 'deselect', s).writeProblem).toBeNull();
    expect(deleteFromLibrary('a', s)).toEqual({ programs: [], readProblem: null, writeProblem: null });
  });

  it('reports an unreadable store as a read problem, and a save into it as refused', () => {
    const s = memory('not json');
    expect(readLibrary(s)).toEqual({ programs: [], readProblem: 'unreadable', writeProblem: null });
    expect(saveToLibrary('a', 'x', s).writeProblem).toEqual({ op: 'save', name: 'a', reason: 'unreadable' });
  });
});
