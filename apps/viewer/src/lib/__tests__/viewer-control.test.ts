/**
 * The adapter, driven against a fake renderer.
 *
 * A fake and not a mock of `viewer-state`: the whole point of putting
 * `apps/viewer` in the vitest projects list was to exercise the real rune
 * module. What is faked is the renderer below it, which needs WebGL.
 */
import { builtInAgentMetadata } from '../ask/public-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentTools, createCapabilityTools, execute, parse, FRAME_MODES, LAYERS, VERB_LIST, type ScriptEventMap } from '@cosmolabe/control';
import { PlaceIndex, parseGeographicGeoJson, parseCoordinatePair, resolveGeographicTarget, type Universe, parseMissionActivities } from '@cosmolabe/core';
import { placeCoordinates, selectPlace } from '../places';
import * as placeActions from '../places';
import * as viewerState from '../viewer-state.svelte';
import { CameraModeName, type UniverseRenderer } from '@cosmolabe/three';
import * as THREE from 'three';
import { selectEvent } from '../event-finder.svelte';
import { activityEvent } from '../mission-activities';
import { createViewerControl } from '../viewer-control';
import { closeTool, isToolOpen } from '../shell.svelte';
import {
  DISPLAY_OPTIONS,
  releaseSurfaceTarget, dismissGeographicContext,
  bindRenderer,
  emit,
  selectBody,
  unbindRenderer,
  vs,
} from '../viewer-state.svelte';

import { readFileSync } from 'node:fs';
const readCatalog = (name: string) => JSON.parse(readFileSync(new URL(`../../../test-catalogs/${name}.json`, import.meta.url), 'utf8'));
const ingenuityCatalog = readCatalog('ingenuity-jezero');
const moonfallCatalog = readCatalog('moonfall-shackleton');
const curiosityCatalog = readCatalog('msl-dingo-gap');

// ── A renderer with no WebGL behind it ──

interface FakeBodyMesh {
  body: { name: string; classification?: string; parentName?: string; geometryData?: Record<string, unknown> };
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
  /** A flight `flyTo` started; it lands only when a test calls `land`. */
  let flight: { id: number; destination: FakeBodyMesh; path: string } | null = null;
  let flightSeq = 0;
  let mode: CameraModeName = CameraModeName.FREE_ORBIT;
  const viewpoints = new Map<string, { name: string; epoch?: number; trackBody?: string; position?: THREE.Vector3; target?: THREE.Vector3; up?: THREE.Vector3 }>([
    ['SOI (2004-07-01)', { name: 'SOI (2004-07-01)', epoch: 141_000_000, position: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(0,1,0) }],
  ]);

  const camera = { fov: 60, position: vec(0, 0, 1), up: vec(0, 1, 0), updateProjectionMatrix: () => log('updateProjectionMatrix') };

  const renderer = {
    calls,
    scaleFactor: 1e-6,
    setHoveredBody: vi.fn(),
    setLabelPinned: vi.fn(),
    setEventResults: vi.fn(),
    setEventPreview: vi.fn(),
    setOccultationGeometry: vi.fn(),
    camera,
    // The production renderer emits initial-asset progress and readiness here.
    // This control-layer fake has no asynchronous assets, but it must expose
    // the same subscription surface so binding it follows the production path.
    events: {
      on: vi.fn((_event: string, _listener: (payload: unknown) => void) => () => {}),
    },
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
      /** The body a body-fixed frame rides on; tests that need one set it. */
      originBody: null as unknown,
      get mode() {
        return mode;
      },
      get trackedBody() {
        return tracked;
      },
      get focusBody() {
        return flight?.destination ?? tracked;
      },
      get flight() {
        return flight ? { ...flight, phase: 'approach' } : null;
      },
      /** Land the flight in progress, as the next frames would. */
      land: () => {
        if (flight) tracked = flight.destination;
        flight = null;
      },
      get lookAtBody() {
        return lookAt;
      },
      track: (bm: FakeBodyMesh | null) => {
        tracked = bm;
      },
      focus: (bm: FakeBodyMesh) => {
        log(`focus(${bm.body.name})`);
        flight = null;
        tracked = bm;
      },
      frame: (bm: FakeBodyMesh) => {
        log(`frame(${bm.body.name})`);
        flight = null;
        tracked = bm;
      },
      stopFlight: () => {
        log('stopFlight');
        if (!flight) return false;
        tracked = flight.destination;
        flight = null;
        return true;
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
      flyTo: (bm: FakeBodyMesh, opts: { path: string; duration?: number }) => {
        log(`flyTo(${bm.body.name}, ${opts.path}, ${opts.duration})`);
        tracked = null;
        flight = { id: ++flightSeq, destination: bm, path: opts.path };
      },
      cancelAnimation: () => log('cancelAnimation'),
      syncModeFromCamera: (t: number) => log(`syncModeFromCamera(${t})`),
      dolly: (distance: number, duration?: number) => {
        log(`dolly(${distance}, ${duration})`);
        return mode !== CameraModeName.LVLH;
      },
      crane: (distance: number, duration?: number) => {
        log(`crane(${distance}, ${duration})`);
        // As the real controller does in free orbit: let go of the tracked object.
        if (mode === CameraModeName.FREE_ORBIT) tracked = null;
        return mode !== CameraModeName.LVLH;
      },
      orbitTarget: (axis: 'up' | 'right', radians: number, duration?: number) => {
        log(`orbitTarget(${axis}, ${radians.toFixed(4)}, ${duration})`);
        return mode !== CameraModeName.LVLH;
      },
      setModeForBody: (m: CameraModeName, bm: FakeBodyMesh | null) => {
        log(`setModeForBody(${m}, ${bm?.body.name ?? 'null'})`);
        mode = m;
        return true;
      },
      syncOrbitTargetFromCamera: () => {},
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
    /** What the next frame would do to a body; tests that need it replace this. */
    refreshBodyPose: (name: string) => {
      log(`refreshBodyPose(${name})`);
      return true;
    },
    getBodyNames: () => [...meshes.keys()],
    setBodyVisible: (name: string, v: boolean) => log(`setBodyVisible(${name}, ${v})`),
    setTrajectoryVisible: (name: string, v: boolean) => log(`setTrajectoryVisible(${name}, ${v})`),
    setLabelVisible: (name: string, v: boolean) => log(`setLabelVisible(${name}, ${v})`),
    setTrajectoriesVisible: (v: boolean) => log(`setTrajectoriesVisible(${v})`),
    setLabelsVisible: (v: boolean) => log(`setLabelsVisible(${v})`),
    setGridSettings: () => {},
    showBodyGrid: (v: boolean) => log(`showBodyGrid(${v})`),
    showBodyAxes: (v: boolean) => log(`showBodyAxes(${v})`),
    setSensorsVisible: (v: boolean) => log(`setSensorsVisible(${v})`),
    setSensorLabelsVisible: (v: boolean) => log(`setSensorLabelsVisible(${v})`),
    setLightingMode: (m: string) => log(`setLightingMode(${m})`),
    // Point Probe: bound on every scene, not a script verb.
    placeNames: { selectedRef: null as string | null },
    geographicVectors: { setSelected: vi.fn(), setSourceEnabled: () => {} },
    setPointProbeActive: () => {},
    setProbePin: () => {},
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
    viewpoints: [{ name: 'SOI (2004-07-01)' }],
    geographicLayers: { layers: [], loads: [] },
    events: { on: () => () => {} },
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

it('validates scripted grid opacity and preserves saved display preferences', () => {
  const previous = vs.grid, setItem = vi.fn();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem });
  try {
    const control = createViewerControl();
    expect(control.setGridOpacity!(0.37)).toBe(true);
    expect(vs.grid.opacity).toBe(0.37);
    expect(control.snapshot()).toContain('setGridOpacity 0.37');
    for (const value of [-1, 2, Infinity, NaN]) expect(control.setGridOpacity!(value)).toBe(false);
    expect(vs.grid.opacity).toBe(0.37);
    expect(setItem).not.toHaveBeenCalled();
    expect(control.setGridOpacity!(0)).toBe(true);
    expect(vs.grid.opacity).toBe(0);
  } finally { vs.grid = previous; }
});

describe('circleCenter', () => {
  // Right and left swing about the view's up vector, up and down about its
  // right axis; the sign is the way the camera moves on screen.
  it('maps each direction onto an axis and a signed angle in radians', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    expect(control.circleCenter('right', 90)).toBe(true);
    expect(control.circleCenter('left', 90)).toBe(true);
    expect(control.circleCenter('up', 180, { seconds: 5 })).toBe(true);
    expect(control.circleCenter('down', 180, { seconds: 5 })).toBe(true);
    expect(renderer.calls).toEqual([
      'orbitTarget(up, 1.5708, undefined)',
      'orbitTarget(up, -1.5708, undefined)',
      'orbitTarget(right, 3.1416, 5)',
      'orbitTarget(right, -3.1416, 5)',
    ]);
  });

  it('refuses a non-finite angle or a negative duration without moving anything', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    expect(control.circleCenter('right', Number.NaN)).toBe(false);
    expect(control.circleCenter('right', 90, { seconds: -1 })).toBe(false);
    expect(renderer.calls).toEqual([]);
  });

  it('passes on the refusal of a frame that owns the view', () => {
    const control = createViewerControl();
    control.setFrame('lvlh', 'Cassini');
    expect(control.circleCenter('right', 90)).toBe(false);
  });

