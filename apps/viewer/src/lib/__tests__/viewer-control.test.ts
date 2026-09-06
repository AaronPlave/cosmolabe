/**
 * The adapter, driven against a fake renderer.
 *
 * A fake and not a mock of `viewer-state`: the whole point of putting
 * `apps/viewer` in the vitest projects list was to exercise the real rune
 * module. What is faked is the renderer below it, which needs WebGL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execute, parse, FRAME_MODES, LAYERS, VERB_LIST } from '@cosmolabe/control';
import type { Universe } from '@cosmolabe/core';
import { CameraModeName, type UniverseRenderer } from '@cosmolabe/three';
import { createViewerControl } from '../viewer-control';
import {
  DISPLAY_OPTIONS,
  bindRenderer,
  selectBody,
  unbindRenderer,
  vs,
} from '../viewer-state.svelte';

// ── A renderer with no WebGL behind it ──

interface FakeBodyMesh {
  body: { name: string; classification?: string; parentName?: string };
  displayRadius: number;
  position: { x: number; y: number; z: number; clone(): FakeVec; sub(v: FakeVec): FakeVec };
  visible: boolean;
}

interface FakeVec {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): FakeVec;
  copy(v: FakeVec): FakeVec;
  clone(): FakeVec;
  normalize(): FakeVec;
  lengthSq(): number;
}

function vec(x = 0, y = 0, z = 0): FakeVec {
  const v: FakeVec = {
    x,
    y,
    z,
    set(nx, ny, nz) {
      v.x = nx;
      v.y = ny;
      v.z = nz;
      return v;
    },
    copy(o) {
      return v.set(o.x, o.y, o.z);
    },
    clone: () => vec(v.x, v.y, v.z),
    normalize() {
      const l = Math.hypot(v.x, v.y, v.z) || 1;
      return v.set(v.x / l, v.y / l, v.z / l);
    },
    lengthSq: () => v.x * v.x + v.y * v.y + v.z * v.z,
  };
  return v;
}

function makeFakeRenderer(objects: string[]) {
  const calls: string[] = [];
  const log = (s: string) => void calls.push(s);

  const meshes = new Map<string, FakeBodyMesh>(
    objects.map((name) => [
      name,
      {
        body: { name, classification: name === 'Cassini' ? 'spacecraft' : 'planet', parentName: 'Saturn' },
        displayRadius: 2575,
        position: { ...vec(), clone: () => vec(), sub: () => vec() } as unknown as FakeBodyMesh['position'],
        visible: true,
      },
    ]),
  );

  let et = 0;
  let rate = 1;
  let playing = false;
  const listeners = new Set<(et: number) => void>();
  const notify = () => {
    for (const l of listeners) l(et);
  };

  let tracked: FakeBodyMesh | null = null;
  let lookAt: FakeBodyMesh | null = null;
  let mode: CameraModeName = CameraModeName.FREE_ORBIT;
  const viewpoints = new Map<string, { name: string; epoch?: number; trackBody?: string }>([
    ['SOI (2004-07-01)', { name: 'SOI (2004-07-01)', epoch: 141_000_000 }],
  ]);

  const camera = { fov: 60, position: vec(0, 0, 1), up: vec(0, 1, 0), updateProjectionMatrix: () => log('updateProjectionMatrix') };

  const renderer = {
    calls,
    scaleFactor: 1e-6,
    camera,
    timeController: {
      get et() {
        return et;
      },
      get rate() {
        return rate;
      },
      get playing() {
        return playing;
      },
      setTime: (v: number) => {
        log(`setTime(${v})`);
        et = v;
        notify();
      },
      setRate: (v: number) => {
        log(`setRate(${v})`);
        rate = v;
      },
      play: () => {
        log('play');
        playing = true;
      },
      pause: () => {
        log('pause');
        playing = false;
      },
      step: (dt: number) => {
        log(`step(${dt})`);
        et += dt;
        notify();
      },
      onTimeChange: (l: (et: number) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    cameraController: {
      controls: { target: vec() },
      camera,
      get mode() {
        return mode;
      },
      get trackedBody() {
        return tracked;
      },
      get lookAtBody() {
        return lookAt;
      },
      track: (bm: FakeBodyMesh | null) => {
        tracked = bm;
      },
      trackBody: (bm: FakeBodyMesh) => {
        log(`trackBody(${bm.body.name})`);
        tracked = bm;
      },
      stopTracking: () => {
        log('stopTracking');
        tracked = null;
        mode = CameraModeName.FREE_ORBIT;
      },
      lookAt: (bm: FakeBodyMesh | null) => {
        log(`lookAt(${bm?.body.name ?? 'null'})`);
        lookAt = bm;
      },
      clearLookAt: () => {
        lookAt = null;
      },
      flyTo: (bm: FakeBodyMesh) => log(`flyTo(${bm.body.name})`),
      cancelAnimation: () => log('cancelAnimation'),
      setModeForBody: (m: CameraModeName, bm: FakeBodyMesh | null) => {
        log(`setModeForBody(${m}, ${bm?.body.name ?? 'null'})`);
        mode = m;
        return true;
      },
      getViewpoints: () => [...viewpoints.values()],
      getViewpoint: (name: string) => viewpoints.get(name),
      applyViewpoint: () => log('applyViewpoint'),
    },
    applyNamedViewpoint: (name: string) => {
      const vp = viewpoints.get(name);
      if (!vp) return false;
      log(`applyNamedViewpoint(${name})`);
      if (vp.epoch !== undefined) renderer.timeController.setTime(vp.epoch);
      return true;
    },
    getBodyMesh: (name: string) => meshes.get(name),
    getBodyNames: () => [...meshes.keys()],
    setBodyVisible: (name: string, v: boolean) => log(`setBodyVisible(${name}, ${v})`),
    setTrajectoryVisible: (name: string, v: boolean) => log(`setTrajectoryVisible(${name}, ${v})`),
    setLabelVisible: (name: string, v: boolean) => log(`setLabelVisible(${name}, ${v})`),
    setTrajectoriesVisible: (v: boolean) => log(`setTrajectoriesVisible(${v})`),
    setLabelsVisible: (v: boolean) => log(`setLabelsVisible(${v})`),
    showBodyGrid: (v: boolean) => log(`showBodyGrid(${v})`),
    showBodyAxes: (v: boolean) => log(`showBodyAxes(${v})`),
    setSensorsVisible: (v: boolean) => log(`setSensorsVisible(${v})`),
    setSensorLabelsVisible: (v: boolean) => log(`setSensorLabelsVisible(${v})`),
    setLightingMode: (m: string) => log(`setLightingMode(${m})`),
    getContext: () => ({ canvas: { toDataURL: () => 'data:image/png;base64,AAA' }, renderFrame: () => log('renderFrame') }),
    getPlugins: () => [],
  };
  return renderer;
}

type FakeRenderer = ReturnType<typeof makeFakeRenderer>;

const OBJECTS = ['Cassini', 'Titan', 'Enceladus', 'Saturn'];

let renderer: FakeRenderer;

/**
 * Bind a fake renderer.
 *
 * `catalogOnly` names bodies the catalog declares but the renderer gives no
 * mesh — what a `Rings` item is. They land in `vs.bodies` and nowhere else,
 * which is exactly the divergence `listObjects` has to respect.
 */
