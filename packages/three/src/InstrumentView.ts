import * as THREE from 'three';
import type { SensorFrustum } from './SensorFrustum.js';
import type { Body } from '@cosmolabe/core';

/** How the instrument camera was pointed: SPICE attitude, host attitude + mounting, aimed at the target, not at all, or refused. */
export type InstrumentPointing = 'spice' | 'attitude' | 'target' | 'none' | 'unavailable';

export interface InstrumentViewOptions {
  /** Width of the PiP viewport in pixels. Default 320. */
  width?: number;
  /** Height of the PiP viewport in pixels. Default 240. */
  height?: number;
  /** Margin from edges in pixels. Default 16. */
  margin?: number;
  /** Horizontal margin override (from left/right edge). Uses margin if not set. */
  marginX?: number;
  /** Vertical margin override (from top/bottom edge). Uses margin if not set. */
  marginY?: number;
  /** Corner position. Default 'bottom-right'. */
  corner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Border color (CSS). Default '#66ccff'. */
  borderColor?: string;
  /**
   * Where the feed is presented: a 2D canvas the host places and sizes, e.g.
   * inside a movable window. Its CSS box is read every frame; the instrument
   * image is fitted inside it at native aspect. Omitted, the view presents in
   * its own fixed corner inset (the size/margin/corner options above).
   */
  surface?: HTMLCanvasElement | null;
}

/** A rectangle in CSS pixels, top-left origin. */
export interface Rect { x: number; y: number; w: number; h: number }

/** FOV outline in normalized image space: u right, v down, 0..1 across the image. */
export type FovOutline =
  | { kind: 'polygon'; points: [number, number][] }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number };

/**
 * The image of a `aspect` (w/h) instrument fitted inside a w×h box: centered,
 * letterboxed or pillarboxed, never cropped or stretched.
 */
export function fitImageRect(w: number, h: number, aspect: number): Rect {
  if (aspect > w / h) {
    const ih = w / aspect;
    return { x: 0, y: (h - ih) / 2, w, h: ih };
  }
  const iw = h * aspect;
  return { x: (w - iw) / 2, y: 0, w: iw, h };
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}

/**
 * The part of `el` actually on screen, relative to `origin` (the main canvas's
 * box): clipped by every overflow-clipping ancestor up to the first fixed one
 * (a fixed element escapes the clips above it) and by the canvas itself.
 * Rendering outside this would leave instrument pixels in the main scene where
 * the surface is scrolled or clipped out of view.
 */
