export type ViewerLogLevel = 'info' | 'warning' | 'error';

export interface ViewerLogEntry {
  id: number;
  timestamp: number;
  level: ViewerLogLevel;
  source: string;
  message: string;
}

const MAX_ENTRIES = 150;
let nextId = 1;

export const viewerLog = $state({
  entries: [] as ViewerLogEntry[],
  activeFaultId: null as number | null,
  open: false,
});

export function recordViewerLog(
  level: ViewerLogLevel,
  source: string,
  message: string,
  options: { showStatus?: boolean } = {},
): ViewerLogEntry {
  const entry: ViewerLogEntry = {
    id: nextId++,
    timestamp: Date.now(),
    level,
    source,
    message: message.trim() || 'No details provided.',
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

export function clearViewerFault(source: string): void {
  const active = viewerLog.entries.find(entry => entry.id === viewerLog.activeFaultId);
  if (active?.source === source) viewerLog.activeFaultId = null;
}

export function clearViewerLog(): void {
  viewerLog.entries = [];
  viewerLog.activeFaultId = null;
}