function bind(objects = OBJECTS, catalogOnly: string[] = []) {
  renderer = makeFakeRenderer(objects);
  const all = [...objects, ...catalogOnly];
  const universe = {
    getTimeRange: () => null,
    getAllBodies: () => all.map((name) => ({ name, classification: undefined, parentName: undefined })),
  } as unknown as Universe;
  bindRenderer(renderer as unknown as UniverseRenderer, universe);
  vs.bodies = all.map((name) => ({ name, visible: true }));
}

beforeEach(() => {
  // `bindRenderer` drives a per-frame tick; node has no rAF, and the callback
  // must not actually loop or the test never finishes.
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  bind();
});

afterEach(() => {
  unbindRenderer();
  selectBody(null);
  vs.note = null;
  vi.unstubAllGlobals();
});

// ── The vocabulary pin ──
//
// `@cosmolabe/control` restates these two lists rather than importing them,
// because it takes no dependency on a renderer or on the app. This is the one
// workspace that can see both sides, so it is where the duplication is checked.

describe('the shared vocabulary', () => {
  it('lists exactly the camera modes the renderer has', () => {
    expect(FRAME_MODES.map((m) => m.id)).toEqual(Object.values(CameraModeName));
  });

  it('lists exactly the display options the viewer implements', () => {
    expect(LAYERS.map((l) => l.id)).toEqual([...DISPLAY_OPTIONS]);
  });
});