  it('runs as text under Cosmographia\'s names', async () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    await execute(parse('circleCenterRight 360 5\ncircleCenterDown 30'), control);
    expect(renderer.calls).toEqual(['orbitTarget(up, 6.2832, 5)', 'orbitTarget(right, -0.5236, undefined)']);
  });
});

describe('dolly and crane', () => {
  it('pass km through the scale factor, with the duration as given', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    expect(control.dolly(10000, { seconds: 3 })).toBe(true);
    expect(control.crane(-2000)).toBe(true);
    expect(renderer.calls).toEqual(['dolly(0.01, 3)', 'crane(-0.002, undefined)']);
  });

  it('refuse a non-finite distance without moving anything', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    expect(control.dolly(Number.POSITIVE_INFINITY)).toBe(false);
    expect(control.crane(10, { seconds: Number.NaN })).toBe(false);
    expect(renderer.calls).toEqual([]);
  });

  // A free-orbit crane lets go of the tracked object; the read side and the
  // HUD must hear it, or a snapshot would re-track and undo the crane.
  it('report the tracking a free-orbit crane released', () => {
    const control = createViewerControl();
    control.gotoObject('Titan');
    control.crane(500);
    expect(control.getTracked()).toBeNull();
    expect(vs.trackedBodyName).toBeNull();
  });

  it('run as text', async () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    await execute(parse('dolly 10000 3\ncrane 2000 2'), control);
    expect(renderer.calls).toEqual(['dolly(0.01, 3)', 'crane(0.002, 2)']);
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
    expect(renderer.calls).toEqual(['refreshBodyPose(Titan)', 'frame(Titan)', 'setModeForBody(body-fixed, Titan)']);
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
    expect(renderer.calls).toEqual(['refreshBodyPose(Titan)', 'frame(Titan)']);
  });

  it('flies directly when given a duration', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    control.gotoObject('Titan', { seconds: 2 });
    expect(renderer.calls).toEqual(['refreshBodyPose(Titan)', 'flyTo(Titan, direct, 2)']);
    // flyTo defers the real tracking; the HUD has to know now.
    expect(vs.trackedBodyName).toBe('Titan');
  });

  it('returns false for an object the scene does not have', () => {
    expect(createViewerControl().gotoObject('Titam')).toBe(false);
  });
});

// ── The navigation vocabulary (docs/navigation.md) ──
//
// Each verb is one call on the controller, and none implies another: selecting
// never moves the camera, and moving it never selects.

