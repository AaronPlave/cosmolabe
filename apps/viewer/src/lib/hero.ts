/**
 * The home screen's backdrop (issue #94): Dione crossing Saturn, with its
 * shadow on the cloud tops, drawn by the real renderer on the viewer's own
 * canvas while no catalog is up.
 *
 * Real, not staged: the Sun, Saturn and its moons are where the built-in
 * ephemerides put them, lit by the actual Sun and at their true sizes
 * (minBodyPixels 0). The event is a real one — Dione's shadow transit of
 * 14 October 2024, one of the last with the Sun still a few degrees above the
 * rings before the 2025 equinox — found to the minute at startup, and the
 * clock plays through it and loops. The picture comes only from the camera:
 * held still near Dione's path with a long lens.
 *
 * Presentation only. It is not a catalog load: nothing here goes through the
 * loader, touches viewer state, the URL or the window title, or binds the
 * renderer the UI drives, so the home screen above it still means "no scene".
 * Its camera takes no input — pointer and keyboard controls are switched off
 * (the keyboard ones listen on the window, so this matters even with the home
 * screen covering the canvas).
 *
 * Cheap on purpose: no SPICE (analytical theories, no kernels), about 200 KB
 * of texture and the star catalog every scene already loads. The loader stops
 * it before a real scene takes the canvas (`initScene`), and the app stops it
 * as soon as a load begins, so the two never render at once.
 */
import * as THREE from 'three';
import { Universe, composeBodyToWorldQuat } from '@cosmolabe/core';
import { UniverseRenderer, type RendererPlugin } from '@cosmolabe/three';

const SCALE = 1e-6;
const SATURN_RADIUS = 60268; // km, equatorial
const SATURN_POLAR_RADIUS = 54364;
/** The moon that transits, and roughly when: the search below finds mid-transit to the minute. */
const MOON = 'Dione';
const NEAR = '2024-10-14T04:00:00Z';
/** The stretch of the event that plays, then loops, in simulated seconds from mid-transit:
 *  from Dione coming out of the dark on the left to its shadow leaving on the right. */
const FROM = -1600;
const TO = 900;
/** Real seconds the scene takes to fade out before the loop restarts (the home screen's cover fades back in over it). */
const FADE = 1.4;
/** Simulated seconds per real second: the loop runs close on three minutes, Dione crossing the disc in about a hundred seconds of it. */
const RATE = 15;
/** The camera: this far out from Dione (km), in a direction this many degrees off the
 *  Sun's (round Saturn's pole), which sets the moon beside its shadow. */
const CAM_DISTANCE = 150000;
const CAM_PHASE = 3;
/** A long lens, close on the moon and the part of the disc its shadow crosses. */
const FOV = 8;

/** Where the shot's centre sits, as a fraction of the viewport, for each shape of it. */
function framing(width: number, height: number): { x: number; y: number; zoom: number } {
  const aspect = width / height;
  // A phone: the event above the title.
  if (aspect < 0.8) return { x: 0.5, y: 0.1, zoom: 0.5 };
  // Tablets and narrow windows: further right, clear of the copy.
  if (aspect < 1.45) return { x: 0.9, y: 0.5, zoom: 0.72 };
  return { x: 0.87, y: 0.5, zoom: 1 };
}

// Mean radii, km.
const MOONS: [name: string, radiusKm: number][] = [
  ['Mimas', 198],
  ['Enceladus', 252],
  ['Tethys', 533],
  ['Dione', 562],
  ['Rhea', 764],
  ['Titan', 2575],
];

function toEt(utc: string): number {
  // No SPICE to parse it: ET is TDB seconds past J2000, near enough UTC plus
  // the 69.184 s TT offset for a backdrop.
  return (Date.parse(utc) - Date.parse('2000-01-01T12:00:00Z')) / 1000 + 69.184;
}