describe('every verb is wired', () => {
  it('finds a function for each VerbSpec.method on the real control', () => {
    const control = createViewerControl() as unknown as Record<string, unknown>;
    for (const spec of VERB_LIST) {
      expect(typeof control[spec.method], `${spec.name} → ${String(spec.method)}`).toBe('function');
    }
  });
});

describe('setTime', () => {
  it('resolves through SPICE when it is furnished', () => {
    const str2et = vi.fn(() => 141_000_000);
    const control = createViewerControl({ getSpice: () => ({ str2et }) as never });
    expect(control.setTime({ kind: 'calendar', text: '2004 JUL 01 00:00' })).toBe(true);
    expect(str2et).toHaveBeenCalledWith('2004 JUL 01 00:00');
    expect(renderer.timeController.et).toBe(141_000_000);
  });

  // The `earth-moon` case: no kernel is furnished, so getSpice() is legitimately
  // null. Falling back to core's calendar parse is what keeps `setTime` from
  // doing what BottomBar's go-to-time field does there — silently landing on today.
  it('falls back to the SPICE-free calendar parse when there is none', () => {
    const control = createViewerControl();
    expect(control.setTime({ kind: 'calendar', text: '2024-01-01T00:00:00Z' })).toBe(true);
    // 24 years of seconds plus the leap seconds accrued since J2000, give or take.
    expect(renderer.timeController.et).toBeGreaterThan(7.5e8);
    expect(renderer.timeController.et).toBeLessThan(7.6e8);
  });

  it('takes an ephemeris time as given', () => {
    const control = createViewerControl();
    expect(control.setTime({ kind: 'et', et: 12345 })).toBe(true);
    expect(renderer.timeController.et).toBe(12345);
  });

  it('calls no setter for a time it cannot read', () => {
    const control = createViewerControl();
    const before = renderer.calls.length;
    expect(control.setTime({ kind: 'calendar', text: 'sometime on Tuesday' })).toBe(false);
    expect(renderer.calls.slice(before)).toEqual([]);
  });
});

describe('setFrame', () => {
  // setModeForBody only re-parameterizes the mode. Asking for body-fixed/Titan
  // while still tracking Cassini gives a camera locked to Titan's rotation but
  // orbiting Cassini — plausible-looking, and wrong.
  it('tracks the object before it switches mode', () => {
    const control = createViewerControl();
    control.gotoObject('Cassini');
    renderer.calls.length = 0;
    expect(control.setFrame('body-fixed', 'Titan')).toBe(true);
    expect(renderer.calls).toEqual(['trackBody(Titan)', 'setModeForBody(body-fixed, Titan)']);
  });

  it('refuses an unknown object without switching mode', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    expect(control.setFrame('body-fixed', 'Titam')).toBe(false);
    expect(renderer.calls).toEqual([]);
  });

  it('refuses an unknown mode', () => {
    const control = createViewerControl();
    expect(control.setFrame('body_fixed')).toBe(false);
  });
});

describe('gotoObject', () => {
  it('does not animate unless asked', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    control.gotoObject('Titan');
    expect(renderer.calls).toEqual(['trackBody(Titan)']);
  });

  it('flies when given a duration', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    control.gotoObject('Titan', { seconds: 2 });
    expect(renderer.calls).toEqual(['flyTo(Titan)']);
    // flyTo defers the real tracking; the HUD has to know now.
    expect(vs.trackedBodyName).toBe('Titan');
  });

  it('returns false for an object the scene does not have', () => {
    expect(createViewerControl().gotoObject('Titam')).toBe(false);
  });
});

describe('untrack', () => {
  it('releases the object without resetting the camera', () => {
    const control = createViewerControl();
    control.gotoObject('Titan');
    control.setCamera([100, 200, 300]);
    renderer.calls.length = 0;
    control.untrack();
    expect(renderer.calls).toEqual(['stopTracking']);
    expect(control.getTracked()).toBeNull();
    // Still where setCamera put it, in km.
    expect(control.getCamera().position.map(Math.round)).toEqual([100, 200, 300]);
  });
});