/** The renderer calls that move or re-anchor the camera. */
const cameraCalls = () =>
  renderer.calls.filter((c) => /^(focus|frame|flyTo|stopFlight|stopTracking|setModeForBody)\(?/.test(c));

describe('navigation verbs', () => {
  it('select changes the selection and never the camera', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    expect(control.select('Titan')).toBe(true);
    expect(control.getSelected()).toBe('Titan');
    expect(cameraCalls()).toEqual([]);
    expect(control.getTracked()).toBeNull();
  });

  it('track focuses without framing, and does not select', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    expect(control.track('Titan')).toBe(true);
    expect(renderer.calls).toEqual(['refreshBodyPose(Titan)', 'focus(Titan)']);
    expect(control.getTracked()).toBe('Titan');
    expect(vs.trackedBodyName).toBe('Titan');
    expect(control.getSelected()).toBeNull();
  });

  it('routes geographic double-click to shared Fly and clears place selection on another body', () => {
    const layer=parseGeographicGeoJson(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',id:'a',properties:{name:'Site',placeKind:'nomenclature'},geometry:{type:'Point',coordinates:[-120.12345678,-30.12345678]}}]}),
      {id:'sites',name:'Sites',body:'Titan',source:'sites.json',coordinates:{latitude:'planetographic',longitudeDirection:'east',longitudeDomain:'-180..180',referenceShape:{kind:'sphere',radiusKm:2575}}},{kind:'local-file',identity:'sites.json'});
    vs.places=new PlaceIndex([layer]);const place=vs.places.places[0];
    const fly=vi.spyOn(placeActions,'navigateToPlace').mockReturnValue(true);
    const doubleClick=renderer.events.on.mock.calls.find(([event])=>event==='geographic:dblclick')![1];
    doubleClick({layerId:place.layer.id,featureId:place.feature.id,bodyName:place.layer.body});
    expect(fly).toHaveBeenCalledExactlyOnceWith(place,'fly',{source:'viewport-dblclick'});
    doubleClick({layerId:place.layer.id,featureId:'stale',bodyName:place.layer.body});
    // A click on a named place is Places' selection alone: Surface layers lets go of the point.
    const click=renderer.events.on.mock.calls.find(([event])=>event==='geographic:click')![1];
    click({layerId:place.layer.id,featureId:place.feature.id,bodyName:place.layer.body});
    expect(vs.selectedPlaceRef).toBe(place.ref);expect(renderer.geographicVectors.setSelected).toHaveBeenLastCalledWith(null);
    expect(fly).toHaveBeenCalledTimes(1);fly.mockRestore();
    selectPlace(place);const control=createViewerControl();control.track('Titan');
    expect(vs.selectedPlaceRef).toBe(place.ref);expect(renderer.placeNames.selectedRef).toBe(place.ref);
    expect(parseCoordinatePair(placeCoordinates(place))).toMatchObject({ok:true,latDeg:-30.12345678,lonDeg:-120.12345678});
    control.track('Saturn');expect(vs.selectedPlaceRef).toBeNull();expect(renderer.placeNames.selectedRef).toBeNull();
  });

  it('keeps label hiding searchable but excludes disabled sources and reconciles selection/target', () => {
    const definition={id:'sites',name:'Sites',body:'Titan',source:'sites.json',coordinates:{latitude:'planetocentric' as const,longitudeDirection:'east' as const,longitudeDomain:'-180..180' as const,referenceShape:{kind:'sphere' as const,radiusKm:2575}}};
    const layer=parseGeographicGeoJson(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',id:'a',properties:{name:'Site'},geometry:{type:'Point',coordinates:[0,0]}}]}),definition,{kind:'local-file',identity:'sites.json'});
    const second={...layer,id:'second',features:layer.features.map(f=>({...f,id:'b',properties:{name:'Other'}}))};
    vs.places=new PlaceIndex([layer,second]);const place=vs.places.places[0];
    Object.assign(renderer.placeNames,{hiddenLayers:new Set<string>()});
    placeActions.showPlaceDataset(layer.id,false);
    expect(placeActions.searchPlaces('Site')).toHaveLength(1);
    selectPlace(place);
    vs.surfaceTarget={bodyName:'Titan',coordinates:'0 N, 0 E',convention:'planetographic',surface:'reference',notes:[],label:{wide:{lat:'0 N',lon:'0 E'},narrow:{lat:'0 N',lon:'0 E'}},place:{ref:place.ref,name:place.name}};
    Object.assign(renderer.cameraController,{releaseSurface:vi.fn(()=>true)});
    placeActions.setPlaceSourceEnabled([layer.id],false);
    expect(placeActions.searchPlaces('Site')).toEqual([]);expect(placeActions.searchPlaces('Other')).toHaveLength(1);
    expect(vs.selectedPlaceRef).toBeNull();expect(vs.surfaceTarget).toBeNull();
    placeActions.selectPlace(place);expect(vs.selectedPlaceRef).toBeNull();
    expect(placeActions.navigateToPlace(place,'jump')).toBe(false);
    placeActions.setPlaceSourceEnabled([layer.id],true);
    expect(placeActions.searchPlaces('Site')).toHaveLength(1);expect(vs.hiddenPlaceLayers).toContain(layer.id);
    unbindRenderer();expect(vs.excludedPlaceLayers).toEqual([]);
  });

  it('distinguishes excluded sources from hidden labels and body-wide label visibility', () => {
    const definition={id:'sites',name:'Sites',body:'Titan',source:'sites.json',coordinates:{latitude:'planetocentric' as const,longitudeDirection:'east' as const,longitudeDomain:'-180..180' as const,referenceShape:{kind:'sphere' as const,radiusKm:2575}}};
    const layer=parseGeographicGeoJson(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',id:'a',properties:{name:'Site'},geometry:{type:'Point',coordinates:[0,0]}}]}),definition,{kind:'local-file',identity:'sites.json'});
    const second={...layer,id:'second',features:layer.features.map(f=>({...f,id:'b',properties:{name:'Other'}}))};
    vs.places=new PlaceIndex([layer,second]);vs.placeBodies=['Titan'];
    expect(placeActions.placeSourceStatus()).toBe('');
    vs.hiddenPlaceLayers=[layer.id,second.id];
    expect(placeActions.placeSourceStatus()).toBe('Geographic labels hidden; names remain searchable');expect(placeActions.searchPlaces('')).toHaveLength(2);
    vs.excludedPlaceLayers=[layer.id,second.id];
    expect(placeActions.placeSourceStatus()).toBe('No name sources included');expect(placeActions.searchPlaces('')).toHaveLength(0);
    vs.excludedPlaceLayers=[layer.id];
    expect(placeActions.placeSourceStatus()).toBe('Geographic labels hidden; names remain searchable');expect(placeActions.searchPlaces('')).toHaveLength(1);
    vs.hiddenPlaceLayers=[layer.id];expect(placeActions.placeSourceStatus()).toBe('');
    vs.placeBodies=[];expect(placeActions.placeSourceStatus()).toBe('Geographic labels hidden; names remain searchable');
    vs.excludedPlaceLayers=[];vs.placeBodies=['Titan'];vs.hiddenPlaceLayers=[];
    expect(placeActions.placeSourceStatus()).toBe('');expect(placeActions.searchPlaces('')).toHaveLength(2);
  });

  it.each([false,true])('releases an active named target, preserving independent inspection=%s', independent => {
    const layer=parseGeographicGeoJson(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',id:'a',properties:{name:'Target'},geometry:{type:'Point',coordinates:[0,0]}}]}),
      {id:'sites',name:'Sites',body:'Titan',source:'sites.json',coordinates:{latitude:'planetographic',longitudeDirection:'east',longitudeDomain:'-180..180',referenceShape:{kind:'sphere',radiusKm:2575}}},{kind:'local-file',identity:'sites.json'});
    const place=new PlaceIndex([layer]).places[0];vs.places=new PlaceIndex([layer]);
    selectPlace(place);
    vs.surfaceTarget={bodyName:'Titan',coordinates:'0 N, 0 E',convention:'planetographic',surface:'reference',notes:[],label:{wide:{lat:'0 N',lon:'0 E'},narrow:{lat:'0 N',lon:'0 E'}},place:{ref:place.ref,name:place.name}};
    if(independent) {vs.selectedPlaceRef='independent';renderer.placeNames.selectedRef='independent';}
    else {selectPlace(null);expect(renderer.placeNames.selectedRef).toBe(place.ref);}
    const release=vi.fn(()=>true);Object.assign(renderer.cameraController,{releaseSurface:release});
    const before={position:{...renderer.camera.position},time:vs.et,tracked:vs.trackedBodyName};
    expect(releaseSurfaceTarget()).toBe(true);expect(release).toHaveBeenCalledOnce();expect(vs.surfaceTarget).toBeNull();
    expect(renderer.camera.position).toEqual(before.position);expect(vs.et).toBe(before.time);expect(vs.trackedBodyName).toBe(before.tracked);
    expect(vs.selectedPlaceRef).toBe(independent?'independent':null);expect(renderer.placeNames.selectedRef).toBe(independent?'independent':null);
    if(independent) {expect(dismissGeographicContext()).toBe(true);expect(vs.selectedPlaceRef).toBeNull();}
    expect(dismissGeographicContext()).toBe(false);
  });
  it('clears target presentation and place inspection when the scene unbinds', () => {
    vs.surfaceTarget={bodyName:'Titan',coordinates:'0 N, 0 E',convention:'planetographic',surface:'reference',notes:[],label:{wide:{lat:'0 N',lon:'0 E'},narrow:{lat:'0 N',lon:'0 E'}}};
    vs.selectedPlaceRef='old';unbindRenderer();expect(vs.surfaceTarget).toBeNull();expect(vs.selectedPlaceRef).toBeNull();
  });

  it('converts copied oblate-place latitude to the coordinate input convention', () => {
    const layer=parseGeographicGeoJson(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',id:'a',properties:{name:'Oblate site'},geometry:{type:'Point',coordinates:[77,30]}}]}),
      {id:'sites',name:'Sites',body:'Titan',source:'sites.json',coordinates:{latitude:'planetographic',longitudeDirection:'east',longitudeDomain:'-180..180',referenceShape:{kind:'ellipsoid',radiiKm:[2,2,1]}}},{kind:'local-file',identity:'sites.json'});
    const place=new PlaceIndex([layer]).places[0];
    const copied=parseCoordinatePair(placeCoordinates(place),{order:'lon-lat',direction:'west'});
    if(!copied.ok)throw new Error(copied.error);
    expect(copied.latDeg).toBeLessThan(30);
    const target=resolveGeographicTarget({bodyName:'Titan',latDeg:copied.latDeg,lonDeg:copied.lonDeg,latitude:'planetocentric',longitudeDirection:'west'},
      {bodyName:'Titan',shape:'oblate',datum:{...layer.datum,origin:'body-shape'}});
    expect(target.latGraphicDeg).toBeCloseTo(30,6);expect(target.lonEastDeg).toBeCloseTo(77,6);
  });

  it('frameObject frames what is tracked when not told what, and refuses with nothing tracked', () => {
    const control = createViewerControl();
    expect(control.frameObject()).toBe(false);
    control.track('Titan');
    renderer.calls.length = 0;
    expect(control.frameObject()).toBe(true);
    expect(renderer.calls).toEqual(['refreshBodyPose(Titan)', 'frame(Titan)']);
    expect(control.frameObject('Titam')).toBe(false);
  });

  it('jumpTo cuts to the pose a flight would land on', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    expect(control.jumpTo('Enceladus')).toBe(true);
    expect(cameraCalls()).toEqual(['frame(Enceladus)']);
    expect(control.getFlight()).toBeNull();
  });

  it('flyTo takes the direct path unless told otherwise, and reports the flight', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    expect(control.flyTo('Titan')).toBe(true);
    expect(control.flyTo('Enceladus', { path: 'overview', seconds: 3 })).toBe(true);
    expect(cameraCalls()).toEqual(['flyTo(Titan, direct, undefined)', 'flyTo(Enceladus, overview, 3)']);
    expect(control.getFlight()).toEqual({ id: expect.any(Number), target: 'Enceladus', path: 'overview' });
    expect(vs.flight).toEqual({ target: 'Enceladus', path: 'overview' });
    // The HUD names the destination for the length of the flight.
    expect(vs.trackedBodyName).toBe('Enceladus');
    // Not tracked yet: that happens when it lands.
    expect(control.getTracked()).toBeNull();
  });

  it('flyTo of no duration is a jump, and a negative one is refused', () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    expect(control.flyTo('Titan', { seconds: 0 })).toBe(true);
    expect(cameraCalls()).toEqual(['frame(Titan)']);
    expect(control.flyTo('Titan', { seconds: -1 })).toBe(false);
  });

  it('stopFlight ends the flight tracking its destination', () => {
    const control = createViewerControl();
    control.flyTo('Titan');
    control.stopFlight();
    expect(control.getFlight()).toBeNull();
    expect(vs.flight).toBeNull();
    expect(control.getTracked()).toBe('Titan');
    // With nothing flying it does nothing.
    renderer.calls.length = 0;
    control.stopFlight();
    expect(control.getTracked()).toBe('Titan');
  });

  it('reads a landing off the controller at once, not on the next animation frame', () => {
    const control = createViewerControl();
    control.flyTo('Titan');
    (renderer.cameraController as unknown as { land(): void }).land();
    expect(control.getFlight()).toBeNull();
    expect(control.getTracked()).toBe('Titan');
  });

  it('runs as text', async () => {
    const control = createViewerControl();
    renderer.calls.length = 0;
    await execute(parse('track Titan\nframeObject\nflyTo Enceladus direct 2\nstopFlight\njumpTo Saturn'), control);
    expect(cameraCalls()).toEqual([
      'focus(Titan)',
      'frame(Titan)',
      'flyTo(Enceladus, direct, 2)',
      'stopFlight',
      'frame(Saturn)',
    ]);
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

describe('setCamera in a body-fixed frame', () => {
  /** A body at the origin whose prime meridian (+X) points along world +Y. */
  function enterBodyFixed() {
    const control = createViewerControl();
    const cc = renderer.cameraController as unknown as {
      originBody: unknown;
      camera: { position: THREE.Vector3; up: THREE.Vector3 };
      controls: { target: THREE.Vector3 };
    };
    // Real vectors: the body-frame transform rotates them.
    cc.camera.position = new THREE.Vector3();
    cc.camera.up = new THREE.Vector3(0, 1, 0);
    cc.controls.target = new THREE.Vector3();
    const toWorld = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    cc.originBody = {
      body: { name: 'Titan' },
      position: new THREE.Vector3(),
      bodyToWorldQuaternion: (out: THREE.Quaternion) => out.copy(toWorld),
    };
    expect(control.setFrame('body-fixed', 'Titan')).toBe(true);
    return { control, cc };
  }

  // Cosmographia's moveToPov takes body-fixed vectors (#152). A pose over the
  // prime meridian has to land over the prime meridian however the body has
  // turned, not at a fixed world direction.
  it("takes the body's own axes", () => {
    const { control, cc } = enterBodyFixed();
    control.setCamera([1000, 0, 0], [0, 0, 0], [0, 0, 1]);
    const sf = renderer.scaleFactor;
    expect(cc.camera.position.x).toBeCloseTo(0, 9);
    expect(cc.camera.position.y).toBeCloseTo(1000 * sf, 9);
    expect(cc.camera.up.z).toBeCloseTo(1, 9);
  });

  // Between frames the body's pose describes the frame already drawn. Right
  // after the origin moves to it — `gotoObject` then `setCamera` in one script,
  // which is what every snapshot replay is — its position is still in the old
  // origin's coordinates. The conversion has to use where the next frame will
  // put it.
  it('converts against the body as the next frame will have it, not the last', () => {
    const { control, cc } = enterBodyFixed();
    const origin = cc.originBody as { position: THREE.Vector3 };
    origin.position.set(-384400 * renderer.scaleFactor, 0, 0); // stale: the old origin's coordinates
    const refreshed: string[] = [];
    renderer.refreshBodyPose = (name: string) => {
      refreshed.push(name);
      origin.position.set(0, 0, 0);
      return true;
    };
    control.setCamera([1000, 0, 0], [0, 0, 0], [0, 0, 1]);
    expect(refreshed).toContain('Titan');
    // And the co-rotating mode re-baselines on that orientation, at the clock's time.
    expect(renderer.calls).toContain(`syncModeFromCamera(${renderer.timeController.et})`);
    expect(cc.camera.position.x).toBeCloseTo(0, 9);
    expect(cc.camera.position.y).toBeCloseTo(1000 * renderer.scaleFactor, 9);
  });

  it('reads the pose back in the same axes, so a snapshot replays it', () => {
    const { control } = enterBodyFixed();
    control.setCamera([1000, -200, 300], [0, 0, 50], [0, 0, 1]);
    const cam = control.getCamera();
    expect(cam.position.map((v) => Math.round(v))).toEqual([1000, -200, 300]);
    expect(cam.target.map((v) => Math.round(v))).toEqual([0, 0, 50]);
    expect(cam.up.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 1]);
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

  it('tells a host its own seeks from the viewer\'s, and does not re-seek to where it is', () => {
    const host = createViewerControl({ host: true });
    const seen: ScriptEventMap['time'][] = [];
    const off = host.on('time', (e) => seen.push(e));
    host.setTime({ kind: 'et', et: 500 });
    host.setTime({ kind: 'et', et: 500 });
    createViewerControl().setTime({ kind: 'et', et: 600 });
    off();
    expect(seen).toEqual([{ et: 500, cause: 'host' }, { et: 600, cause: 'viewer' }]);
    expect(renderer.calls.filter((c) => c === 'setTime(500)')).toHaveLength(1);
  });

  it('coalesces playback to a few notifications, ending on the clock', () => {
    vi.useFakeTimers();
    try {
      const control = createViewerControl({ host: true });
      const seen: ScriptEventMap['time'][] = [];
      const off = control.on('time', (e) => seen.push(e));
      renderer.timeController.play();
      for (let frame = 0; frame < 30; frame++) {
        renderer.timeController.step(1);
        vi.advanceTimersByTime(16);
      }
      vi.advanceTimersByTime(300);
      off();
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen.length).toBeLessThanOrEqual(3);
      expect(seen.every((e) => e.cause === 'playback')).toBe(true);
      expect(seen.at(-1)!.et).toBe(renderer.timeController.et);
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifies playback changes once each', () => {
    const control = createViewerControl({ host: true });
    const seen: ScriptEventMap['playback'][] = [];
    const rate = control.getRate();
    const off = control.on('playback', (e) => seen.push(e));
    control.setPlaying(true);
    control.setPlaying(true);
    control.setTimeRate(120);
    off();
    expect(seen).toEqual([{ playing: true, rate }, { playing: true, rate: 120 }]);
  });

  it('notifies activity selection, and drops it when the record goes rather than reselecting a later namesake', () => {
    const records = parseMissionActivities(ingenuityCatalog.activities);
    vs.activities = records;
    const control = createViewerControl({ host: true });
    const seen: (string | null)[] = [];
    const off = control.on('activitySelect', ({ id }) => seen.push(id));
    expect(control.selectActivity!(records[0].id)).toBe(true);
    vs.activities = records.slice(1);
    emit('activities', vs.activities.length);
    expect(control.getSelectedActivity!()).toBeUndefined();
    vs.activities = records;
    emit('activities', vs.activities.length);
    expect(control.getSelectedActivity!()).toBeUndefined();
    off();
    expect(seen).toEqual([records[0].id, null]);
  });

  it('subscriptions outlive a catalog load', () => {
    const control = createViewerControl({ host: true });
    const seen: (string | null)[] = [];
    const off = control.on('select', ({ name }) => seen.push(name));
    unbindRenderer();
    bind();
    control.select('Titan');
    off();
    expect(seen).toEqual(['Titan']);
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


describe('shared activity host and script operations', () => {
  it('clears prior event highlights and synchronizes the scene without changing time or camera', () => {
    vs.activities = parseMissionActivities(ingenuityCatalog.activities);
    selectEvent({id:'geometry', queryId:'geometry-query', kind:'closest-approach', temporality:'instant', et:42,
      label:'Approach', bodies:{observer:'Cassini', target:'Titan'}});
    expect(vs.highlightedBodies).toEqual(['Cassini', 'Titan']);
    const time = renderer.timeController.et;
    const selectedBody = vs.selectedBodyName;
    const calls = [...renderer.calls];
    renderer.setEventResults.mockClear();
    const host = createViewerControl();
    expect(host.selectActivity!(vs.activities[0].id)).toBe(true);
    expect(vs.highlightedBodies).toEqual([]);
    expect(renderer.setLabelPinned).toHaveBeenCalledWith('Cassini', false);
    expect(renderer.setLabelPinned).toHaveBeenCalledWith('Titan', false);
    expect(renderer.setHoveredBody).toHaveBeenLastCalledWith(null);
    expect(renderer.setEventResults).toHaveBeenCalled();
    expect(renderer.timeController.et).toBe(time);
    expect(vs.selectedBodyName).toBe(selectedBody);
    expect(renderer.calls).toEqual(calls);
  });
  it.each([['Ingenuity', ingenuityCatalog, 72], ['MoonFall', moonfallCatalog, 24], ['Curiosity', curiosityCatalog, 2]] as const)('reads and navigates real %s metadata independently of trajectories', async (_name, catalog, count) => {
    vs.activities = parseMissionActivities(catalog.activities);
    const host = createViewerControl();
    expect(host.listActivities!()).toHaveLength(count);
    const a = host.listActivities!()[0];
    const epoch = renderer.timeController.et;
    const calls = renderer.calls.length;
    expect(host.selectActivity!(a.id)).toBe(true);
    expect(host.getSelectedActivity!()?.id).toBe(a.id);
    expect(renderer.timeController.et).toBe(epoch);
    expect(renderer.calls.length).toBe(calls);
    await execute(parse(`seekActivity "${a.id}" end`), host);
    expect(renderer.timeController.et).toBe(a.end);
    await execute(parse(`selectActivity "${a.id}"`), host);
    expect(host.getActivity!(a.id)?.provenance.source).toBe(a.provenance.source);
    const selectedBody = vs.selectedBodyName;
    selectEvent(activityEvent(vs.activities[0]));
    expect(vs.selectedBodyName).toBe(selectedBody);
    expect(host.getSelectedActivity!()?.id).toBe(a.id);
    expect(host.listActivities!({ vehicle: a.vehicle, kind: a.kind }).every(x => x.vehicle === a.vehicle)).toBe(true);
    // Caller mutations cannot corrupt the catalog snapshot.
    (host.getActivity!(a.id) as { name: string }).name = 'mutated';
    expect(host.getActivity!(a.id)?.name).toBe(a.name);
    unbindRenderer();
    expect(host.listActivities!()).toEqual([]);
    expect(host.selectActivity!(a.id)).toBe(false);
    expect(host.seekActivity!(a.id)).toBe(false);
    await expect(execute(parse(`seekActivity "${a.id}"`), host)).rejects.toThrow(/no activity/);
  });
  it('filters concurrent vehicles, handles ties/instant milestones and preserves the selected ID across playback', () => {
    const source = parseMissionActivities(moonfallCatalog.activities);
    const first = source[0];
    vs.activities = parseMissionActivities([
      { ...first, timeSystem: 'ET', id: 'a', kind: 'flight', vehicle: 'Aircraft' },
      { ...first, timeSystem: 'ET', id: 'b', kind: 'drive', vehicle: 'Rover' },
      { ...first, timeSystem: 'ET', id: 'c', kind: 'landing', temporality: 'instant', start: first.end, end: first.end },
    ]);
    const host = createViewerControl();
    host.selectActivity!('a');
    expect(host.navigateActivity!('next')).toBe(true);
    expect(host.getSelectedActivity!()?.id).toBe('b');
    expect(host.navigateActivity!('next', { vehicle: 'Aircraft' })).toBe(true);
    expect(host.getSelectedActivity!()?.id).toBe('a');
    host.selectActivity!('c'); host.seekActivity!('c', 'end');
    expect(renderer.timeController.et).toBe(first.end);
    host.setTimeRate(-1); host.setPlaying(true);
    expect(host.getSelectedActivity!()?.id).toBe('c');
    expect(host.navigateActivity!('next', { vehicle: 'missing' })).toBe(false);
    vs.activities = vs.activities.map(a => a.id === 'c' ? { ...a, enabled: false } : a);
    expect(host.selectActivity!('c')).toBe(false);
    expect(host.seekActivity!('c')).toBe(false);
    const before = renderer.timeController.et;
    expect(host.seekActivity!('stale')).toBe(false);
    expect(renderer.timeController.et).toBe(before);
  });
});

describe('scene identity, places, imagery and flight ends (#297)', () => {
  const sites = (ids: string[], body = 'Titan') => parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features: ids.map((id, i) => ({
    type: 'Feature', id, properties: { name: `Kraken ${id}`, placeKind: 'nomenclature', diameterKm: 100 * (i + 1) }, geometry: { type: 'Point', coordinates: [10 * i, 20] } })) }),
  { id: 'names', name: 'Names', body, source: 'names.json', coordinates: { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 2575 } } },
  { kind: 'catalog', identity: 'https://example.test/names.json', revision: 'r1' });

  it('gives every bound scene a new id, a reload of the same catalog included', () => {
    const control = createViewerControl();
    const first = control.getScene();
    expect(first).toMatchObject({ ready: false });
    bind();
    expect(control.getScene()!.id).toBe(first!.id + 1);
    unbindRenderer();
    expect(control.getScene()).toBeNull();
  });

  it('searches places as plain data with stable refs, provenance and coordinates', () => {
    vs.places = new PlaceIndex([sites(['a', 'b'])]);
    const control = createViewerControl();
    // Ranked by extent: the larger first, then cut to the limit.
    const found = control.searchPlaces('krak', { limit: 1 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ref: '["names","string:b"]', name: 'Kraken b', body: 'Titan', layer: { id: 'names', name: 'Names' }, feature: 'string:b',
      origin: 'nomenclature', diameterKm: 200, source: { kind: 'catalog' }, unavailable: null,
    });
    expect(found[0].latitude).toBeCloseTo(20, 9);
    expect(found[0].longitude).toBeCloseTo(10, 9);
    expect(control.searchPlaces('krak').map((p) => p.name)).toEqual(['Kraken b', 'Kraken a']);
    expect(control.searchPlaces('krak', { body: 'Saturn' })).toEqual([]);
    expect(control.getPlace('["names","string:a"]')?.name).toBe('Kraken a');
    expect(control.getPlace('Kraken a')).toBeUndefined();
  });

  it('resolves exact body/layer/feature identity, reports ambiguity and unlinked sources without navigation', () => {
    const a = sites(['a']), b = { ...sites(['a']), id: 'second' };
    vs.places = new PlaceIndex([a, b]);
    const control = createViewerControl();
    expect(control.resolvePlace!({ body: 'Titan', feature: 'string:a' }).status).toBe('ambiguous');
    expect(control.resolvePlace!({ body: 'Titan', layer: 'names', feature: 'string:a' }).status).toBe('available');
    expect(control.resolvePlace!({ body: 'wrong', feature: 'string:a' }).status).toBe('missing');
    vs.excludedPlaceLayers = ['names'];
    expect(control.resolvePlace!({ body: 'Titan', layer: 'names', feature: 'string:a' }).status).toBe('unlinked');
    expect(() => control.resolvePlace!({ body: 'Titan', feature: 'string:a' }, { scene: -1 })).toThrow('scene changed');
  });

  it.each(['https://example.test/private-token/names.json?signature=secret', '/Users/alice/private/names.json', 'file:///private/names.json'])('preserves rich source locations in trusted local control reads: %s', (identity) => {
    const layer = sites(['a']);
    layer.source.identity = identity;
    layer.source.revision = 'private-revision';
    vs.places = new PlaceIndex([layer]);
    const control = createViewerControl();
    const [place] = control.searchPlaces('krak');
    selectPlace(vs.places.byRef.get(place.ref)!, { reveal: false });
    for (const result of [place, control.getPlace(place.ref), control.getSelectedPlace()]) {
      expect(result?.source).toEqual({ kind: 'catalog', identity, revision: 'private-revision' });
    }
  });

  it('does not search, or navigate to, a source the person excluded', () => {
    vs.places = new PlaceIndex([sites(['a'])]);
    vs.excludedPlaceLayers = ['names'];
    const control = createViewerControl();
    expect(control.searchPlaces('kraken')).toEqual([]);
    expect(control.getPlace('["names","string:a"]')?.unavailable).toMatch(/excluded/);
    expect(() => control.gotoPlace('["names","string:a"]')).toThrow(/excluded/);
    vs.excludedPlaceLayers = [];
    expect(control.gotoPlace('["names","zzz"]')).toBe(false);
  });

  it('navigates to a place by the control path, flying by default', () => {
    vs.places = new PlaceIndex([sites(['a'])]);
    const go = vi.spyOn(placeActions, 'navigateToPlaceForControl').mockReturnValue({ ok: true });
    const control = createViewerControl();
    const ref = '["names","string:a"]';
    expect(control.gotoPlace(ref)).toBe(true);
    expect(control.gotoPlace(ref, { animate: false, view: 'oblique' })).toBe(true);
    expect(go.mock.calls.map(([p, o]) => [p.ref, o])).toEqual([
      [ref, { animate: true, view: undefined }],
      [ref, { animate: false, view: 'oblique' }],
    ]);
    go.mockReturnValue({ ok: false, error: 'Target is outside the surface' });
    expect(() => control.gotoPlace(ref)).toThrow('Target is outside the surface');
    go.mockRestore();
  });

  it('refuses a command read from a scene that is no longer bound, even when the new scene reuses its ref', () => {
    const ref = '["names","string:a"]';
    vs.places = new PlaceIndex([sites(['a'], 'Titan')]);
    const go = vi.spyOn(placeActions, 'navigateToPlaceForControl').mockReturnValue({ ok: true });
    const control = createViewerControl();
    const read = control.getScene()!.id;
    expect(control.gotoPlace(ref, { scene: read })).toBe(true);
    // The catalog is replaced by one with the same layer and feature ids.
    bind();
    vs.places = new PlaceIndex([sites(['a'], 'Enceladus')]);
    go.mockClear();
    expect(() => control.gotoPlace(ref, { scene: read })).toThrow(/scene changed since this was read/);
    expect(go).not.toHaveBeenCalled();
    // Layers and activities are guarded the same way.
    expect(() => control.setImageryVisible('Titan', 'x', true, { scene: read })).toThrow(/scene changed/);
    expect(() => control.setImageryOpacity('Titan', 'x', 0.5, { scene: read })).toThrow(/scene changed/);
    expect(() => control.selectActivity('a', { scene: read })).toThrow(/scene changed/);
    expect(() => control.seekActivity('a', 'start', { scene: read })).toThrow(/scene changed/);
    // Read again from the new scene, the same ref goes through; with no scene given nothing is checked.
    expect(control.gotoPlace(ref, { scene: control.getScene()!.id })).toBe(true);
    expect(control.gotoPlace(ref)).toBe(true);
    go.mockRestore();
  });

  it('keeps Flight 5 selected through seeking it and going to its site, and gives the place its source fields', () => {
    const layer = parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [{
      type: 'Feature', id: 'airfield-5',
      properties: { name: 'Airfield B', placeKind: 'mission-site', sourceFields: { origin: 'NASA/JPL MMGIS Ingenuity waypoint', Flight: 5, Earth_Date: 'May 7, 2021', nested: { no: 1 }, list: [1] } },
      geometry: { type: 'Point', coordinates: [77.4513883, 18.44266513] } }] }),
    { id: 'ingenuity-sites', name: 'Ingenuity sites', body: 'Titan', source: 'ingenuity-sites.geojson', coordinates: { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 2575 } } },
    { kind: 'catalog', identity: 'places/ingenuity-sites.geojson' });
    vs.places = new PlaceIndex([layer]);
    vs.activities = parseMissionActivities(ingenuityCatalog.activities);
    const go = vi.spyOn(placeActions, 'navigateToPlaceForControl').mockReturnValue({ ok: true });
    const control = createViewerControl();
    const flight5 = control.getActivity('ingenuity:flight:5')!;
    // The record states its site by name, and points at no place.
    expect(flight5).toMatchObject({ site: 'Airfield B', references: { trajectory: 'Ingenuity' } });
    expect(flight5.references?.location).toBeUndefined();
    const [place] = control.searchPlaces('Airfield B');
    // The source's own attributes, flat and primitive; nothing nested comes through.
    expect(place.fields).toEqual({ origin: 'NASA/JPL MMGIS Ingenuity waypoint', Flight: 5, Earth_Date: 'May 7, 2021' });
    const scene = control.getScene()!.id;

    expect(control.selectActivity('ingenuity:flight:5', { scene })).toBe(true);
    expect(control.seekActivity('ingenuity:flight:5', 'start', { scene })).toBe(true);
    expect(control.gotoPlace(place.ref, { animate: false, scene })).toBe(true);
    // None of the three clears the activity selection or moves the clock off the flight's start.
    expect(control.getSelectedActivity()?.id).toBe('ingenuity:flight:5');
    expect(renderer.timeController.et).toBe(flight5.start);
    go.mockRestore();
  });

  it('selects a place for a script without opening the Navigate panel', () => {
    vs.places = new PlaceIndex([sites(['a'])]);
    const place = vs.places.places[0];
    closeTool('navigate');
    selectPlace(place, { reveal: false });
    expect(vs.selectedPlaceRef).toBe(place.ref);
    expect(isToolOpen('navigate')).toBe(false);
    expect(createViewerControl().getSelectedPlace()?.ref).toBe(place.ref);
    selectPlace(place);
    expect(isToolOpen('navigate')).toBe(true);
    closeTool('navigate');
  });

  it('discovers and reconciles two domains through the real ViewerControl adapter', async () => {
    bind();
    Object.assign(renderer.getBodyMesh('Titan')!, { imageryLayers: [], surfaceTransitionState: 'fallback', hasTerrain: false });
    const control = createViewerControl();
    const tools = createCapabilityTools(control);
    const task = tools.begin();
    expect(tools.list()).toHaveLength(5);
    expect(await task.call('listCapabilities', { domain: 'surface' })).toMatchObject({ ok: true, data: { items: expect.arrayContaining([expect.objectContaining({ id: 'surface.getSurfaceData', available: true })]) } });
    await task.call('describeCapabilities', { ids: ['scene.select', 'time.setTime', 'surface.showImagery', 'surface.getSurfaceData'] });
    expect(await task.call('select', { object: 'Titan' })).toMatchObject({ ok: true, receipt: { status: 'completed', resolvedTarget: { object: 'Titan' } } });
    expect(await task.call('setTime', { when: 1234 })).toMatchObject({ ok: true, receipt: { status: 'completed', observation: { state: { time: { et: 1234 } } } } });
    expect(await task.call('showImagery', { object: 'Titan', layer: 'missing', visible: true })).toMatchObject({ ok: false, receipt: { status: 'refused' } });
    expect(await task.call('describeScene', {})).toMatchObject({ ok: true, data: { selectedObject: 'Titan', time: { et: 1234 } } });
    expect(await task.call('getSurfaceData', { object: 'Titan' })).toMatchObject({ ok: true, receipt: { status: 'completed' } });
    expect(control.getSelected()).toBe('Titan');
    expect(control.getTime()).toBe(1234);
    tools.dispose();
  });

  it('inventories real MoonFall products even without managed overlays or runtime data', async () => {
    bind();
    const mesh = renderer.getBodyMesh('Titan')!;
    const moon = moonfallCatalog.items.find((item: { name: string }) => item.name === 'Moon');
    Object.assign(mesh.body, { geometryData: moon.geometry, rotation: { bodyFixedFrame: moon.rotationModel.bodyFrame } });
    Object.assign(mesh, { imageryLayers: [], surfaceTransitionState: 'fallback', hasTerrain: true });
    Object.defineProperty(mesh, 'terrainMetrics', { get() { throw new Error('surface read must not calculate memory'); }, configurable: true });
    const control = createViewerControl();
    const data = control.getSurfaceData('Titan')!;
    expect(data).toMatchObject({
      bodyFrame: 'MOON_ME_DE421', surface: 'fallback', overlays: [],
      terrain: { endpoint: 'data/moon-terrain-cube/tileset.json', frame: 'MOON_ME_DE421',
        source: { id: expect.stringContaining('moon-lola-118m'), revision: null },
        datum: { verticalDatum: 'reference-sphere', heightConvention: 'radial' },
        resolutionMeters: null, runtime: { ready: true, loaded: null, coversView: null } },
      cubeImagery: { endpoint: 'data/moon-imagery-cube-wac-nac/imagery.json', source: { revision: null }, runtime: { ready: null, loaded: null, coversView: null } },
    });
    expect(data.textures.map(t => t.kind)).toEqual(['baseMap', 'normalMap', 'displacementMap']);
    expect(data.textures.every(t => t.runtime.loaded === null && t.source.id === null)).toBe(true);
    const tools = createAgentTools(control);
    expect(await tools.call('getSurfaceData', { object: 'Titan' })).toMatchObject({ ok: true, data: { body: data.body, terrain: { kind: 'terrain', runtime: data.terrain!.runtime } } });
    expect(JSON.stringify(await tools.call('getSurfaceData', { object: 'Titan' }))).not.toContain('endpoint');
    expect(await tools.call('getImagery', { object: 'Titan' })).toMatchObject({ ok: true, summary: expect.stringContaining('no independently managed overlays') });
    expect(await tools.call('getSurfaceData', {})).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await tools.call('getSurfaceData', { object: 'Nowhere' })).toMatchObject({ ok: false, code: 'refused' });
    expect(control.getSurfaceData('Nowhere')).toBeUndefined();

    // The built-in policy preserves exact public science metadata, never endpoints.
    const manifest = JSON.parse(readFileSync(new URL('./fixtures/moonfall-imagery-source.json', import.meta.url), 'utf8'));
    Object.assign(mesh, { terrainCubeImageryMetadata: manifest,
      terrainSourceMetadata: { ...moon.geometry.terrain.sourceMetadata, version: 'cube-fused-79895697c6b6-g3-m12-b6747ec9d' } });
    const publicTools = createAgentTools(control, { metadata: builtInAgentMetadata });
    const wire = JSON.stringify(await publicTools.call('getSurfaceData', { object: 'Titan' }));
    expect(wire).toContain('moon-lola-118m+south-pole-lola-10m-residual');
    expect(wire).toContain('LRO LROC WAC global mosaic');
    expect(wire).toContain('LRO LROC NAC South Pole');
    expect(wire).toContain('reference-sphere');
    expect(wire).toContain('radial');
    expect(wire).not.toContain('endpoint');
    Object.assign(mesh, { terrainSourceMetadata: { id: 'https://internal.example/PATH_SECRET', version: 'PRIVATE_REVISION' },
      terrainCubeImageryMetadata: { ...manifest, source: { ...manifest.source, id: '/Users/private/catalog', attribution: 'PRIVATE_ATTRIBUTION' } } });
    const privateWire = JSON.stringify(await publicTools.call('getSurfaceData', { object: 'Titan' }));
    expect(privateWire).not.toMatch(/PATH_SECRET|PRIVATE_|Users\/private|endpoint/);
    publicTools.dispose();
    Object.assign(mesh, { terrainSourceMetadata: undefined, terrainCubeImageryMetadata: undefined });

    // Failed requests do not erase configuration or imply complete coverage.
    Object.assign(mesh, { terrainSurfaceStatus: { tiles: { inCache: 3, loaded: 0, cpu: 0, drawn: 0 }, network: { failed: 3 } },
      terrainCubeImageryStats: { ready: false, textures: 0, failures: 1, tiles: 0, version: null, baseUncoveredBlocks: 0 } });
    expect(control.getSurfaceData('Titan')).toMatchObject({
      terrain: { configured: true, runtime: { loaded: false, failedRequests: 3, drawn: false, coversView: null } },
      cubeImagery: { configured: true, runtime: { ready: false, loaded: false, failedRequests: 1, drawn: false, coversView: null } },
    });
    Object.assign(mesh, { surfaceTransitionState: 'streamed',
      terrainCubeImageryStats: { ready: true, textures: 6, failures: 1, tiles: 2, version: 'test-revision', baseUncoveredBlocks: 1 } });
    expect(control.getSurfaceData('Titan')!.cubeImagery).toMatchObject({ source: { revision: 'test-revision' }, runtime: { ready: true, loaded: true, drawn: true, coversView: null, coversDrawnTiles: false } });
    mesh.visible = false;
    expect(control.getSurfaceData('Titan')!.cubeImagery!.runtime).toMatchObject({ drawn: false, coversDrawnTiles: null });
    // Snapshot data is independent of the next frame's state.
    expect(data.cubeImagery!.runtime.loaded).toBeNull();
    mesh.body.geometryData = { baseMap: 'https://user:secret@example.test/map.jpg?token=secret#private', terrain: { url: '//user:secret@example.test/tiles?key=secret' } };
    expect(JSON.stringify(control.getSurfaceData('Titan'))).not.toContain('secret');
  });

  it('reads a body\'s imagery and toggles it, keeping the base on', () => {
    const layers = [
      { id: 'base', name: 'Base', attribution: 'USGS', description: null, role: 'base', optional: false, visible: true, opacity: 1, bounds: null,
        resolutionMeters: 100, source: { type: 'xyz', endpoint: 'https://tiles.example', layer: null, tileMatrixSet: null }, status: 'ok', minZoom: 0, view: { inCoverage: true, zoomLevel: 4, missingTiles: 0, degradedTiles: 0, cacheFull: false } },
      { id: 'hirise', name: 'HiRISE', attribution: 'UA', description: 'HiRISE ortho', role: 'overlay', optional: true, visible: false, opacity: 1,
        bounds: [77, 18, 78, 19], resolutionMeters: 0.25, source: { type: 'wmts-capabilities', endpoint: 'https://gibs.example', layer: 'HiRISE_ortho', tileMatrixSet: '1m' }, status: 'idle', minZoom: 12, view: null },
    ];
    Object.assign(renderer.getBodyMesh('Titan')!, {
      imageryLayers: layers, surfaceTransitionState: 'streamed', isImageryOnlySurface: false,
      setImageryLayerVisible: (id: string, v: boolean) => { const l = layers.find((x) => x.id === id)!; if (l.visible === v || !l.optional) return false; l.visible = v; return true; },
      setImageryLayerOpacity: (id: string, o: number) => { layers.find((x) => x.id === id)!.opacity = o; return true; },
    });
    Object.assign(renderer.getBodyMesh('Saturn')!, { imageryLayers: [], surfaceTransitionState: null, isImageryOnlySurface: false });
    const control = createViewerControl();
    const imagery = control.getImagery('Titan')!;
    expect(imagery).toMatchObject({ body: 'Titan', surface: 'streamed', imageryOnly: false });
    expect(imagery.layers[0].view).toEqual({ inCoverage: true, zoomLevel: 4, minZoom: 0, missingTiles: 0, degradedTiles: 0, cacheFull: false });
    expect(imagery.layers[1]).toMatchObject({ id: 'hirise', attribution: 'UA', description: 'HiRISE ortho', bounds: [77, 18, 78, 19], resolutionMeters: 0.25, view: null,
      source: { type: 'wmts-capabilities', endpoint: 'https://gibs.example', layer: 'HiRISE_ortho', tileMatrixSet: '1m' } });
    expect(control.setImageryVisible('Titan', 'hirise', true)).toBe(true);
    // Already on is where it was asked to be, not a refusal.
    expect(control.setImageryVisible('Titan', 'hirise', true)).toBe(true);
    expect(control.setImageryVisible('Titan', 'base', false)).toBe(false);
    expect(control.setImageryVisible('Titan', 'nope', true)).toBe(false);
    expect(control.setImageryOpacity('Titan', 'hirise', 0.4)).toBe(true);
    expect(control.setImageryOpacity('Titan', 'hirise', 1.4)).toBe(false);
    expect(control.getImagery('Titan')!.layers[1]).toMatchObject({ visible: true, opacity: 0.4 });
    expect(control.getImagery('Saturn')).toEqual({ body: 'Saturn', surface: null, imageryOnly: false, layers: [] });
    expect(control.getImagery('Nowhere')).toBeUndefined();
  });

  it('relays manual camera input and detaches it with the renderer', () => {
    const control = createViewerControl();
    const seen = vi.fn();
    const off = control.on('cameraInput', seen);
    const cc = renderer.cameraController as unknown as { onCameraInput: (() => void) | null };
    cc.onCameraInput!();
    expect(seen).toHaveBeenCalledWith({});
    off();
    cc.onCameraInput!();
    expect(seen).toHaveBeenCalledOnce();
    unbindRenderer();
    expect(cc.onCameraInput).toBeNull();
  });

  it('relays how a flight ended, by destination name', () => {
    const control = createViewerControl();
    const seen: ScriptEventMap['flightEnd'][] = [];
    const off = control.on('flightEnd', (end) => seen.push(end));
    const cc = renderer.cameraController as unknown as { onFlightEnd: ((f: unknown, o: string) => void) | null };
    cc.onFlightEnd!({ id: 7, destination: renderer.getBodyMesh('Titan'), path: 'direct', phase: 'approach' }, 'interrupted');
    cc.onFlightEnd!({ id: 8, destination: null, path: 'direct', phase: 'approach' }, 'arrived');
    off();
    cc.onFlightEnd!({ id: 9, destination: null, path: 'direct', phase: 'approach' }, 'stopped');
    expect(seen).toEqual([
      { id: 7, target: 'Titan', path: 'direct', outcome: 'interrupted' },
      { id: 8, target: null, path: 'direct', outcome: 'arrived' },
    ]);
    unbindRenderer();
    expect(cc.onFlightEnd).toBeNull();
  });
});