function heroCatalog(): Record<string, unknown> {
  const asset = (path: string) => new URL(`${import.meta.env.BASE_URL}${path}`, location.href).href;
  // As the base library has them (base/sun.json, saturn.json,
  // saturn-major-moons.json). Without kernels, Saturn follows its built-in
  // orbital elements and the moons TASS17. Only Dione, the one seen up close,
  // carries a map: the library's own, at a quarter of its resolution.
  return {
    name: 'Home',
    items: [
      {
        name: 'Sun',
        class: 'star',
        trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        geometry: { type: 'Globe', radius: 695000, emissive: true },
      },
      {
        name: 'Saturn',
        class: 'planet',
        center: 'Sun',
        trajectory: { type: 'Builtin', name: 'Saturn' },
        bodyFrame: 'EquatorJ2000',
        rotationModel: {
          type: 'Uniform',
          period: '10.656222221732387h',
          inclination: 6.463,
          ascendingNode: 130.589,
          meridianAngle: 38.9,
        },
        geometry: {
          type: 'Globe',
          radii: [SATURN_RADIUS, SATURN_RADIUS, SATURN_POLAR_RADIUS],
          baseMap: asset('textures/saturn.jpg'),
          atmosphere: 'Saturn',
        },
        items: [
          {
            name: 'Saturn Rings',
            class: 'other',
            center: 'Saturn',
            geometry: {
              type: 'Rings',
              innerRadius: 74660,
              outerRadius: 140220,
              texture: asset('textures/saturn-rings.png'),
            },
          },
        ],
      },
      ...MOONS.map(([name, radius]) => ({
        name,
        class: 'moon',
        center: 'Saturn',
        trajectory: { type: 'Builtin', name },
        rotationModel: { type: 'Builtin', name: `IAU ${name}` },
        geometry: {
          type: 'Globe',
          radius,
          ...(name === MOON ? { baseMap: asset('textures/dione-1k.jpg') } : {}),
        },
      })),
    ],
  };
}

type Vec = THREE.Vector3;
const vec = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);

/** Saturn's north pole in world space. */
function saturnPole(universe: Universe, et: number): Vec {
  const saturn = universe.getBody('Saturn')!;
  const q = composeBodyToWorldQuat(saturn.rotationAt(et)!, saturn.rotation!.sourceFrame);
  return new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q[1], q[2], q[3], q[0]));
}

/** Direction from Saturn to the Sun. */
function sunDirection(universe: Universe, et: number): Vec {
  return vec(universe.getBody('Saturn')!.stateAt(et).position).negate().normalize();
}

/**
 * The shot, in km relative to Saturn and fixed for the whole event: mid-transit
 * (when the moon's shadow is nearest the centre of the disc), a camera out past
 * the moon a few degrees off the Sun's direction, and the point it looks at —
 * between the moon and its shadow, so both stay in frame.
 */
function planShot(universe: Universe) {
  const moon = universe.getBody(MOON)!;
  const near = toEt(NEAR);
  let mid = near;
  let best = Infinity;
  for (let et = near - 12 * 3600; et <= near + 12 * 3600; et += 60) {
    const sun = sunDirection(universe, et);
    const m = vec(moon.stateAt(et).position);
    const along = m.dot(sun);
    if (along <= 0) continue;
    const off = m.addScaledVector(sun, -along).length();
    if (off < best) { best = off; mid = et; }
  }

  const sun = sunDirection(universe, mid);
  const pole = saturnPole(universe, mid);
  const m = vec(moon.stateAt(mid).position);
  // Where the shadow falls: the sunward point of the disc under the moon.
  const offset = m.clone().addScaledVector(sun, -m.dot(sun));
  const shadow = offset.clone().addScaledVector(sun, Math.sqrt(Math.max(0, SATURN_RADIUS ** 2 - offset.lengthSq())));
  // Off the Sun's direction round Saturn's pole, so the moon stands beside its
  // shadow rather than over it.
  const out = sun.clone().applyAxisAngle(pole, THREE.MathUtils.degToRad(CAM_PHASE));
  const position = m.clone().addScaledVector(out, CAM_DISTANCE);
  const aim = m.clone().sub(position).normalize().add(shadow.clone().sub(position).normalize()).normalize();
  const target = position.clone().addScaledVector(aim, shadow.distanceTo(position));
  return { mid, position, target, up: pole };
}

/**
 * Each frame, after the camera controller and before drawing, hold the camera
 * on the shot, and loop the clock over the event: hidden just before the end
 * (`show(false)`), rewound, then shown again, so the jump happens in the dark.
 * The scene's origin is Saturn (the tracked body), so the shot's
 * Saturn-relative km map straight into it.
 */
