export type ViewerLogLevel = 'info' | 'warning' | 'error';

export interface ViewerLogEntry {
  id: number;
  timestamp: number;
  level: ViewerLogLevel;
  source: string;
  message: string;
  /** Identity of a continuing condition: same key, same fault, however its detail changes. */
  key?: string;
}

const MAX_ENTRIES = 150;
let nextId = 1;

export const viewerLog = $state({
  entries: [] as ViewerLogEntry[],
  activeFaultId: null as number | null,
});

export function recordViewerLog(
  level: ViewerLogLevel,
  source: string,
  message: string,
  options: { showStatus?: boolean; key?: string } = {},
): ViewerLogEntry {
  const entry: ViewerLogEntry = {
    id: nextId++,
    timestamp: Date.now(),
    level,
    source,
    message: message.trim() || 'No details provided.',
    ...(options.key !== undefined ? { key: options.key } : {}),
  };
  viewerLog.entries.unshift(entry);
  if (viewerLog.entries.length > MAX_ENTRIES) viewerLog.entries.length = MAX_ENTRIES;
  if (level === 'error' && options.showStatus !== false) viewerLog.activeFaultId = entry.id;
  return entry;
}

export function recordViewerFault(source: string, message: string): ViewerLogEntry {
  return recordViewerLog('error', source, message);
}

export function dismissViewerFault(): void {
  viewerLog.activeFaultId = null;
}

/** Continuing conditions by source: the key reported and the entry that carries it. */
const conditions = new Map<string, { key: string; id: number }>();

/**
 * Report a condition that is re-evaluated every frame. The log gains one entry
 * per distinct `key` (frame and reason); while the key holds, that entry's text
 * follows the latest detail (a new epoch, say), so the status never shows a
 * stale cause and a dismissed fault is not logged again every frame.
 */
export function setViewerFault(source: string, key: string, message: string): void {
  const current = conditions.get(source);
  const entry = current?.key === key ? viewerLog.entries.find(e => e.id === current.id) : undefined;
  if (entry) {
    if (entry.message !== message) entry.message = message;
    return;
  }
  conditions.set(source, { key, id: recordViewerLog('error', source, message, { key }).id });
}

/** The condition `source` reported has gone: leave the status and log the recovery. */
export function clearViewerFault(source: string): void {
  const continuing = conditions.delete(source);
  const active = viewerLog.entries.find(entry => entry.id === viewerLog.activeFaultId);
  const shown = active?.source === source;
  if (shown) viewerLog.activeFaultId = null;
  if (continuing || shown) recordViewerLog('info', source, 'Recovered.');
}

/**
 * Browser and extension noise that is not the viewer's and that nobody can act
 * on: extension scripts, opaque cross-origin "Script error." and the benign
 * ResizeObserver loop notice. Not recorded.
 */
export function isIncidentalRuntimeError(detail: { message?: string; filename?: string; stack?: string }): boolean {
  const where = `${detail.filename ?? ''}\n${detail.stack ?? ''}`;
  return /(?:chrome|moz|safari-web|edge)-extension:/.test(where)
    || /^Script error\.?$/.test(detail.message ?? '')
    || /ResizeObserver loop/.test(detail.message ?? '');
}

export function clearViewerLog(): void {
  conditions.clear();
  viewerLog.entries = [];
  viewerLog.activeFaultId = null;
}