describe('shared place framing with real catalog records', () => {
  it('frames Airfield B locally and Jezero by its diameter, preserving their geometry', () => {
    const places = (name: string) => {
      const cfg = readCatalog(`places/${name}`);
      const layer = cfg.geographicLayers[0];
      return parseGeographicGeoJson(readFileSync(new URL(`../../../test-catalogs/places/${layer.source}`, import.meta.url), 'utf8'),
        { ...layer, coordinates: cfg.geographicCoordinates }, { kind: 'catalog', identity: layer.source });
    };
    vs.places = new PlaceIndex([places('ingenuity-sites'), places('mars')]);
    const site = vs.places.search('Airfield B')[0];
    const crater = vs.places.search('Jezero').find(p => p.name === 'Jezero')!;
    expect(site.diameterKm).toBeUndefined();
    expect(crater.diameterKm).toBeGreaterThan(40);
    const before = JSON.stringify([site.feature.geometry, crater.feature.geometry]);
    const go = vi.spyOn(viewerState, 'goToCoordinates').mockReturnValue({ ok: true } as any);
    for (const view of ['overhead', 'oblique'] as const) {
      expect(placeActions.navigateToPlaceForControl(site, { animate: false, view }).ok).toBe(true);
      expect(go.mock.calls.at(-1)?.[1]).toMatchObject({ preset: view, rangeKm: 0.5 });
      expect(placeActions.navigateToPlaceForControl(crater, { animate: false, view }).ok).toBe(true);
      expect(go.mock.calls.at(-1)?.[1]?.rangeKm).toBeCloseTo(crater.diameterKm! * 1.5);
    }
    expect(placeActions.navigateToPlace(site, 'jump')).toBe(true);
    expect(go.mock.calls.at(-1)?.[1]?.rangeKm).toBe(0.5);
    expect(placeActions.navigateToPlaceForControl(site, { animate: false, view: 'surface' }).ok).toBe(true);
    expect(go.mock.calls.at(-1)?.[1]?.rangeKm).toBeUndefined();
    expect(JSON.stringify([site.feature.geometry, crater.feature.geometry])).toBe(before);
    go.mockRestore();
  });
});


