/**
 * The home screen's backdrop (issue #94): the edge of Saturn, its rings and
 * Dione, drawn by the real renderer on the viewer's own canvas while no
 * catalog is up.
 *
 * Real, not staged: the Sun, Saturn and Dione are where the built-in
 * ephemerides put them, lit by the actual Sun and at their true sizes
 * (minBodyPixels 0). The moment is a real one, Dione's shadow transit of
 * 14 October 2024: the rings' shadow lies on the planet as a band beside them,
 * Dione's shadow crosses the disc, and the clock runs on from there. The
 * picture comes only from the camera: held still with a long lens and a roll,
 * so part of the disc and a diagonal of ring sit at the right and the rest of
 * the frame stays black. Dione is the only moon in the scene.
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
/** The event the scene opens on: Dione's shadow crossing Saturn on 14 October 2024, one of
 *  the last transits with the Sun still a few degrees above the rings (so their shadow lies
 *  on the planet as a band beside them) before the 2025 equinox. Mid-transit is found from
 *  the ephemerides at startup; the clock starts a little before it and runs on from there. */
const NEAR = '2024-10-14T04:00:00Z';
/** How long before mid-transit the scene opens, in simulated seconds: with the shadow just
 *  in over the limb, to cross the disc over the next eight minutes or so while Dione drifts
 *  up through the black. */
const LEAD = 4800;
/** Simulated seconds per real second. */
const RATE = 10;
/** The camera, fixed relative to Saturn: this many Saturn radii out, this far round Saturn's
 *  pole from the Sun's direction, this many degrees below the Sun (which sets Dione above
 *  its shadow, out in the black clear of the disc), and rolled so the rings cross the frame
 *  on a diagonal. */
const CAM_DISTANCE = 16;
const CAM_BEARING = 0;
const CAM_BELOW_SUN = 10;
const CAM_ROLL = -28;
/** A long lens, close on the edge of the planet. */
const FOV = 11.2;

/** Where Saturn's centre sits, as a fraction of the viewport (past the right edge), for each shape of it. */
function framing(width: number, height: number): { x: number; y: number; zoom: number } {
  const aspect = width / height;
  // A phone: the planet's edge above the title.
  if (aspect < 0.8) return { x: 1.05, y: 0.02, zoom: 0.6 };
  // Tablets and narrow windows.
  if (aspect < 1.45) return { x: 1.07, y: 0.58, zoom: 0.85 };
  return { x: 0.99, y: 0.58, zoom: 1 };
}

const MOON = { name: 'Dione', radius: 562 };

function toEt(utc: string): number {
  // No SPICE to parse it: ET is TDB seconds past J2000, near enough UTC plus
  // the 69.184 s TT offset for a backdrop.
  return (Date.parse(utc) - Date.parse('2000-01-01T12:00:00Z')) / 1000 + 69.184;
}

function heroCatalog(): Record<string, unknown> {
  const asset = (path: string) => new URL(`${import.meta.env.BASE_URL}${path}`, location.href).href;
  // As the base library has them (base/sun.json, saturn.json,
  // saturn-major-moons.json). Without kernels, Saturn follows its built-in
  // orbital elements and Dione TASS17; Dione's map is the library's own, at a
  // quarter of its resolution.
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
          radii: [SATURN_RADIUS, SATURN_RADIUS, 54364],
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
      {
        name: MOON.name,
        class: 'moon',
        center: 'Saturn',
        trajectory: { type: 'Builtin', name: MOON.name },
        rotationModel: { type: 'Builtin', name: `IAU ${MOON.name}` },
        geometry: { type: 'Globe', radius: MOON.radius, baseMap: asset('textures/dione-1k.jpg') },
      },
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

/** Mid-transit near `NEAR`: when Dione's shadow is closest to the middle of the disc. */
function midTransit(universe: Universe): number {
  const moon = universe.getBody(MOON.name)!;
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
  return mid;
}

/**
 * The camera, in km relative to Saturn, fixed for the whole scene: out along a
 * direction CAM_BEARING degrees round Saturn's pole from the Sun and
 * CAM_BELOW_SUN degrees under it, looking at the planet's centre.
 */
function planShot(universe: Universe, et: number) {
  const pole = saturnPole(universe, et);
  const sun = sunDirection(universe, et);
  const sunInPlane = sun.clone().addScaledVector(pole, -sun.dot(pole)).normalize();
  const sunEl = Math.asin(sun.dot(pole));
  const el = sunEl - THREE.MathUtils.degToRad(CAM_BELOW_SUN);
  const dir = sunInPlane
    .applyAxisAngle(pole, THREE.MathUtils.degToRad(CAM_BEARING))
    .multiplyScalar(Math.cos(el))
    .addScaledVector(pole, Math.sin(el))
    .normalize();
  const position = dir.clone().multiplyScalar(CAM_DISTANCE * SATURN_RADIUS);
  const up = pole.clone().applyAxisAngle(dir, THREE.MathUtils.degToRad(CAM_ROLL));
  return { position, up };
}

/**
 * Each frame, after the camera controller and before drawing, hold the camera
 * on the shot. The scene's origin is Saturn (the tracked body), so the shot's
 * Saturn-relative km map straight into it.
 */
function shotCamera(renderer: UniverseRenderer, shot: ReturnType<typeof planShot>): RendererPlugin {
  const position = shot.position.clone().multiplyScalar(SCALE);
  const target = new THREE.Vector3();
  return {
    name: 'home-shot-camera',
    onBeforeRender() {
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
 * Start the backdrop on `canvas`, unless it is already running. `onReady`
 * fires once its textures and stars have landed, so the home screen can fade
 * it in instead of showing it half-drawn; it never fires if WebGL is
 * unavailable, which leaves the home screen on its plain background.
 */
export function startHero(canvas: HTMLCanvasElement, onReady: () => void): void {
  if (hero) return;
  let renderer: UniverseRenderer;
  let universe: Universe;
  try {
    universe = new Universe();
    universe.loadCatalog(heroCatalog() as never);
    const mid = midTransit(universe);
    const start = mid - LEAD;
    const shot = planShot(universe, mid);
    universe.setTime(start);

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
    renderer.use(shotCamera(renderer, shot));
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
    if (hero?.renderer === renderer) onReady();
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
