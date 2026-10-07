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

/** Where a body-fixed surface point is in the scene this frame, and its body centre. */
export type ProbeAnchorResolver = (point: SurfacePoint) => { world: THREE.Vector3; bodyCenter: THREE.Vector3 } | null;

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

function makeMarker(sizePx: number, texture: THREE.Texture | null, opacity: number): THREE.Points {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const mat = new THREE.PointsMaterial({
    size: sizePx,
    sizeAttenuation: false,
    map: texture,
    transparent: true,
    opacity,
    alphaTest: 0.05,
    depthTest: false,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.visible = false;
  points.renderOrder = 10;
  return points;
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
  private readonly reticle: THREE.Points;
  private readonly pinMarker: THREE.Points;
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

  setPin(point: SurfacePoint | null): void {
    this.pin = point;
    this.pinCallout.setContent(point ? {
      lines: probeCalloutLines(point, 'pinned'), color: PROBE_COLOR, tone: 'selected', feature: 'probe',
    } : null);
    if (!point) this.pinCallout.hide();
  }

  /**
   * Re-anchor markers and place callouts. Returns the boxes the callouts
   * occupy so labels can yield to them.
   */
  update(
    camera: THREE.PerspectiveCamera,
    viewport: { width: number; height: number },
    resolve: ProbeAnchorResolver,
    obstacles: CalloutObstacles,
  ): ScreenRect[] {
    const boxes: ScreenRect[] = [];
    const pinScreen = this.place(this.pinMarker, this.pin, camera, viewport, resolve);
    const pinBox = this.pinCallout.update(pinScreen, viewport, obstacles);
    if (pinBox) boxes.push(pinBox);

    // A pointer still on the pinned point needs no second card: the pin's
    // card says it. Judged on screen, not by coordinates, since the
    // re-probed point drifts a hair as the body turns. The reticle stays: it
    // is where the pointer is, and so where a click would land.
    const hoverScreen = this.place(this.reticle, this.hover, camera, viewport, resolve);
    const onPin = !!hoverScreen && !!pinScreen &&
      (hoverScreen.x - pinScreen.x) ** 2 + (hoverScreen.y - pinScreen.y) ** 2 <= PIN_SLOP_PX ** 2;
    const hoverBox = onPin ? (this.hoverCallout.hide(), null) : this.hoverCallout.update(
      hoverScreen, viewport,
      pinBox ? { ...obstacles, rects: [...obstacles.rects, { ...pinBox, weight: 3 }] } : obstacles,
    );
    if (hoverBox) boxes.push(hoverBox);
    return boxes;
  }

  /** Position one marker; returns its screen anchor, or null when hidden. */
  private place(
    marker: THREE.Points,
    point: SurfacePoint | null,
    camera: THREE.PerspectiveCamera,
    viewport: { width: number; height: number },
    resolve: ProbeAnchorResolver,
  ): { x: number; y: number } | null {
    const anchor = point ? resolve(point) : null;
    if (!anchor) {
      marker.visible = false;
      return null;
    }
    marker.position.copy(anchor.world);
    // Over the limb the point is on the far side of its body: neither the
    // marker (drawn without depth test) nor its callout should show through.
    const outward = anchor.world.clone().sub(anchor.bodyCenter);
    const toCamera = camera.position.clone().sub(anchor.world);
    if (outward.dot(toCamera) < 0) {
      marker.visible = false;
      return null;
    }
    marker.visible = true;
    const p = anchor.world.clone().project(camera);
    if (p.z < -1 || p.z > 1) return null;
    return { x: (p.x + 1) * viewport.width / 2, y: (1 - p.y) * viewport.height / 2 };
  }

  dispose(): void {
    for (const marker of [this.reticle, this.pinMarker]) {
      this.markerScene.remove(marker);
      const mat = marker.material as THREE.PointsMaterial;
      mat.map?.dispose();
      mat.dispose();
      marker.geometry.dispose();
    }
    this.hoverCallout.dispose();
    this.pinCallout.dispose();
  }
}