describe('runTo', () => {
  it('advances scene time by exactly the amount asked for', () => {
    const control = createViewerControl();
    control.setTime({ kind: 'et', et: 1000 });
    expect(control.runTo(3600)).toBe(true);
    expect(control.getTime()).toBe(4600);
  });
});

describe('setCamera', () => {
  it('round-trips km through the renderer scale factor', () => {
    const control = createViewerControl();
    control.setCamera([1.4e9, -2, 3], [10, 20, 30], [0, 0, 1]);
    const cam = control.getCamera();
    expect(cam.position[0]).toBeCloseTo(1.4e9, 0);
    expect(cam.position[1]).toBeCloseTo(-2, 6);
    expect(cam.target.map(Math.round)).toEqual([10, 20, 30]);
    expect(cam.up).toEqual([0, 0, 1]);
  });

  it('defaults the target to the scene origin when none is given', () => {
    const control = createViewerControl();
    control.setCamera([1, 2, 3], [4, 5, 6]);
    control.setCamera([1, 2, 3]);
    expect(control.getCamera().target).toEqual([0, 0, 0]);
  });

  // It sets a pose and nothing else. Tracking and look-at keep acting on the
  // camera afterwards, and the contract says so rather than silently clearing
  // them — a script that wants a standalone pose calls untrack/clearLookAt.
  it('leaves tracking and look-at alone', () => {
    const control = createViewerControl();
    control.gotoObject('Titan');
    control.pointAtObject('Enceladus');
    control.setCamera([1, 2, 3], [0, 0, 0]);
    expect(control.getTracked()).toBe('Titan');
    expect(vs.lookAtBodyName).toBe('Enceladus');
  });
});

describe('pointAtObject', () => {
  // `lookAtBody` (the UI path) toggles; the verb must not. "Point at Titan"
  // twice has to leave the camera pointing at Titan, not at nothing.
  it('does not toggle, and clearLookAt releases it', () => {
    const control = createViewerControl();
    expect(control.pointAtObject('Titan')).toBe(true);
    expect(control.pointAtObject('Titan')).toBe(true);
    expect(vs.lookAtBodyName).toBe('Titan');
    control.clearLookAt();
    expect(vs.lookAtBodyName).toBeNull();
  });

  it('refuses an object the scene does not have', () => {
    expect(createViewerControl().pointAtObject('Titam')).toBe(false);
  });
});

describe('listObjects', () => {
  // cassini-soi ships a "Saturn Rings" body: it is in the catalog, so it is in
  // `universe.getAllBodies()`, but `buildScene` gives it no BodyMesh. Listing it
  // would make the "did you mean …?" suggester propose a name that gotoObject,
  // track, showLabel and every other object verb then refuses.
  it('lists only objects the verbs can actually resolve', () => {
    unbindRenderer();
    bind(OBJECTS, ['Saturn Rings']);
    const control = createViewerControl();

    expect(vs.bodies.map((b) => b.name)).toContain('Saturn Rings');
    expect(control.listObjects()).toEqual(OBJECTS);
    expect(control.gotoObject('Saturn Rings')).toBe(false);
  });
});

describe('runTo', () => {
  // Documents the answer rather than leaving it to be discovered: `step` does
  // not touch the play state, so runTo advances the clock and leaves playback
  // exactly as it found it, in either direction.
  it('leaves the play state as it found it', () => {
    const control = createViewerControl();
    control.setPlaying(false);
    control.runTo(60);
    expect(control.isPlaying()).toBe(false);

    control.setPlaying(true);
    control.runTo(60);
    expect(control.isPlaying()).toBe(true);
  });
});

describe('setLayer', () => {
  it('drives the renderer without rewriting the saved preferences', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    expect(control.setLayer('labels', false)).toBe(true);
    expect(renderer.calls).toEqual(['setLabelsVisible(false)']);
    expect(vs.showLabels).toBe(false);
  });

  it('refuses a layer that is not one', () => {
    expect(createViewerControl().setLayer('trajectory', false)).toBe(false);
  });
});

describe('events', () => {
  it('fires on select, and the disposer stops it', () => {
    const control = createViewerControl();
    const seen: (string | null)[] = [];
    const off = control.on('select', ({ name }) => seen.push(name));
    control.select('Titan');
    control.deselect();
    off();
    control.select('Cassini');
    expect(seen).toEqual(['Titan', null]);
  });

  it('fires on time', () => {
    const control = createViewerControl();
    const seen: number[] = [];
    const off = control.on('time', ({ et }) => seen.push(et));
    control.setTime({ kind: 'et', et: 500 });
    off();
    control.setTime({ kind: 'et', et: 900 });
    expect(seen).toEqual([500]);
  });
});