it('snapshots the controller frame even before the UI mode mirror updates', () => {
  const control = createViewerControl();
  control.setFrame('body-fixed', 'Titan');
  vs.cameraMode = CameraModeName.FREE_ORBIT;
  expect(parse(control.snapshot()).statements.find(s => s.verb === 'setFrame')?.args[0]).toBe('body-fixed');
});

describe('reviewed modern feature adapters', () => {
  it('scopes result references to a computed batch and refuses stale seeks after reruns, edits, kernel replacement and reload', async () => {
    const model = await import('../analysis.svelte');
    const host = createViewerControl();
    const item = model.createConfiguredEventQuery({ kind: 'closest-approach', bodies: { observer: 'Cassini', target: 'Titan' }, window: { start: 100, end: 200 }, step: 10 }, 'Approach', 'explicit');
    const event = { id: 'result-0', queryId: item.id, kind: 'closest-approach', temporality: 'instant' as const, et: 150, label: 'Approach', bodies: { observer: 'Cassini', target: 'Titan' } };
    expect(host.getEventResultPage!(item.id).status).toBe('not-searched');
    model.setEventResults(item.id, [event]);
    const first = host.getEventResultPage!(item.id).items[0].reference;
    const before = host.getTime();
    expect(host.focusEventResult!(first, 'inspect')).toMatchObject({ status: 'partial', observation: { et: before, selected: first, timeline: { selectedInVisibleLane: true } } });
    const next = { ...event, et: 175 };
    model.setEventResults(item.id, [next]);
    expect(host.focusEventResult!(first, 'start').status).toBe('stale-result');
    expect(host.getTime()).toBe(before);
    const second = host.getEventResultPage!(item.id).items[0].reference;
    expect(second.revision).not.toBe(first.revision);
    const aborted = new AbortController(); aborted.abort();
    expect(host.focusEventResult!(second, 'start', { signal: aborted.signal }).status).toBe('cancelled');
    expect(host.getTime()).toBe(before);
    expect(host.focusEventResult!(second, 'start')).toMatchObject({ status: 'partial', observation: { et: 175, selectedObject: 'Titan', highlightedBodies: ['Cassini', 'Titan'] } });
    host.setTime({ kind: 'et', et: 180 }); // Later manual/host time ownership is not reasserted.
    await Promise.resolve(); expect(host.getTime()).toBe(180);
    model.updateConfiguredEventQuery(item.id, { ...item.query, step: 20 }, 'Edited');
    expect(host.getEventResultPage!(item.id).status).toBe('stale-result');
    expect(host.focusEventResult!(second, 'start').status).toBe('stale-result');
    model.setEventResults(item.id, [event]);
    const third = host.getEventResultPage!(item.id).items[0].reference;
    viewerState.setKernelCount(vs.kernelCount); // Same count can be a different kernel set.
    expect(host.focusEventResult!(third, 'start').status).toBe('stale-result');
    expect(host.focusEventResult!({ ...third, scene: -1 }, 'start').status).toBe('scene-reloaded');
    expect(host.getEventResultPage!(item.id, { scene: -1 }).status).toBe('scene-reloaded');
    expect(host.getTime()).toBe(180);
  });

  it('reports empty, unavailable, missing, hidden and unobserved states without manufacturing geometry or portable result identity', async () => {
    const model = await import('../analysis.svelte');
    const host = createViewerControl();
    const item = model.createConfiguredEventQuery({ kind: 'closest-approach', bodies: { observer: 'Cassini', target: 'Titan' }, window: { start: 100, end: 200 } }, 'Approach', 'explicit');
    expect(host.getEventQueryInfo!(item.id)).toMatchObject({ status: 'unavailable', error: { code: 'unavailable' }, provenance: { source: 'loaded-spice-kernels', timeUnit: 'ET seconds past J2000' } });
    expect(host.getEventQueryInfo!('missing').status).toBe('missing-query');
    model.setEventResults(item.id, []);
    expect(host.getEventResultPage!(item.id)).toMatchObject({ status: 'no-results', total: 0, items: [] });
    model.setEventResults(item.id, [{ id: 'result-0', queryId: item.id, kind: 'closest-approach', temporality: 'instant', et: 150, label: 'Approach', bodies: { observer: 'Cassini', target: 'Titan' } }]);
    const ref = host.getEventResultPage!(item.id, { limit: 1 }).items[0].reference;
    model.setConfiguredItemVisible(item.id, false);
    expect(host.focusEventResult!(ref)).toMatchObject({ status: 'partial', observation: { renderer: null, timeline: { selectedInResults: true, selectedInVisibleLane: false } } });
    expect(host.focusEventResult!({ ...ref, id: 'missing' }).status).toBe('missing-result');
    expect(host.focusEventResult!({ ...ref, query: 'missing' }).status).toBe('missing-query');
    expect(() => host.getEventResultPage!(item.id, { limit: 101 })).toThrow('Invalid result page');
    const snapshot = host.snapshot();
    expect(snapshot).toContain('Computed event selection is not replayed');
    expect(parse(snapshot).statements.some(s => s.verb === 'upsertEventQuery')).toBe(true);
    expect(parse(snapshot).statements.some(s => s.verb === 'focusEventResult' || s.verb === 'selectEventResult')).toBe(false);
    expect(snapshot).not.toContain('"revision"');
    model.setConfiguredItemEnabled(item.id, false);
    expect(host.focusEventResult!(ref).status).toBe('unavailable');
  });

  it('shares event definitions with the UI, invalidates results, reports no kernels and keeps exact query/result identity', async () => {
    const { analysis, updateConfiguredEventQuery, setEventResults } = await import('../analysis.svelte');
    const host = createViewerControl();
    const events = vi.fn(); const off = host.on('events', events);
    const definition = { id: 'script-search', label: 'Distance', enabled: true, visible: true,
      query: { id: 'script-search', kind: 'closest-approach', bodies: { observer: 'Cassini', target: 'Titan' }, window: { start: 100, end: 200 }, step: 10, abcorr: 'NONE' } };
    const universe = viewerState.getSceneUniverse()!;
    Object.assign(universe, { getBody: (name: string) => renderer.getBodyMesh(name)?.body });
    expect(() => host.upsertEventQuery!({ ...definition, id: '__proto__' })).toThrow('Invalid');
    expect(host.upsertEventQuery!(definition)).toBe(true);
    expect(host.listEventQueries!()).toMatchObject([{ id: 'script-search' }]);
    const finder = await import('../event-finder.svelte');
    expect(finder.searchAbcorr(finder.currentKind())).toBe('NONE');
    updateConfiguredEventQuery('script-search', { ...definition.query, step: 20 }, 'UI edit');
    expect(host.listEventQueries!()[0].label).toBe('UI edit'); expect(events).toHaveBeenCalled();
    setEventResults('script-search', [{ id: 'shared-id', queryId: 'script-search', kind: 'closest-approach', temporality: 'instant', et: 150, label: 'Result', bodies: definition.query.bodies }]);
    expect(host.selectEventResult!('wrong-query', 'shared-id')).toBe(false);
    expect(host.selectEventResult!('script-search', 'shared-id', 'inspect')).toBe(true);
    expect(host.getEventSearch!().selected).toEqual({ query: 'script-search', id: 'shared-id' });
    host.upsertEventQuery!(definition);
    expect(host.listEventResults!('script-search').items).toEqual([]);
    expect(await host.runEventQuery!('script-search')).toMatchObject({ status: 'failed', error: { code: 'unavailable' } });
    expect(() => host.upsertEventQuery!({ ...definition, query: { ...definition.query, bodies: { observer: 'wrong-catalog', target: 'Titan' } } })).toThrow('unavailable');
    expect(() => host.removeEventQuery!('script-search', { scene: -1 })).toThrow('scene changed');
    expect(host.removeEventQuery!('script-search')).toBe(true); expect(analysis.items).toEqual([]);
    off();
  });

  it('bounds search waits and removes abort/reload/disposal subscriptions', async () => {
    const finder = await import('../event-finder.svelte');
    const model = await import('../analysis.svelte');
    const host = createViewerControl();
    model.createConfiguredEventQuery({ kind: 'closest-approach' }, 'pending', 'explicit', 'pending');
    const run = vi.spyOn(finder, 'runSearch').mockImplementation(() => {
      finder.recordEventSearchOutcome('pending', finder.eventSearchGeneration(), 'running');
      return new Promise(() => {});
    });
    const cancel = vi.spyOn(finder, 'cancelSearch').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = host.runEventQuery!('pending', { signal: controller.signal });
      controller.abort(); expect((await pending).status).toBe('cancelled');
      expect(host.getEventSearch!().status).toBe('cancelled');
      await Promise.resolve(); expect(host.getEventSearch!().status).toBe('cancelled');
      const timed = host.runEventQuery!('pending', { timeoutMs: 5 });
      await vi.advanceTimersByTimeAsync(5); expect((await timed).status).toBe('timed-out');
      expect(host.getEventSearch!().status).toBe('timed-out');
      const older = host.runEventQuery!('pending', { timeoutMs: 5 });
      const replacement = new AbortController();
      const newer = host.runEventQuery!('pending', { signal: replacement.signal });
      expect(host.getEventSearch!().status).toBe('running');
      await vi.advanceTimersByTimeAsync(5); expect((await older).status).toBe('timed-out');
      expect(host.getEventSearch!().status).toBe('running');
      replacement.abort(); await newer;
      expect(host.getEventSearch!().status).toBe('cancelled');
      const stale = host.runEventQuery!('pending'); emit('unload', {});
      expect((await stale).status).toBe('stale');
      expect(host.getEventSearch!()).toMatchObject({ query: null, status: 'idle' });
      expect(finder.ef.searchOutcomes).toEqual({});
      expect(vi.getTimerCount()).toBe(0); expect(cancel).toHaveBeenCalled();
    } finally { vi.useRealTimers(); run.mockRestore(); cancel.mockRestore(); }
  });

  it('uses the same instrument selection and reports authority without inventing observations', () => {
    const host = createViewerControl();
    Object.assign(renderer, { getSensorNames: () => ['Camera'], setInstrumentView: vi.fn(), getInstrumentViewInfo: () => ({ sensor: 'Camera', spacecraft: 'Cassini', target: 'Titan', fov: null, viewFov: [1,1], pointing: 'unavailable', pointingUnavailable: 'No attitude', imageRect: null }) });
    expect(host.listInstruments!()).toEqual(['Camera']);
    expect(host.selectInstrument!('wrong')).toBe(false);
    expect(host.selectInstrument!('Camera')).toBe(true);
    expect(host.getInstrument!()).toMatchObject({ pointing: 'unavailable', fov: null, observation: 'synthetic-scene-view' });
    expect(host.getInstrument!()).not.toHaveProperty('imageRect');
    expect(() => host.selectInstrument!('Camera', { scene: -1 })).toThrow('scene changed');
  });

  it('replays imagery stack order through the manager and publishes shared UI/host changes', async () => {
    const host = createViewerControl(); const { moveImageryLayer } = await import('../appearance-control');
    const layers = [{ id: 'base', optional: false, visible: true, opacity: 1 }, { id: 'a', optional: true, visible: true, opacity: 1 }, { id: 'b', optional: true, visible: true, opacity: 1 }];
    Object.assign(renderer.getBodyMesh('Titan')!, { imageryLayers: layers, moveImageryLayer: (id: string, index: number) => { const from = layers.findIndex(l => l.id === id); layers.splice(index, 0, ...layers.splice(from, 1)); return true; }, setImageryLayerVisible: () => true, setImageryLayerOpacity: () => true });
    const event = vi.fn(); const off = host.on('surface', event);
    const snapshot = host.snapshot();
    moveImageryLayer('Titan', 'a', 2); expect(layers.map(l => l.id)).toEqual(['base', 'b', 'a']); expect(event).toHaveBeenCalled();
    expect(host.moveImageryLayer!('Titan', 'base', 1)).toBe(false);
    await execute(parse(snapshot), host);
    expect(layers.map(l => l.id)).toEqual(['base', 'a', 'b']); off();
  });
});

