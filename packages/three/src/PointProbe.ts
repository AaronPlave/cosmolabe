/**
 * Point Probe visuals (#127): a constant-screen-size reticle that follows the
 * pointer over probeable surfaces, a pinned marker for the clicked point, and
 * an anchored callout for each in the same language as event annotations.
 *
 * This only draws. Which point is hovered or pinned is decided by the
 * renderer's shared hit-testing (`pickScene(…, 'probe')`) and owned by the
 * host; the overlay re-anchors both markers every frame so they stay on the
 * surface as the body rotates and moves.
 */

import * as THREE from 'three';
import { EventCallout, type CalloutObstacles, type ScreenRect } from './EventCallout.js';
import {
  coordinateDecimals, describeDatum, formatHeight, formatLatitude, formatLongitude, type SurfacePoint,
} from './SceneHit.js';

/** Probe accent: distinct from event amber, quiet against terrain. */
export const PROBE_COLOR = '#7cc8f0';

/**
 * A hover preview this close to the pin on screen previews the pin itself.
 * Tight on purpose: one pixel off is a different point a click would move
 * the pin to.
 */
const PIN_SLOP_PX = 2;

/**
 * Where a body-fixed surface point is in the scene this frame, its body
 * centre, and the surface normal there in scene axes (when the point has one).
 */
export type ProbeAnchorResolver = (point: SurfacePoint) => {
  world: THREE.Vector3;
  bodyCenter: THREE.Vector3;
  normal: THREE.Vector3 | null;
} | null;

/**
 * Least |cos| between a marker's plane normal and the view: laid flat on
 * the surface it foreshortens with the view, but never past 60° (half its
 * height) so a grazing view still shows a ring, not a sliver.
 */
const MIN_FACING = 0.5;

/** What the overlay needs from the scene each frame. */
export interface ProbeSceneQuery {
  resolve: ProbeAnchorResolver;
  /**
   * Whether rendered geometry stands between the camera and the pinned point
   * at `world`. The markers draw over everything, so this alone decides
   * whether the pin shows.
   */
  pinOccluded: (point: SurfacePoint, world: THREE.Vector3) => boolean;
  /** Where the hovered point was picked from, while the pointer is over the canvas. */
  pointer: { x: number; y: number } | null;
}

function markerTexture(draw: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  draw(ctx, size);
  return new THREE.CanvasTexture(canvas);
}

/**
 * A marker laid on the surface: a unit square carrying the glyph, oriented
 * and scaled each frame (`orient`) so it lies in the surface's tangent plane
 * at a constant on-screen size. Drawn over everything; the renderer decides
 * occlusion.
 */
function makeMarker(sizePx: number, texture: THREE.Texture | null, opacity: number): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity,
    alphaTest: 0.05,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 10;
  mesh.userData.sizePx = sizePx;
  return mesh;
}

const _toEye = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _planeNormal = new THREE.Vector3(0, 0, 1);

/** Lay a marker at its position flat on the surface, `sizePx` across on screen. */
function orient(
  marker: THREE.Mesh,
  normal: THREE.Vector3 | null,
  bodyCenter: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  viewportHeight: number,
): void {
  _toEye.subVectors(camera.position, marker.position);
  const range = _toEye.length();
  if (range === 0) return;
  _toEye.divideScalar(range);
  // No surface normal: the radial direction is the best guess at "up".
  _normal.copy(normal ?? _tangent.subVectors(marker.position, bodyCenter)).normalize();
  let facing = _normal.dot(_toEye);
  if (facing < 0) {
    _normal.negate();
    facing = -facing;
  }
  if (facing < MIN_FACING) {
    // Tilt toward the eye just enough to keep a legible ellipse.
    _tangent.copy(_normal).addScaledVector(_toEye, -facing);
    if (_tangent.lengthSq() > 1e-12) {
      _tangent.normalize();
      _normal.copy(_toEye).multiplyScalar(MIN_FACING)
        .addScaledVector(_tangent, Math.sqrt(1 - MIN_FACING * MIN_FACING));
    }
  }
  marker.quaternion.setFromUnitVectors(_planeNormal, _normal);
  const worldPerPx = range * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.max(1, viewportHeight);
  marker.scale.setScalar((marker.userData.sizePx as number) * worldPerPx);
}

/** Callout lines for a probed point: title, coordinates, height above datum. */
export function probeCalloutLines(point: SurfacePoint, detail: 'preview' | 'pinned'): string[] {
  // As fine as the pointer can place the point: a pixel's worth of ground.
  const decimals = coordinateDecimals(point);
  const coords = `${formatLatitude(point.latDeg, decimals.lat)}, ${formatLongitude(point.lonDeg, decimals.lon)}`;
  if (detail === 'preview') return [`${point.bodyName} · ${coords}`];
  return [
    point.bodyName,
    coords,
    `${formatHeight(point.altitude.km)} · ${describeDatum(point.altitude.datum)}`,
  ];
}

export class PointProbeOverlay {
  private readonly reticle: THREE.Mesh;
  private readonly pinMarker: THREE.Mesh;
  private readonly hoverCallout: EventCallout;
  private readonly pinCallout: EventCallout;
  private hover: SurfacePoint | null = null;
  private pin: SurfacePoint | null = null;