describe('the read side', () => {
  it('reports what the write side just did', () => {
    const control = createViewerControl();
    control.setTimeRate(60);
    control.setPlaying(true);
    control.gotoObject('Titan');
    control.select('Cassini');
    expect(control.getRate()).toBe(60);
    expect(control.isPlaying()).toBe(true);
    expect(control.getTracked()).toBe('Titan');
    expect(control.getSelected()).toBe('Cassini');
    expect(control.listObjects()).toEqual(OBJECTS);
    expect(control.listViewpoints()).toEqual(['SOI (2004-07-01)']);
  });
});

describe('snapshot', () => {
  it('is a script that parses, and replays onto the same state', async () => {
    const control = createViewerControl();
    control.setTime({ kind: 'et', et: 141_000_000 });
    control.setTimeRate(60);
    control.gotoObject('Titan');
    control.setFrame('body-fixed', 'Titan');
    control.setFov(35);
    control.pointAtObject('Enceladus');
    control.setCamera([1000, 2000, 3000], [-10, 20, -30], [0, 0, 1]);
    control.setLayer('labels', false);
    control.select('Cassini');
    control.displayNote('T-A flyby');

    const script = control.snapshot();
    expect(() => parse(script)).not.toThrow();

    const before = control.getCamera();

    // Move everything away, then replay and check it all came back.
    control.setTime({ kind: 'et', et: 0 });
    control.setTimeRate(1);
    control.untrack();
    control.clearLookAt();
    control.setFov(60);
    control.setCamera([0, 0, 1], [0, 0, 0], [0, 1, 0]);
    control.setLayer('labels', true);
    control.deselect();
    control.displayNote('');

    await execute(parse(script), control);

    expect(control.getTracked()).toBe('Titan');
    expect(control.getSelected()).toBe('Cassini');
    expect(control.getRate()).toBe(60);
    expect(vs.showLabels).toBe(false);
    expect(vs.note).toBe('T-A flyby');
    expect(vs.cameraMode).toBe(CameraModeName.BODY_FIXED);
    // The whole camera, not just the FOV: a snapshot that dropped `target`
    // still passed a position-and-fov assertion while losing the aim entirely.
    const after = control.getCamera();
    expect(after.fov).toBe(before.fov);
    expect(after.position.map(Math.round)).toEqual(before.position.map(Math.round));
    expect(after.target.map(Math.round)).toEqual(before.target.map(Math.round));
    expect(after.up).toEqual(before.up);
    expect(vs.lookAtBodyName).toBe('Enceladus');
    // Through the ISO round-trip, so seconds rather than exact ET equality.
    expect(control.getTime()).toBeCloseTo(141_000_000, 0);
  });

  it('omits a timed note, and keeps a persistent one', () => {
    const control = createViewerControl();
    control.displayNote('persistent');
    expect(control.snapshot()).toContain('displayNote persistent');

    control.displayNote('vanishing', 2);
    expect(vs.note).toBe('vanishing');
    expect(control.snapshot()).not.toContain('displayNote');
  });
});

describe('a script end to end', () => {
  it('applies a scene setup and stops on the first bad line', async () => {
    const control = createViewerControl();
    await execute(
      parse(
        [
          'setPlaying off',
          'setTime 2004-10-26T15:30:00Z',
          'gotoObject Titan',
          'setFrame body-fixed Titan',
          'showTrajectory Cassini on',
          'setLayer labels off',
          'displayNote "T-A flyby - Titan body-fixed"',
        ].join('\n'),
      ),
      control,
    );
    expect(control.isPlaying()).toBe(false);
    expect(control.getTracked()).toBe('Titan');
    expect(vs.showLabels).toBe(false);
    expect(vs.note).toBe('T-A flyby - Titan body-fixed');

    await expect(
      execute(parse(['setFov 20', 'gotoObject Titam', 'setFov 90'].join('\n')), control),
    ).rejects.toThrow('line 2: gotoObject: no object named "Titam" (did you mean "Titan"?)');
    expect(control.getCamera().fov).toBe(20);
  });
});