function visibleRect(el: Element, origin: DOMRect): Rect | null {
  const rel = (r: DOMRect): Rect => ({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
  let rect: Rect | null = intersectRect(rel(el.getBoundingClientRect()), { x: 0, y: 0, w: origin.width, h: origin.height });
  for (let node: Element | null = el; rect && node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node !== el && (style.overflowX !== 'visible' || style.overflowY !== 'visible')) {
      rect = intersectRect(rect, rel(node.getBoundingClientRect()));
    }
    if (style.position === 'fixed') break;
  }
  return rect;
}

const _savedViewport = new THREE.Vector4();
const _savedScissor = new THREE.Vector4();
const _savedClearColor = new THREE.Color();
const _lookTarget = new THREE.Vector3();

/** Margin around a SPICE FOV boundary so its outline sits just inside the image. */
const FOV_PADDING = 1.05;

/** FOV boundary data for drawing the actual sensor footprint outline. */
export interface FovBoundary {
  shape: string;               // 'POLYGON' | 'RECTANGLE' | 'CIRCLE' | 'ELLIPSE'
  boresight: [number, number, number];
  bounds: [number, number, number][];
}

/**
 * Renders the view from an instrument's perspective: a camera at the
 * instrument position, oriented along its boresight, presented in a surface
 * canvas (a host window or the default corner inset) or full-canvas.
 */
export class InstrumentView {
  readonly camera: THREE.PerspectiveCamera;
  private sensor: SensorFrustum | null = null;
  private readonly options: Required<InstrumentViewOptions>;
  private readonly overlayDiv: HTMLDivElement;
  private readonly labelDiv: HTMLDivElement;
  private readonly fovDiv: HTMLDivElement;
  private readonly defaultSurface: HTMLCanvasElement;
  private surface: HTMLCanvasElement | null = null;
  private outline: FovOutline | null = null;
  private color: string;
  private layout: { surface: Rect; fit: Rect; image: Rect; clip: Rect } | null = null;
  private _pointing: InstrumentPointing = 'none';
  private _unavailableReason: string | null = null;
  private _fov: [number, number] = [0, 0];
  private _fovKnown = false;
  private _viewFov: [number, number] = [0, 0];
  private _active = false;
  /** Instrument native aspect ratio (hFov / vFov). Used for letterboxing. */
  private instrAspect = 1;
  /** Angular offset (in radians) of the FOV centroid from the boresight [h, v]. */
  private fovCenterOffset: [number, number] = [0, 0];

  constructor(
    private readonly canvasParent: HTMLElement,
    options: InstrumentViewOptions = {},
  ) {
    const margin = options.margin ?? 16;
    this.options = {
      width: options.width ?? 320,
      height: options.height ?? 240,
      margin,
      marginX: options.marginX ?? margin,
      marginY: options.marginY ?? margin,
      corner: options.corner ?? 'bottom-right',
      borderColor: options.borderColor ?? '#66ccff',
      surface: options.surface ?? null,
    };
    this.color = this.options.borderColor;
    this.surface = this.options.surface;

    this.camera = new THREE.PerspectiveCamera(
      60,
      this.options.width / this.options.height,
      1e-8, 1e12,
    );

    // Overlay border element
    this.overlayDiv = document.createElement('div');
    this.overlayDiv.style.cssText = `
      position: absolute;
      pointer-events: none;
      border: 2px solid ${this.options.borderColor};
      box-sizing: border-box;
      display: none;
    `;
    this.positionOverlay();

    // Label showing instrument name
    this.labelDiv = document.createElement('div');
    this.labelDiv.style.cssText = `
      position: absolute;
      bottom: 100%;
      left: 0;
      padding: 2px 8px;
      background: rgba(0,0,0,0.7);
      color: ${this.options.borderColor};
      font: 11px/1.4 monospace;
      white-space: nowrap;
    `;
    this.overlayDiv.appendChild(this.labelDiv);

    // FOV info overlay
    this.fovDiv = document.createElement('div');
    this.fovDiv.style.cssText = `
      position: absolute;
      top: 4px;
      right: 6px;
      padding: 1px 4px;
      background: rgba(0,0,0,0.5);
      color: #888;
      font: 10px/1.2 monospace;
      white-space: nowrap;
    `;
    this.overlayDiv.appendChild(this.fovDiv);

    // Default presentation surface, used when the host supplies none.
    this.defaultSurface = document.createElement('canvas');
    this.defaultSurface.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%;';
    this.overlayDiv.insertBefore(this.defaultSurface, this.overlayDiv.firstChild);

    canvasParent.appendChild(this.overlayDiv);
  }

  get active(): boolean { return this._active; }
  get sensorName(): string | undefined { return this.sensor?.body.name; }
  /**
   * The sensor's angular coverage, degrees [horizontal, vertical]: the SPICE
   * boundary's extent, or the catalog FOV. Null when neither gives one and the
   * view falls back to a nominal 10°.
   */
  get fov(): [number, number] | null { return this._fovKnown ? this._fov : null; }
  /** Angular extent of the rendered image, degrees — the coverage plus padding when drawn from a SPICE boundary. */
  get viewFov(): [number, number] { return this._viewFov; }
  /** How the camera was pointed on the last update: SPICE attitude, aimed at the target, or not at all. */
  get pointing(): InstrumentPointing { return this._pointing; }
  /** Why the instrument cannot be pointed (`pointing === 'unavailable'`); nothing is rendered then. */
  get unavailableReason(): string | null { return this._unavailableReason; }
  /** No truthful pointing this frame: say why, and render nothing. */
  markUnavailable(reason: string): void {
    this._pointing = 'unavailable';
    this._unavailableReason = reason;
  }
  /**
   * Where the image sits inside the surface on the last rendered frame, in the
   * surface's CSS pixels — offsets are the letterbox/pillarbox bars. Null when
   * nothing was rendered. The transform image picking and overlays build on.
   */
  get imageRect(): Rect | null { return this.layout && !this.fullScreen ? this.layout.fit : null; }

  private get presentSurface(): HTMLCanvasElement { return this.surface ?? this.defaultSurface; }

  /** Present into a host canvas, or null for the default corner inset. */
  setSurface(surface: HTMLCanvasElement | null): void {
    this.surface = surface;
  }

  /** When true, render() fills the main viewport instead of the PiP corner. */
  fullScreen = false;

  /** Set the active instrument sensor (or null to deactivate). */
  setSensor(sensor: SensorFrustum | null, fovBoundary?: FovBoundary): void {
    this.sensor = sensor;
    this._active = sensor != null;
    this.outline = null;
    this.fovCenterOffset = [0, 0];
    this._pointing = 'none';
    this._fovKnown = false;

    if (sensor) {
      const geo = sensor.body.geometryData as Record<string, unknown> | undefined;
      this._fovKnown = geo?.horizontalFov != null || (fovBoundary?.bounds.length ?? 0) >= 1;
      let hFov = (geo?.horizontalFov as number) ?? 10;
      let vFov = (geo?.verticalFov as number) ?? hFov;
      let padding = 1;

      // When SPICE boundary is available, compute tight-fitting FOV from the
      // actual boundary bounding box instead of the enriched symmetric version.
      // This ensures the polygon fills the PiP viewport.
      if (fovBoundary && fovBoundary.bounds.length >= 1) {
        const tight = this.computeTightFov(fovBoundary);
        hFov = tight.hFov;
        vFov = tight.vFov;
        this.fovCenterOffset = tight.centerOffset;
        padding = FOV_PADDING;
      }

      // Use the instrument's actual FOV and aspect ratio
      this.instrAspect = hFov / vFov;
      this.camera.fov = vFov;
      this.camera.aspect = this.instrAspect;
      this.camera.updateProjectionMatrix();

      this._viewFov = [hFov, vFov];
      this._fov = [hFov / padding, vFov / padding];
      this.fovDiv.textContent = `${hFov.toPrecision(4)}°×${vFov.toPrecision(4)}°`;

      // Update border color from sensor frustum color
      const fc = geo?.frustumColor as number[] | undefined;
      let sensorHex = this.options.borderColor;
      if (fc) {
        sensorHex = '#' + new THREE.Color(fc[0], fc[1], fc[2]).getHexString();
        this.overlayDiv.style.borderColor = sensorHex;
        this.labelDiv.style.color = sensorHex;
      }

      this.color = sensorHex;
      this.labelDiv.textContent = sensor.body.name;

      if (fovBoundary) this.outline = this.computeOutline(fovBoundary, hFov, vFov);
    }
  }

  /**
   * Compute a tight-fitting FOV from SPICE boundary vectors.
   * Returns the angular bounding box extent and the centroid offset from boresight.
   */
  private computeTightFov(fov: FovBoundary): {
    hFov: number; vFov: number;
    centerOffset: [number, number];
  } {
    const bs = fov.boresight;
    const bsLen = Math.sqrt(bs[0] ** 2 + bs[1] ** 2 + bs[2] ** 2);
    const bsN = [bs[0] / bsLen, bs[1] / bsLen, bs[2] / bsLen];

    // CIRCLE FOVs have a single boundary vector — compute half-angle directly
    if (fov.shape === 'CIRCLE' && fov.bounds.length === 1) {
      const b = fov.bounds[0];
      const bLen = Math.sqrt(b[0] ** 2 + b[1] ** 2 + b[2] ** 2);
      const dot = (bsN[0] * b[0] + bsN[1] * b[1] + bsN[2] * b[2]) / bLen;
      const fullAngleDeg = 2 * Math.acos(Math.min(1, Math.abs(dot))) * 180 / Math.PI;
      const padded = fullAngleDeg * FOV_PADDING;
      return { hFov: padded, vFov: padded, centerOffset: [0, 0] };
    }

    const refUp = Math.abs(bsN[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const right = [
      refUp[1] * bsN[2] - refUp[2] * bsN[1],
      refUp[2] * bsN[0] - refUp[0] * bsN[2],
      refUp[0] * bsN[1] - refUp[1] * bsN[0],
    ];
    const rLen = Math.sqrt(right[0] ** 2 + right[1] ** 2 + right[2] ** 2);
    right[0] /= rLen; right[1] /= rLen; right[2] /= rLen;
    const up = [
      bsN[1] * right[2] - bsN[2] * right[1],
      bsN[2] * right[0] - bsN[0] * right[2],
      bsN[0] * right[1] - bsN[1] * right[0],
    ];

    let minH = Infinity, maxH = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const b of fov.bounds) {
      const along = b[0] * bsN[0] + b[1] * bsN[1] + b[2] * bsN[2];
      const hAngle = Math.atan2(b[0] * right[0] + b[1] * right[1] + b[2] * right[2], along);
      const vAngle = Math.atan2(b[0] * up[0] + b[1] * up[1] + b[2] * up[2], along);
      minH = Math.min(minH, hAngle); maxH = Math.max(maxH, hAngle);
      minV = Math.min(minV, vAngle); maxV = Math.max(maxV, vAngle);
    }

    const centerH = (minH + maxH) / 2;
    const centerV = (minV + maxV) / 2;
    const extentH = (maxH - minH) * 180 / Math.PI;
    const extentV = (maxV - minV) * 180 / Math.PI;
    // Add 5% padding
    return {
      hFov: extentH * FOV_PADDING,
      vFov: extentV * FOV_PADDING,
      centerOffset: [centerH, centerV],
    };
  }

  /**
   * Project FOV boundary vectors into normalized image space (u right, v down,
   * both 0..1 across the rendered instrument image). Boundary vectors are in
   * the instrument frame where boresight ≈ +Z; each is projected to the
   * tangent plane relative to the camera's FOV extent. Normalized coordinates
   * mean the outline is registered by the same image rect as the feed itself.
   */
  private computeOutline(fov: FovBoundary, hFovDeg: number, vFovDeg: number): FovOutline {
    const tanH = Math.tan((hFovDeg / 2) * Math.PI / 180);
    const tanV = Math.tan((vFovDeg / 2) * Math.PI / 180);

    // Build camera-convention orthonormal frame around boresight.
    // Must match THREE.js camera axes: right=+X, up=+Y when looking along boresight.
    // right = worldUp × boresight (not boresight × worldUp, which gives the opposite sign)
    const bs = fov.boresight;
    const bsLen = Math.sqrt(bs[0] ** 2 + bs[1] ** 2 + bs[2] ** 2);
    const bsN = [bs[0] / bsLen, bs[1] / bsLen, bs[2] / bsLen];
    const refUp = Math.abs(bsN[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    // right = refUp × bsN
    const right = [
      refUp[1] * bsN[2] - refUp[2] * bsN[1],
      refUp[2] * bsN[0] - refUp[0] * bsN[2],
      refUp[0] * bsN[1] - refUp[1] * bsN[0],
    ];
    const rLen = Math.sqrt(right[0] ** 2 + right[1] ** 2 + right[2] ** 2);
    right[0] /= rLen; right[1] /= rLen; right[2] /= rLen;
    // up = bsN × right
    const up = [
      bsN[1] * right[2] - bsN[2] * right[1],
      bsN[2] * right[0] - bsN[0] * right[2],
      bsN[0] * right[1] - bsN[1] * right[0],
    ];

    if (fov.shape === 'CIRCLE' && fov.bounds.length >= 1) {
      const b = fov.bounds[0];
      const bLen = Math.sqrt(b[0] ** 2 + b[1] ** 2 + b[2] ** 2);
      const dot = (bsN[0] * b[0] + bsN[1] * b[1] + bsN[2] * b[2]) / bLen;
      const t = Math.tan(Math.acos(Math.min(1, Math.abs(dot))));
      return { kind: 'ellipse', cx: 0.5, cy: 0.5, rx: t / tanH / 2, ry: t / tanV / 2 };
    }

    // POLYGON, RECTANGLE, ELLIPSE: project actual SPICE boundary corners,
    // offset by fovCenterOffset so the polygon centroid maps to image center.
    // For asymmetric FOVs (e.g. WAC single filter band), the polygon may not
    // fill the full image — that's correct, it shows the real sensor footprint.
    const tanCH = Math.tan(this.fovCenterOffset[0]);
    const tanCV = Math.tan(this.fovCenterOffset[1]);
    const points = fov.bounds.map((v): [number, number] => {
      const along = v[0] * bsN[0] + v[1] * bsN[1] + v[2] * bsN[2];
      const hComp = v[0] * right[0] + v[1] * right[1] + v[2] * right[2];
      const vComp = v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
      const ndcX = (hComp / along - tanCH) / tanH;
      const ndcY = (vComp / along - tanCV) / tanV;
      return [(ndcX + 1) / 2, (1 - ndcY) / 2];
    });
    return { kind: 'polygon', points };
  }
  /**
   * Update the instrument camera position and orientation.
   * Call this during renderFrame, after sensor frustums have been updated.
   */
  update(
    et: number,
    scaleFactor: number,
    resolvePos: (name: string, et: number) => [number, number, number],
    targetBody?: Body,
    spiceRotation?: number[],
    /** Where `spiceRotation` came from: SPICE, or the host-supplied spacecraft attitude and the catalog mounting. */
    rotationSource: 'spice' | 'attitude' = 'spice',
  ): void {
    if (!this.sensor || !this._active) return;
    this._unavailableReason = null;

    // Position: same as the sensor frustum (already in scene coordinates)
    this.camera.position.copy(this.sensor.position);

    if (spiceRotation && spiceRotation.length === 9) {
      // SPICE pxform returns instrument→inertial rotation matrix (row-major).
      // Columns of R give instrument axes in the inertial frame:
      //   col0 = inst +X (right), col1 = inst +Y (up), col2 = inst +Z (boresight)
      const r = spiceRotation;
      const boresight = new THREE.Vector3(r[2], r[5], r[8]).normalize();

      // Offset the look direction to the FOV centroid for asymmetric boundaries.
      // fovCenterOffset is [hAngle, vAngle] in radians relative to boresight.
      const [cH, cV] = this.fovCenterOffset;
      if (cH !== 0 || cV !== 0) {
        const instRight = new THREE.Vector3(r[0], r[3], r[6]);
        const instUp = new THREE.Vector3(r[1], r[4], r[7]);
        boresight.addScaledVector(instRight, Math.tan(cH));
        boresight.addScaledVector(instUp, Math.tan(cV));
        boresight.normalize();
      }

      _lookTarget.copy(this.camera.position).addScaledVector(boresight, 0.001);
      this._pointing = rotationSource;
      // Up = instrument +Y in J2000 = 2nd column of R
      this.camera.up.set(r[1], r[4], r[7]).normalize();
      this.camera.lookAt(_lookTarget);
    } else if (targetBody) {
      // Fallback: point toward the target body
      const tPos = resolvePos(targetBody.name, et);
      _lookTarget.set(
        tPos[0] * scaleFactor,
        tPos[1] * scaleFactor,
        tPos[2] * scaleFactor,
      );
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(_lookTarget);
      this._pointing = 'target';
    } else {
      this._pointing = 'none';
    }

  }

  /**
   * Lay the feed out for this frame. Returns false when there is nothing to
   * show — no sensor, or a surface that is detached, empty or clipped away —
   * so the caller can skip pose, atmosphere and draw work entirely: a
   * minimized or closed window costs nothing.
   */
  measure(canvas: HTMLCanvasElement): boolean {
    this.layout = null;
    this.overlayDiv.style.display = this._active && !this.surface && !this.fullScreen ? 'block' : 'none';
    if (!this._active) return false;
    const origin = canvas.getBoundingClientRect();
    let box: Rect;
    let visible: Rect | null;
    if (this.fullScreen) {
      box = { x: 0, y: 0, w: canvas.clientWidth, h: canvas.clientHeight };
      visible = box;
    } else {
      const surface = this.presentSurface;
      if (!surface.isConnected) return false;
      const r = surface.getBoundingClientRect();
      box = { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
      visible = visibleRect(surface, origin);
    }
    if (box.w < 2 || box.h < 2) return false;
    const fit = fitImageRect(box.w, box.h, this.instrAspect);
    const image = { x: box.x + fit.x, y: box.y + fit.y, w: fit.w, h: fit.h };
    const clip = visible && intersectRect(image, visible);
    if (!clip) return false;
    this.layout = { surface: box, fit, image, clip };
    return true;
  }

  /**
   * Render the feed laid out by `measure()`.
   *
   * Composition (#192): the main canvas is a background element under the
   * shell's DOM panels, so a scissored inset there cannot take part in panel
   * z-order. Instead the feed is drawn into the main drawing buffer at exactly
   * the pixels its surface covers — a region the opaque surface hides anyway —
   * and copied into the surface's 2D canvas in the same task, before the
   * buffer is presented. One renderer and one set of GPU resources; the copy
   * is a canvas-to-canvas `drawImage`, not a `readPixels` stall. The surface is
   * then an ordinary DOM element that stacks, clips and blurs like any other.
   *
   * Saves and restores ALL renderer state to prevent side effects on the main render.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    const layout = this.layout;
    if (!layout) return;
    const canvas = renderer.domElement;
    const pr = renderer.getPixelRatio();
    const cssH = canvas.height / pr;
    const { image, clip } = layout;
    // The visible part of the image in device pixels, top-left origin. Rounded
    // once so the GL scissor and the 2D copy cover the same pixels exactly.
    const x0 = Math.round(clip.x * pr), y0 = Math.round(clip.y * pr);
    const x1 = Math.round((clip.x + clip.w) * pr), y1 = Math.round((clip.y + clip.h) * pr);
    if (x1 <= x0 || y1 <= y0) return;

    // Save ALL renderer state
    renderer.getViewport(_savedViewport);
    renderer.getScissor(_savedScissor);
    const savedScissorTest = renderer.getScissorTest();
    renderer.getClearColor(_savedClearColor);
    const savedClearAlpha = renderer.getClearAlpha();
    const savedAutoClear = renderer.autoClear;

    try {
      renderer.setScissorTest(true);
      renderer.setClearColor(0x000000, 1);
      renderer.autoClear = false;
      if (this.fullScreen) {
        // Letterbox/pillarbox bars around the image. A windowed surface paints
        // its own bars, so the main buffer is only ever touched under the image.
        renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
        renderer.setScissor(0, 0, canvas.clientWidth, canvas.clientHeight);
        renderer.clear(true, true, true);
      }
      // Three.js setViewport/setScissor take CSS pixels (bottom-left origin)
      // and multiply by pixelRatio internally.
      renderer.setViewport(image.x, cssH - image.y - image.h, image.w, image.h);
      renderer.setScissor(x0 / pr, (canvas.height - y1) / pr, (x1 - x0) / pr, (y1 - y0) / pr);
      renderer.clear(true, true, true);

      // Dynamic near/far for the instrument camera
      const camDist = _lookTarget.distanceTo(this.camera.position);
      if (camDist > 0) {
        this.camera.near = Math.max(1e-12, camDist * 1e-4);
        this.camera.far = Math.max(1e3, camDist * 1e4);
        this.camera.updateProjectionMatrix();
      }

      // Render only bodies + models (layers 0, 1). Layer 2 = overlays
      // (trajectory lines, sensor frustums, event markers) are excluded.
      this.camera.layers.set(0);
      this.camera.layers.enable(1);
      renderer.render(scene, this.camera);
    } finally {
      // Restore ALL renderer state
      renderer.setViewport(_savedViewport);
      renderer.setScissor(_savedScissor);
      renderer.setScissorTest(savedScissorTest);
      renderer.setClearColor(_savedClearColor, savedClearAlpha);
      renderer.autoClear = savedAutoClear;
    }

    if (!this.fullScreen) this.present(canvas, pr, x0, y0, x1, y1);
  }

  /** Copy the just-rendered pixels into the surface and draw the FOV outline over them. */
  private present(canvas: HTMLCanvasElement, pr: number, x0: number, y0: number, x1: number, y1: number): void {
    const { surface: box, fit } = this.layout!;
    const surface = this.presentSurface;
    const w = Math.round(box.w * pr), h = Math.round(box.h * pr);
    if (surface.width !== w) surface.width = w;
    if (surface.height !== h) surface.height = h;
    const ctx = surface.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const ox = Math.round(box.x * pr), oy = Math.round(box.y * pr);
    ctx.drawImage(canvas, x0, y0, x1 - x0, y1 - y0, x0 - ox, y0 - oy, x1 - x0, y1 - y0);

    // One image-space → surface-space transform for the outline: the same
    // fitted rect the feed was rendered into.
    const outline = this.outline;
    if (!outline) return;
    ctx.setTransform(pr * fit.w, 0, 0, pr * fit.h, pr * fit.x, pr * fit.y);
    ctx.beginPath();
    if (outline.kind === 'ellipse') {
      ctx.ellipse(outline.cx, outline.cy, outline.rx, outline.ry, 0, 0, 2 * Math.PI);
    } else {
      outline.points.forEach(([u, v], i) => (i ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
      ctx.closePath();
    }
    // Stroke in device pixels, not the stretched image space.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = this.color;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.5 * pr;
    ctx.stroke();
  }
  /** Reposition the overlay when canvas size changes. */
  onResize(): void {
    this.positionOverlay();
  }

  dispose(): void {
    this.overlayDiv.remove();
  }

  private positionOverlay(): void {
    const { width, height, marginX, marginY, corner } = this.options as Required<InstrumentViewOptions>;
    this.overlayDiv.style.width = `${width}px`;
    this.overlayDiv.style.height = `${height}px`;

    // Reset positions
    this.overlayDiv.style.top = '';
    this.overlayDiv.style.bottom = '';
    this.overlayDiv.style.left = '';
    this.overlayDiv.style.right = '';

    switch (corner) {
      case 'top-left':
        this.overlayDiv.style.top = `${marginY}px`;
        this.overlayDiv.style.left = `${marginX}px`;
        break;
      case 'top-right':
        this.overlayDiv.style.top = `${marginY}px`;
        this.overlayDiv.style.right = `${marginX}px`;
        break;
      case 'bottom-left':
        this.overlayDiv.style.bottom = `${marginY}px`;
        this.overlayDiv.style.left = `${marginX}px`;
        break;
      case 'bottom-right':
        this.overlayDiv.style.bottom = `${marginY}px`;
        this.overlayDiv.style.right = `${marginX}px`;
        break;
    }
  }
}
