/**
 * The home screen's backdrop (issue #94): the Saturn system, drawn by the real
 * renderer on the viewer's own canvas while no catalog is up.
 *
 * Real, not staged: the Sun, Saturn and its moons are where the built-in
 * ephemerides put them on EPOCH, lit by the actual Sun and at their true sizes
 * (minBodyPixels 0), and the clock runs on from there. The picture comes from
 * where the camera is — riding with Iapetus, whose tilted orbit is the one place
 * among the large moons where the rings open out — and a long lens.
 *
 * Presentation only. It is not a catalog load: nothing here goes through the
 * loader, touches viewer state, the URL or the window title, or binds the
 * renderer the UI drives, so the home screen above it still means "no scene".
 * Its camera takes no input — pointer and keyboard controls are switched off
 * (the keyboard ones listen on the window, so this matters even with the home
 * screen covering the canvas).
 *
 * Cheap on purpose: no SPICE (analytical theories, no kernels), 40 KB of
 * texture and the star catalog every scene already loads. The loader stops it
 * before a real scene takes the canvas (`initScene`), and the app stops it as
 * soon as a load begins, so the two never render at once.
 */
import * as THREE from 'three';
import { Universe, composeBodyToWorldQuat } from '@cosmolabe/core';
import { UniverseRenderer, type RendererPlugin } from '@cosmolabe/three';

const SCALE = 1e-6;
/** When the scene opens: April 2022, with the Sun 15 degrees above the rings (so they shade
 *  the planet in a broad band) and Iapetus 14 degrees above them on the same, sunlit side.
 *  Fixed, so the home screen opens on the same sky every visit. */
const EPOCH = '2022-04-17T00:00:00Z';
/** Simulated seconds per real second: Saturn turns in about a minute, Tethys laps it in under five. */
const RATE = 600;
/** The camera rides with Iapetus, looking back past it at Saturn. Its orbit is tilted about
 *  15 degrees to the rings, so it is the one large moon from which they open out. */
const ESCORT = 'Iapetus';
/** Where the camera sits relative to Iapetus, in km: back from it (away from Saturn), up
 *  (along Saturn's pole) and to the left, which sets the moon low and right of the planet. */
const CAM_BACK = 120000;
const CAM_UP = 4800;
const CAM_LEFT = 5200;
/** A long lens: from 3.6 million km, Saturn and its rings span about 4.5 degrees. */
const FOV = 6.5;

/** Where Saturn sits, as a fraction of the viewport, for each shape of it. */
function framing(width: number, height: number): { x: number; y: number; zoom: number } {
  const aspect = width / height;
  // A phone: the planet and its rings above the title.
  if (aspect < 0.8) return { x: 0.5, y: 0.085, zoom: 0.42 };
  // Tablets and narrow windows: pushed further off the edge, clear of the copy.
  if (aspect < 1.45) return { x: 0.74, y: 0.42, zoom: 0.78 };
  return { x: 0.66, y: 0.45, zoom: 1 };
}

// Mean radii, km.
const MOONS: [name: string, radiusKm: number][] = [
  ['Mimas', 198],
  ['Enceladus', 252],
  ['Tethys', 533],
  ['Dione', 562],
  ['Rhea', 764],
  ['Titan', 2575],
  ['Iapetus', 735],
];

function heroCatalog(): Record<string, unknown> {
  const asset = (path: string) => new URL(`${import.meta.env.BASE_URL}${path}`, location.href).href;
  // As the base library has them (base/sun.json, saturn.json, saturn-major-moons.json),
  // minus the moons' textures, which run to megabytes each. Without kernels,
  // Saturn follows its built-in orbital elements and the moons TASS17.
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
          radii: [60268, 60268, 54364],
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
        geometry: { type: 'Globe', radius },
      })),
    ],
  };
}

/** Saturn's north pole in world space. */
function saturnPole(universe: Universe): THREE.Vector3 {
  const saturn = universe.getBody('Saturn')!;
  const q = composeBodyToWorldQuat(saturn.rotationAt(universe.time)!, saturn.rotation!.sourceFrame);
  return new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q[1], q[2], q[3], q[0]));
}

/**
 * Each frame, after the camera controller and before drawing, set the camera
 * just behind the escort moon and aim it at Saturn. The scene's origin is
 * Saturn (the tracked body), so Saturn is at 0,0,0 and the moon's mesh
 * position is its offset from the planet.
 */
function escortCamera(renderer: UniverseRenderer, pole: THREE.Vector3): RendererPlugin {
  const back = new THREE.Vector3();
  const right = new THREE.Vector3();
  const saturn = new THREE.Vector3();
  return {
    name: 'home-escort-camera',
    onBeforeRender() {
      const moon = renderer.getBodyMesh(ESCORT);
      if (!moon) return;
      back.copy(moon.position).normalize();
      right.crossVectors(back, pole).negate().normalize(); // forward (-back) x up
      const cam = renderer.camera;
      cam.position
        .copy(moon.position)
        .addScaledVector(back, CAM_BACK * SCALE)
        .addScaledVector(pole, CAM_UP * SCALE)
        .addScaledVector(right, -CAM_LEFT * SCALE);
      cam.up.copy(pole);
      renderer.cameraController.controls.target.copy(saturn);
      cam.lookAt(saturn);
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
    // No SPICE to parse the epoch: ET is TDB seconds past J2000, near enough
    // UTC plus the 69.184 s TT offset for a backdrop.
    universe.setTime((Date.parse(EPOCH) - Date.parse('2000-01-01T12:00:00Z')) / 1000 + 69.184);

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
    // Tracking Saturn makes it the scene's origin; the escort plugin then
    // places the camera itself every frame.
    const saturn = renderer.getBodyMesh('Saturn');
    if (saturn) controller.track(saturn);
    renderer.camera.fov = FOV;
    renderer.use(escortCamera(renderer, saturnPole(universe)));
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
