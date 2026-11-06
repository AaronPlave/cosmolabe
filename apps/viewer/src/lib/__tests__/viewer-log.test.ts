import { afterEach, describe, expect, it } from 'vitest';
import { isIncidentalRuntimeError, clearViewerFault, clearViewerLog, dismissViewerFault, recordViewerFault, recordViewerLog, setViewerFault, viewerLog } from '../viewer-log.svelte';

afterEach(clearViewerLog);

describe('viewer log', () => {
  it('keeps the exact fault message available to the status line and drawer', () => {
    const entry = recordViewerFault('Camera frame', 'Frame spice:LRO_SC_BUS unavailable at ET 123.456: CK gap');
    expect(viewerLog.activeFaultId).toBe(entry.id);
    expect(viewerLog.entries[0]).toMatchObject({ level: 'error', source: 'Camera frame', message: 'Frame spice:LRO_SC_BUS unavailable at ET 123.456: CK gap' });
  });

  it('logs errors without replacing an already active status when requested', () => {
    const active = recordViewerFault('Runtime error', 'first');
    recordViewerLog('error', 'Event search', 'second', { showStatus: false });
    expect(viewerLog.entries.map(entry => entry.message)).toEqual(['second', 'first']);
    expect(viewerLog.activeFaultId).toBe(active.id);
  });

  it('dismisses the status without clearing its log entry', () => {
    const entry = recordViewerFault('Asset load', 'texture unavailable');
    dismissViewerFault();
    expect(viewerLog.activeFaultId).toBeNull();
    expect(viewerLog.entries).toContain(entry);
  });

  it('clears only a recovered fault from the status line and retains history', () => {
    const cameraFault = recordViewerFault('Camera frame', 'frame unavailable');
    recordViewerLog('error', 'Runtime error', 'unrelated', { showStatus: false });
    clearViewerFault('Camera frame');
    expect(viewerLog.activeFaultId).toBeNull();
    expect(viewerLog.entries).toContain(cameraFault);
  });
});
describe('continuing faults', () => {
  it('follows the current failure without logging every frame', () => {
    setViewerFault('Camera frame', 'f|gap A', 'Frame f unavailable at ET 1: gap A');
    setViewerFault('Camera frame', 'f|gap A', 'Frame f unavailable at ET 2: gap A');
    expect(viewerLog.entries).toHaveLength(1);
    expect(viewerLog.entries[0].message).toBe('Frame f unavailable at ET 2: gap A');
  });

  it('logs a different failure on the same frame and shows it', () => {
    setViewerFault('Camera frame', 'f|gap A', 'Frame f unavailable at ET 1: gap A');
    setViewerFault('Camera frame', 'f|no coverage', 'Frame f unavailable at ET 9: no coverage');
    expect(viewerLog.entries).toHaveLength(2);
    expect(viewerLog.entries.find(e => e.id === viewerLog.activeFaultId)?.message).toContain('no coverage');
  });

  it('does not re-log a dismissed fault, and logs recovery', () => {
    setViewerFault('Camera frame', 'f|gap A', 'gap A');
    dismissViewerFault();
    setViewerFault('Camera frame', 'f|gap A', 'gap A, later');
    expect(viewerLog.entries).toHaveLength(1);
    expect(viewerLog.activeFaultId).toBeNull();
    clearViewerFault('Camera frame');
    expect(viewerLog.entries[0]).toMatchObject({ level: 'info', message: 'Recovered.' });
    clearViewerFault('Camera frame');
    expect(viewerLog.entries).toHaveLength(2);
  });
});

describe('incidental runtime errors', () => {
  it('ignores extension, opaque and ResizeObserver noise but not the viewer\'s own errors', () => {
    expect(isIncidentalRuntimeError({ message: 'x', filename: 'chrome-extension://abc/content.js' })).toBe(true);
    expect(isIncidentalRuntimeError({ message: 'Script error.' })).toBe(true);
    expect(isIncidentalRuntimeError({ message: 'ResizeObserver loop completed with undelivered notifications.' })).toBe(true);
    expect(isIncidentalRuntimeError({ message: 'x is undefined', filename: 'http://localhost:5173/src/App.svelte' })).toBe(false);
  });
});
