import { afterEach, describe, expect, it } from 'vitest';
import { faultIdentity, isIncidentalRuntimeError, clearViewerFault, clearViewerLog, dismissViewerFault, recordViewerFault, recordViewerLog, setViewerFault, viewerLog } from '../viewer-log.svelte';

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

  it('keeps an acknowledged continuing fault active, unlogged, until it recovers', () => {
    setViewerFault('Camera frame', 'f|gap A', 'gap A');
    const id = viewerLog.activeFaultId;
    dismissViewerFault();
    setViewerFault('Camera frame', 'f|gap A', 'gap A, later');
    expect(viewerLog.entries).toHaveLength(1);
    expect(viewerLog.activeFaultId).toBe(id);
    expect(viewerLog.acknowledgedId).toBe(id);
    clearViewerFault('Camera frame');
    expect(viewerLog.activeFaultId).toBeNull();
    expect(viewerLog.acknowledgedId).toBeNull();
    expect(viewerLog.entries[0]).toMatchObject({ level: 'info', message: 'Recovered.' });
    clearViewerFault('Camera frame');
    expect(viewerLog.entries).toHaveLength(2);
  });

  it('raises a different failure after an acknowledgement as new', () => {
    setViewerFault('Camera frame', 'f|gap A', 'gap A');
    dismissViewerFault();
    setViewerFault('Camera frame', 'f|no coverage', 'no coverage');
    expect(viewerLog.activeFaultId).not.toBe(viewerLog.acknowledgedId);
  });
});

describe('time-varying fault reasons', () => {
  const ongoing = (reasons: string[]) => {
    for (const reason of reasons) setViewerFault('Camera frame', faultIdentity('IAU_X', reason), reason);
    expect(viewerLog.entries).toHaveLength(1);
    expect(viewerLog.entries[0].message).toBe(reasons.at(-1));
  };

  it('treats one ongoing gap as one fault while the epoch in its text advances', () => {
    ongoing([
      'SPICE(NOFRAMECONNECT): no CK data for -82000 at ET 983836892.4561 (2031 MAR 06 12:00:16.456)',
      'SPICE(NOFRAMECONNECT): no CK data for -82000 at ET 983836893.4561 (2031 MAR 06 12:00:17.456)',
      'SPICE(NOFRAMECONNECT): no CK data for -82000 at ET 9.838368E+08 (2031 MAR 06 12:00:18)',
    ]);
  });

  it('does not log a new fault when the calendar day rolls over (real SPICE text)', () => {
    ongoing([
      'Insufficient ephemeris data has been loaded to compute the state of -159 (EUROPAM) relative to 502 (EUROPA) at the ephemeris epoch 2018 JUL 02 23:59:43.966.',
      'Insufficient ephemeris data has been loaded to compute the state of -159 (EUROPAM) relative to 502 (EUROPA) at the ephemeris epoch 2018 JUL 03 08:22:43.126.',
    ]);
  });

  it('still separates different causes and different bodies', () => {
    expect(faultIdentity('f', 'no CK data for -82000 at ET 1.5')).not.toBe(faultIdentity('f', 'no CK data for -82001 at ET 1.5'));
    expect(faultIdentity('f', 'no CK data at ET 1.5')).not.toBe(faultIdentity('f', 'no SPK data at ET 1.5'));
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
