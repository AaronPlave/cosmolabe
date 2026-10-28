import { afterEach, describe, expect, it } from 'vitest';
import { clearViewerFault, clearViewerLog, dismissViewerFault, recordViewerFault, recordViewerLog, viewerLog } from '../viewer-log.svelte';

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