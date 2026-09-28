/**
 * The home screen's backdrop (issue #94): a small scene drawn by the real
 * renderer on the viewer's own canvas while no catalog is up.
 *
 * Presentation only. It is not a catalog load: nothing here goes through the
 * loader, touches viewer state, the URL or the window title, or binds the
 * renderer the UI drives, so the home screen above it still means "no scene".
 * Its camera takes no input — pointer and keyboard controls are switched off
 * (the keyboard ones listen on the window, so this matters even with the home
 * screen covering the canvas) — and it holds still apart from the planet's own
 * rotation.
 *
 * Cheap on purpose: no SPICE (fixed points, no kernels), one 15 KB texture
 * and the star catalog every scene already loads. The loader stops it before
 * a real scene takes the canvas (`initScene`), and the app stops it as soon as
 * a load begins, so the two never render at once.
 */
import * as THREE from 'three';
import { Universe } from '@cosmolabe/core';
import { UniverseRenderer } from '@cosmolabe/three';

const SCALE = 1e-6;
const PLANET_RADIUS = 24764; // km — Neptune's
const DISTANCE = PLANET_RADIUS * 2.1;

/** Where the planet sits, as a fraction of the viewport, for each shape of it. */
function framing(width: number, height: number): { x: number; y: number; zoom: number } {
  const aspect = width / height;
  // A phone: a corner of the planet above the title.
  if (aspect < 0.8) return { x: 0.9, y: 0.0, zoom: 0.42 };
  // Tablets and narrow windows: pushed further off the edge, clear of the copy.
  if (aspect < 1.45) return { x: 0.98, y: 0.5, zoom: 0.9 };
  return { x: 0.86, y: 0.5, zoom: 1 };
}

function heroCatalog(): Record<string, unknown> {
  const asset = (path: string) => new URL(`${import.meta.env.BASE_URL}${path}`, location.href).href;
  const au = 149_597_870.7;
  // Planet at the origin; camera 2.1 radii out along -Y, so +X is screen right
  // and +Z screen up. The Sun is off to the upper left and a little behind,
  // outside the frame, which lights the limb facing the copy and leaves most
  // of the disc in shadow.
  const sun = new THREE.Vector3(-0.85, 0.2, 0.45).normalize().multiplyScalar(30 * au);
  return {
    name: 'Home',
    defaultTime: '2024-01-01T00:00:00Z',
    items: [
      {
        name: 'Sun',
        class: 'star',
        trajectory: { type: 'FixedPoint', position: sun.toArray() },
        geometry: { type: 'Globe', radius: 695000 },
      },
      {
        name: 'Planet',
        class: 'planet',
        trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        rotationModel: { type: 'Uniform', period: '16.11h', inclination: 28, meridianAngle: 0 },
        geometry: {
          type: 'Globe',
          radii: [PLANET_RADIUS, PLANET_RADIUS, 24341],
          baseMap: asset('textures/neptune.jpg'),
          atmosphere: 'Neptune',
        },
      },
      {
        // Just past the planet's upper-left limb, a little behind it.
        name: 'Companion',
        class: 'moon',
        trajectory: {
          type: 'FixedPoint',
          position: [-1.3 * PLANET_RADIUS, 0.35 * PLANET_RADIUS, 1.02 * PLANET_RADIUS],
        },
        geometry: { type: 'Globe', radius: 1900 },
      },
    ],
  };
}

let hero: { renderer: UniverseRenderer; universe: Universe; onResize: () => void } | null = null;

/**
 * Start the backdrop on `canvas`, unless it is already running. `onReady`
 * fires once its texture and stars have landed, so the home screen can fade
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
    renderer = new UniverseRenderer(canvas, universe, {
      scaleFactor: SCALE,
      showTrajectories: false,
      showLabels: false,
      showStars: true,
      starFieldOptions: { catalogUrl: `${import.meta.env.BASE_URL}stars.bin` },
      minBodyPixels: 0,
      // The catalog's asset URLs are already absolute.
      modelResolver: (source: string) => source,
      antialias: true,
      bloom: { enabled: true },
    });
  } catch (err) {
    console.warn('[Cosmolabe] Home backdrop unavailable:', err);
    return;
  }

  const controller = renderer.cameraController;
  controller.controls.enabled = false;
  controller.keyboard.enabled = false;
  controller.addViewpoint({
    name: 'Home',
    position: new THREE.Vector3(0, -DISTANCE * SCALE, 0),
    target: new THREE.Vector3(0, 0, 0),
    up: new THREE.Vector3(0, 0, 1),
    trackBody: 'Planet',
  });
  renderer.applyNamedViewpoint('Home', { animate: false });

  const onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.resize(w, h);
    // An off-axis frame rather than a turned camera: the planet moves toward
    // the edge without the perspective stretching it into an egg.
    const f = framing(w, h);
    renderer.camera.zoom = f.zoom;
    renderer.camera.setViewOffset(w, h, (0.5 - f.x) * w, (0.5 - f.y) * h, w, h);
    renderer.camera.updateProjectionMatrix();
  };
  onResize();
  window.addEventListener('resize', onResize);

  hero = { renderer, universe, onResize };
  renderer.start();
  void renderer.waitForInitialAssets().then(() => {
    if (hero?.renderer === renderer) onReady();
  });
}

/** Stop the backdrop and release it, leaving the canvas free for a scene. */
export function stopHero(): void {
  if (!hero) return;
  const { renderer, universe, onResize } = hero;
  hero = null;
  window.removeEventListener('resize', onResize);
  renderer.stop();
  renderer.camera.clearViewOffset();
  renderer.dispose();
  universe.dispose();
}