  constructor(private readonly markerScene: THREE.Scene, labelContainer: HTMLElement) {
    // Hover: an open ring with a centre tick — "here", without covering it.
    const ring = markerTexture((ctx, size) => {
      const c = size / 2;
      ctx.strokeStyle = '#e4ebef';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c, c, c - 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#e4ebef';
      ctx.beginPath();
      ctx.arc(c, c, 3, 0, Math.PI * 2);
      ctx.fill();
    });
    // Pinned: a solid accent dot with a dark keyline, legible on any terrain.
    const dot = markerTexture((ctx, size) => {
      const c = size / 2;
      ctx.fillStyle = 'rgba(9, 13, 18, 0.85)';
      ctx.beginPath();
      ctx.arc(c, c, c - 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = PROBE_COLOR;
      ctx.beginPath();
      ctx.arc(c, c, c - 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = PROBE_COLOR;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(c, c, c - 4, 0, Math.PI * 2);
      ctx.stroke();
    });
    this.reticle = makeMarker(20, ring, 0.85);
    this.pinMarker = makeMarker(18, dot, 1);
    markerScene.add(this.reticle, this.pinMarker);
    // The preview follows the pointer: it swaps in place, never cross-fades.
    this.hoverCallout = new EventCallout(labelContainer, 'instant');
    this.pinCallout = new EventCallout(labelContainer);
  }

  get hovered(): SurfacePoint | null { return this.hover; }
  get pinned(): SurfacePoint | null { return this.pin; }

  setHover(point: SurfacePoint | null): void {
    this.hover = point;
    this.hoverCallout.setContent(point ? {
      lines: probeCalloutLines(point, 'preview'), color: PROBE_COLOR, tone: 'preview', feature: 'probe',
    } : null);
    if (!point) this.hoverCallout.hide();
  }

  /** Pin a point, or clear it. `refined` restates the same pin (finer terrain), in place. */
  setPin(point: SurfacePoint | null, refined = false): void {
    this.pin = point;
    this.pinCallout.setContent(point ? {
      lines: probeCalloutLines(point, 'pinned'), color: PROBE_COLOR, tone: 'selected', feature: 'probe',
    } : null, { inPlace: refined });
    if (!point) this.pinCallout.hide();
  }

  /**
   * Re-anchor markers and place callouts. Returns the boxes the callouts
   * occupy so labels can yield to them.
   */
  update(
    camera: THREE.PerspectiveCamera,
    viewport: { width: number; height: number },
    scene: ProbeSceneQuery,
    obstacles: CalloutObstacles,
  ): ScreenRect[] {
    const boxes: ScreenRect[] = [];
    const pinScreen = this.placePin(camera, viewport, scene);
    const pinBox = this.pinCallout.update(pinScreen, viewport, obstacles);
    if (pinBox) boxes.push(pinBox);

    // A pointer still on the pinned point needs no second card: the pin's
    // card says it. Judged on screen, not by coordinates, since the
    // re-probed point drifts a hair as the body turns. The reticle stays: it
    // is where the pointer is, and so where a click would land.
    const hoverScreen = this.placeReticle(camera, viewport, scene.resolve, scene.pointer);
    const onPin = !!hoverScreen && !!pinScreen &&
      (hoverScreen.x - pinScreen.x) ** 2 + (hoverScreen.y - pinScreen.y) ** 2 <= PIN_SLOP_PX ** 2;
    const hoverBox = onPin ? (this.hoverCallout.hide(), null) : this.hoverCallout.update(
      hoverScreen, viewport,
      pinBox ? { ...obstacles, rects: [...obstacles.rects, { ...pinBox, weight: 3 }] } : obstacles,
    );
    if (hoverBox) boxes.push(hoverBox);
    return boxes;
  }

  /** Position the pin on its surface point; returns its screen anchor, or null when hidden. */
  private placePin(
    camera: THREE.PerspectiveCamera,
    viewport: { width: number; height: number },
    scene: ProbeSceneQuery,
  ): { x: number; y: number } | null {
    const marker = this.pinMarker;
    const anchor = this.pin ? scene.resolve(this.pin) : null;
    // Behind terrain or its body, the pin (drawn without depth test) and its
    // callout should not show through.
    if (!anchor || scene.pinOccluded(this.pin!, anchor.world)) {
      marker.visible = false;
      return null;
    }
    marker.position.copy(anchor.world);
    orient(marker, anchor.normal, anchor.bodyCenter, camera, viewport.height);
    marker.visible = true;
    const p = anchor.world.clone().project(camera);
    if (p.z < -1 || p.z > 1) return null;
    return { x: (p.x + 1) * viewport.width / 2, y: (1 - p.y) * viewport.height / 2 };
  }

  /**
   * Position the hover reticle. It is drawn at the pointer, at the hovered
   * point's depth: the hover is re-picked at most once a frame and less when
   * picks are slow, so a reticle anchored to the last picked point would
   * slide off the cursor while the camera moves and snap back at the next
   * pick. The hover came from a ray that reached the surface, so it is
   * visible by construction and needs no occlusion test.
   */
  private placeReticle(
    camera: THREE.PerspectiveCamera,
    viewport: { width: number; height: number },
    resolve: ProbeAnchorResolver,
    pointer: { x: number; y: number } | null,
  ): { x: number; y: number } | null {
    const marker = this.reticle;
    const anchor = this.hover ? resolve(this.hover) : null;
    const p = anchor?.world.clone().project(camera);
    if (!p || p.z < -1 || p.z > 1) {
      marker.visible = false;
      return null;
    }
    if (pointer) {
      p.x = (pointer.x / viewport.width) * 2 - 1;
      p.y = 1 - (pointer.y / viewport.height) * 2;
    }
    marker.position.copy(p).unproject(camera);
    orient(marker, anchor!.normal, anchor!.bodyCenter, camera, viewport.height);
    marker.visible = true;
    return { x: (p.x + 1) * viewport.width / 2, y: (1 - p.y) * viewport.height / 2 };
  }

  dispose(): void {
    for (const marker of [this.reticle, this.pinMarker]) {
      this.markerScene.remove(marker);
      const mat = marker.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
      marker.geometry.dispose();
    }
    this.hoverCallout.dispose();
    this.pinCallout.dispose();
  }
}