it('merges session bookmarks through snapshot/parse/execute, protects catalog views and emits UI/host changes', async () => {
  const host = createViewerControl();
  const { presentationControl } = await import('../presentation-control');
  const map = new Map<string, Record<string, unknown>>();
  Object.assign(renderer.cameraController, {
    getViewpoints: () => [...map.values()],
    addViewpoint: (v: { name: string }) => map.set(v.name, v),
    removeViewpoint: (name: string) => map.delete(name),
    saveViewpoint: (name: string) => map.set(name, { name, position: new THREE.Vector3(1,2,3), target: new THREE.Vector3(), up: new THREE.Vector3(0,1,0), fov: 45 }),
  });
  const event = vi.fn(), off = host.on('bookmarks', event);
  presentationControl.saveBookmark('UI view');
  const script = host.snapshot(), original = host.listBookmarks!();
  host.saveBookmark!('unrelated'); host.removeBookmark!('UI view');
  await execute(parse(script), host);
  expect(host.listBookmarks!().find(b => b.name === 'UI view')).toEqual(original[0]);
  expect(host.listBookmarks!().some(b => b.name === 'unrelated')).toBe(true);
  expect(() => host.saveBookmark!('Default')).toThrow('cannot be overwritten');
  expect(() => host.removeBookmark!('SOI (2004-07-01)')).toThrow('cannot be overwritten');
  expect(() => host.upsertBookmark!({ ...original[0], origin: 'wrong-catalog' })).toThrow('unavailable');
  expect(() => host.saveBookmark!('stale', { scene: -1 })).toThrow('scene changed');
  expect(event).toHaveBeenCalled(); off();
  unbindRenderer();
  expect(host.listBookmarks!()).toEqual([]); expect(host.listInstruments!()).toEqual([]);
  expect(host.getInstrument!()).toBeNull();
  expect(() => host.saveBookmark!('no-renderer')).toThrow('No renderer');
});