function shotCamera(
  renderer: UniverseRenderer,
  shot: ReturnType<typeof planShot>,
  show: (visible: boolean) => void,
): RendererPlugin {
  const position = shot.position.clone().multiplyScalar(SCALE);
  const target = shot.target.clone().multiplyScalar(SCALE);
  let hidden = false;
  return {
    name: 'home-shot-camera',
    onBeforeRender(et: number) {
      if (et > shot.mid + TO || et < shot.mid + FROM) {
        renderer.timeController.setTime(shot.mid + FROM);
        if (hidden) show(true);
        hidden = false;
      } else if (!hidden && et > shot.mid + TO - FADE * RATE) {
        hidden = true;
        show(false);
      }
      const cam = renderer.camera;
      cam.position.copy(position);
      cam.up.copy(shot.up);
      renderer.cameraController.controls.target.copy(target);
      cam.lookAt(target);
    },
  };
}

let hero: { renderer: UniverseRenderer; universe: Universe } | null = null;

/**
 * Start the backdrop on `canvas`, unless it is already running. `onVisible`
 * says when the home screen should let it show through: true once its
 * textures and stars have landed (so it fades in rather than showing
 * half-drawn), then false and true again around each loop. It never fires if
 * WebGL is unavailable, which leaves the home screen on its plain background.
 */
export function startHero(canvas: HTMLCanvasElement, onVisible: (visible: boolean) => void): void {
  if (hero) return;
  let renderer: UniverseRenderer;
  let universe: Universe;
  let ready = false;
  try {
    universe = new Universe();
    universe.loadCatalog(heroCatalog() as never);
    const shot = planShot(universe);
    universe.setTime(shot.mid + FROM);

    renderer = new UniverseRenderer(canvas, universe, {
      scaleFactor: SCALE,
      showTrajectories: false,
      showLabels: false,
      showStars: true,
      starFieldOptions: { catalogUrl: `${import.meta.env.BASE_URL}stars.bin` },
      // True sizes: a distant moon is a point of light or nothing, as it would be.
      minBodyPixels: 0,
      // The catalog's asset URLs are already absolute.
      modelResolver: (source: string) => source,
      antialias: true,
      bloom: { enabled: true },
    });

    const controller = renderer.cameraController;
    controller.controls.enabled = false;
    controller.keyboard.enabled = false;
    // Tracking Saturn makes it the scene's origin; the shot plugin then
    // places the camera itself every frame.
    const saturn = renderer.getBodyMesh('Saturn');
    if (saturn) controller.track(saturn);
    renderer.camera.fov = FOV;
    renderer.use(shotCamera(renderer, shot, (visible) => {
      if (ready) onVisible(visible);
    }));
    renderer.timeController.setTime(universe.time);
    renderer.timeController.setRate(RATE);
  } catch (err) {
    console.warn('[Cosmolabe] Home backdrop unavailable:', err);
    return;
  }

  hero = { renderer, universe };
  resizeHero(window.innerWidth, window.innerHeight);
  renderer.start();
  void renderer.waitForInitialAssets().then(() => {
    if (hero?.renderer !== renderer) return;
    ready = true;
    onVisible(true);
  });
}

/**
 * Fit the backdrop to the window. Driven by the app's own resize handling
 * (`loader.resize`), which also resets the canvas's backing size: a listener
 * of the backdrop's own could run before that and be undone by it.
 */
export function resizeHero(w: number, h: number): void {
  if (!hero) return;
  const { renderer } = hero;
  renderer.resize(w, h);
  // An off-axis frame rather than a turned camera: the planet moves toward
  // the edge without the perspective stretching it into an egg.
  const f = framing(w, h);
  renderer.camera.zoom = f.zoom;
  renderer.camera.setViewOffset(w, h, (0.5 - f.x) * w, (0.5 - f.y) * h, w, h);
  renderer.camera.updateProjectionMatrix();
}

/** Stop the backdrop and release it, leaving the canvas free for a scene. */
export function stopHero(): void {
  if (!hero) return;
  const { renderer, universe } = hero;
  hero = null;
  renderer.stop();
  renderer.camera.clearViewOffset();
  renderer.dispose();
  universe.dispose();
}
