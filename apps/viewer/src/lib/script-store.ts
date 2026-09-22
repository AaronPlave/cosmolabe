/**
 * Named script programs, persisted in `localStorage`.
 *
 * A second key rather than a field of `cosmolabe-viewer-prefs`: prefs are a tiny
 * defaults-merged record rewritten on every display toggle, and programs are
 * unbounded user text. Folding one into the other would rewrite every saved
 * program each time someone pressed `t`, and a prefs reset would take them too.
 *
 * Deliberately not a versioned envelope with per-entry salvage. That machinery
 * earns its place after someone loses a program; until then the one rule that
 * matters is below — never overwrite text we could not read.
 */

const STORAGE_KEY = 'cosmolabe-viewer-scripts';

export interface SavedProgram {
  readonly source: string;
  /** `Date.now()` at the last save, for ordering the list. */
  readonly updated: number;
}

/**
 * Why a save or delete did not happen.
 *
 * - `unavailable` — no storage, or it threw (private mode, quota).
 * - `unreadable` — something is stored under our key that is not a program
 *   record. Writing would replace it, and it may be the user's programs from a
 *   build that wrote them differently, so we refuse instead.
 */
export type ScriptStoreFailure = 'unavailable' | 'unreadable';

/** The subset of `Storage` this module touches, so a test can hand it a map. */
export type ScriptStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): ScriptStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Accessing `localStorage` itself throws in some sandboxed iframes.
    return null;
  }
}

type ReadResult =
  | { ok: true; programs: Record<string, SavedProgram> }
  | { ok: false; reason: ScriptStoreFailure };

function isProgram(value: unknown): value is SavedProgram {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SavedProgram).source === 'string' &&
    typeof (value as SavedProgram).updated === 'number'
  );
}

function read(storage: ScriptStorage | null): ReadResult {
  if (!storage) return { ok: false, reason: 'unavailable' };
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (raw == null) return { ok: true, programs: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: 'unreadable' };
    }
    const programs: Record<string, SavedProgram> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (!isProgram(value)) return { ok: false, reason: 'unreadable' };
      programs[name] = value;
    }
    return { ok: true, programs };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

function write(storage: ScriptStorage, programs: Record<string, SavedProgram>): ScriptStoreFailure | null {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(programs));
    return null;
  } catch {
    return 'unavailable';
  }
}

/** Saved programs, most recently saved first. Empty when storage is unreadable. */
export function listPrograms(
  storage: ScriptStorage | null = defaultStorage(),
): { name: string; program: SavedProgram }[] {
  const result = read(storage);
  if (!result.ok) return [];
  return Object.entries(result.programs)
    .map(([name, program]) => ({ name, program }))
    .sort((a, b) => b.program.updated - a.program.updated || a.name.localeCompare(b.name));
}

/** Why the store cannot be used right now, or `null` when it can. */
export function storeProblem(storage: ScriptStorage | null = defaultStorage()): ScriptStoreFailure | null {
  const result = read(storage);
  return result.ok ? null : result.reason;
}

/** Save `source` under `name`, replacing any program already called that. */
export function saveProgram(
  name: string,
  source: string,
  storage: ScriptStorage | null = defaultStorage(),
  now: number = Date.now(),
): ScriptStoreFailure | null {
  const result = read(storage);
  if (!result.ok) return result.reason;
  return write(storage!, { ...result.programs, [name]: { source, updated: now } });
}

export function deleteProgram(
  name: string,
  storage: ScriptStorage | null = defaultStorage(),
): ScriptStoreFailure | null {
  const result = read(storage);
  if (!result.ok) return result.reason;
  if (!(name in result.programs)) return null;
  const { [name]: _removed, ...rest } = result.programs;
  return write(storage!, rest);
}
