import * as THREE from 'three';
import type { SensorFrustum } from './SensorFrustum.js';
import type { Body } from '@spicecraft/core';

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
}

const _savedViewport = new THREE.Vector4();
const _savedScissor = new THREE.Vector4();
const _savedClearColor = new THREE.Color();
const _lookTarget = new THREE.Vector3();

/**
 * Renders a picture-in-picture view from an instrument's perspective.
 * Places a camera at the instrument position, oriented along its boresight,
 * and renders into a viewport corner of the main canvas.
 */
/** FOV boundary data for drawing the actual sensor footprint outline. */
export interface FovBoundary {
  shape: string;               // 'POLYGON' | 'RECTANGLE' | 'CIRCLE' | 'ELLIPSE'
  boresight: [number, number, number];
  bounds: [number, number, number][];
}

export class InstrumentView {
  readonly camera: THREE.PerspectiveCamera;
  private sensor: SensorFrustum | null = null;
  private readonly options: Required<InstrumentViewOptions>;
  private readonly overlayDiv: HTMLDivElement;
  private readonly labelDiv: HTMLDivElement;
  private readonly fovDiv: HTMLDivElement;
  private readonly fovSvg: SVGSVGElement;
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
    };

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

    // SVG overlay for drawing the actual FOV boundary shape
    this.fovSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.fovSvg.style.cssText = `
      position: absolute; inset: 0; width: 100%; height: 100%;
      pointer-events: none; overflow: visible;
    `;
    this.overlayDiv.appendChild(this.fovSvg);

    canvasParent.appendChild(this.overlayDiv);
  }

  get active(): boolean { return this._active; }
  get sensorName(): string | undefined { return this.sensor?.body.name; }

  /** When true, render() fills the main viewport instead of the PiP corner. */
  fullScreen = false;

  /** Set the active instrument sensor (or null to deactivate). */
  setSensor(sensor: SensorFrustum | null, fovBoundary?: FovBoundary): void {
    this.sensor = sensor;
    this._active = sensor != null;
    this.overlayDiv.style.display = this._active ? 'block' : 'none';
    this.fovSvg.innerHTML = '';
    this.fovCenterOffset = [0, 0];

    if (sensor) {
      const geo = sensor.body.geometryData as Record<string, unknown> | undefined;
      let hFov = (geo?.horizontalFov as number) ?? 10;
      let vFov = (geo?.verticalFov as number) ?? hFov;

      // When SPICE boundary is available, compute tight-fitting FOV from the
      // actual boundary bounding box instead of the enriched symmetric version.
      // This ensures the polygon fills the PiP viewport.
      if (fovBoundary && fovBoundary.bounds.length >= 1) {
        const tight = this.computeTightFov(fovBoundary);
        hFov = tight.hFov;
        vFov = tight.vFov;
        this.fovCenterOffset = tight.centerOffset;
      }

      // Use the instrument's actual FOV and aspect ratio
      this.instrAspect = hFov / vFov;
      this.camera.fov = vFov;
      this.camera.aspect = this.instrAspect;
      this.camera.updateProjectionMatrix();

      this.fovDiv.textContent = `${hFov.toPrecision(4)}°×${vFov.toPrecision(4)}°`;

      // Update border color from sensor frustum color
      const fc = geo?.frustumColor as number[] | undefined;
      let sensorHex = this.options.borderColor;
      if (fc) {
        sensorHex = '#' + new THREE.Color(fc[0], fc[1], fc[2]).getHexString();
        this.overlayDiv.style.borderColor = sensorHex;
        this.labelDiv.style.color = sensorHex;
      }

      this.labelDiv.textContent = sensor.body.name;

      // Draw actual FOV boundary shape on the PiP overlay
      if (fovBoundary) {
        this.drawFovBoundary(fovBoundary, hFov, vFov, sensorHex);
      }
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
      const padded = fullAngleDeg * 1.05;
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
      hFov: extentH * 1.05,
      vFov: extentV * 1.05,
      centerOffset: [centerH, centerV],
    };
  }

  /**
   * Project FOV boundary vectors onto the PiP viewport and draw as SVG.
   * Boundary vectors are in the instrument frame where boresight ≈ +Z.
   * We project each vector to 2D using the tangent-plane projection
   * relative to the camera's FOV extent, accounting for letterbox/pillarbox.
   */
  private drawFovBoundary(
    fov: FovBoundary,
    hFovDeg: number,
    vFovDeg: number,
    color: string,
  ): void {
    const pipW = this.options.width;
    const pipH = this.options.height;
    const pipAspect = pipW / pipH;
    const tanH = Math.tan((hFovDeg / 2) * Math.PI / 180);
    const tanV = Math.tan((vFovDeg / 2) * Math.PI / 180);

    // Compute the letterboxed viewport sub-region (mirrors render() logic)
    let vw: number, vh: number, ox: number, oy: number;
    if (this.instrAspect > pipAspect) {
      // Wider than PiP → fit width, bars top/bottom
      vw = pipW; vh = pipW / this.instrAspect;
      ox = 0; oy = (pipH - vh) / 2;
    } else {
      // Taller than PiP → fit height, bars left/right
      vh = pipH; vw = pipH * this.instrAspect;
      ox = (pipW - vw) / 2; oy = 0;
    }

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

    // Project boundary vector to pixel coordinates within the letterboxed sub-region.
    // Offset by fovCenterOffset so the polygon centroid maps to viewport center.
    const [cH, cV] = this.fovCenterOffset;
    const tanCH = Math.tan(cH); // horizontal center offset in tangent space
    const tanCV = Math.tan(cV); // vertical center offset in tangent space
    const projectToPixel = (v: [number, number, number]): [number, number] => {
      const along = v[0] * bsN[0] + v[1] * bsN[1] + v[2] * bsN[2];
      const hComp = v[0] * right[0] + v[1] * right[1] + v[2] * right[2];
      const vComp = v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
      // Tangent-space position relative to FOV center (not boresight)
      const ndcX = (hComp / along - tanCH) / tanH;
      const ndcY = (vComp / along - tanCV) / tanV;
      // Map to pixels within the letterboxed viewport, then offset to full PiP coords
      return [ox + (ndcX + 1) / 2 * vw, oy + (1 - ndcY) / 2 * vh];
    };

    this.fovSvg.setAttribute('viewBox', `0 0 ${pipW} ${pipH}`);

    if (fov.shape === 'CIRCLE' && fov.bounds.length >= 1) {
      const b = fov.bounds[0];
      const bLen = Math.sqrt(b[0] ** 2 + b[1] ** 2 + b[2] ** 2);
      const dot = (bsN[0] * b[0] + bsN[1] * b[1] + bsN[2] * b[2]) / bLen;
      const halfAngleRad = Math.acos(Math.min(1, Math.abs(dot)));
      // Radius in pixels within the letterboxed viewport
      const radiusPxH = (Math.tan(halfAngleRad) / tanH) * (vw / 2);
      const radiusPxV = (Math.tan(halfAngleRad) / tanV) * (vh / 2);
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      circle.setAttribute('cx', `${ox + vw / 2}`);
      circle.setAttribute('cy', `${oy + vh / 2}`);
      circle.setAttribute('rx', `${radiusPxH}`);
      circle.setAttribute('ry', `${radiusPxV}`);
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', color);
      circle.setAttribute('stroke-width', '1.5');
      circle.setAttribute('stroke-opacity', '0.7');
      this.fovSvg.appendChild(circle);
    } else {
      // POLYGON, RECTANGLE, ELLIPSE: project actual SPICE boundary corners.
      // For asymmetric FOVs (e.g. WAC single filter band), the polygon may not
      // fill the full viewport — that's correct, it shows the real sensor footprint.
      const points = fov.bounds.map(b => projectToPixel(b as [number, number, number]));
      const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      polygon.setAttribute('points', points.map(([x, y]) => `${x},${y}`).join(' '));
      polygon.setAttribute('fill', 'none');
      polygon.setAttribute('stroke', color);
      polygon.setAttribute('stroke-width', '1.5');
      polygon.setAttribute('stroke-opacity', '0.7');
      this.fovSvg.appendChild(polygon);
    }
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
  ): void {
    if (!this.sensor || !this._active) return;

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
    }

  }

  /**
   * Render the instrument view into a corner viewport.
   * Saves and restores ALL renderer state to prevent side effects on the main render.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    if (!this._active) return;

    const canvas = renderer.domElement;
    let pipW: number, pipH: number, pipX: number, pipY: number;

    if (this.fullScreen) {
      // Full-screen mode: use entire canvas
      pipW = canvas.clientWidth;
      pipH = canvas.clientHeight;
      pipX = 0;
      pipY = 0;
      // Hide PiP overlay in full-screen
      this.overlayDiv.style.display = 'none';
    } else {
      // Three.js setViewport/setScissor expect CSS logical pixels (NOT device pixels).
      // They multiply by pixelRatio internally.
      pipW = this.options.width;
      pipH = this.options.height;
      const m = this.options.margin;
      [pipX, pipY] = this.viewportXY(canvas.clientWidth, canvas.clientHeight, pipW, pipH, m);
    }

    // Fit the instrument's native aspect ratio inside the rectangle (letterbox/pillarbox)
    const pipAspect = pipW / pipH;
    let vw: number, vh: number, vx: number, vy: number;
    if (this.instrAspect > pipAspect) {
      // Instrument is wider → fit width, bars top/bottom
      vw = pipW;
      vh = pipW / this.instrAspect;
      vx = pipX;
      vy = pipY + (pipH - vh) / 2;
    } else {
      // Instrument is taller → fit height, bars left/right
      vh = pipH;
      vw = pipH * this.instrAspect;
      vx = pipX + (pipW - vw) / 2;
      vy = pipY;
    }

    // Save ALL renderer state
    renderer.getViewport(_savedViewport);
    renderer.getScissor(_savedScissor);
    const savedScissorTest = renderer.getScissorTest();
    renderer.getClearColor(_savedClearColor);
    const savedClearAlpha = renderer.getClearAlpha();
    const savedAutoClear = renderer.autoClear;

    try {
      // Clear entire PiP region first (fills letterbox/pillarbox bars)
      renderer.setViewport(pipX, pipY, pipW, pipH);
      renderer.setScissorTest(true);
      renderer.setScissor(pipX, pipY, pipW, pipH);
      renderer.setClearColor(0x000000, 1);
      renderer.autoClear = false;
      renderer.clear(true, true, true);

      // Set viewport to the fitted instrument sub-region
      renderer.setViewport(vx, vy, vw, vh);
      renderer.setScissor(vx, vy, vw, vh);
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

  /** Compute the GL viewport origin (bottom-left) from the corner setting. */
  private viewportXY(
    canvasW: number, canvasH: number,
    w: number, h: number, _m: number,
  ): [number, number] {
    const mx = (this.options as Required<InstrumentViewOptions>).marginX;
    const my = (this.options as Required<InstrumentViewOptions>).marginY;
    switch (this.options.corner) {
      case 'top-left':
        return [mx, canvasH - my - h];
      case 'top-right':
        return [canvasW - mx - w, canvasH - my - h];
      case 'bottom-left':
        return [mx, my];
      case 'bottom-right':
        return [canvasW - mx - w, my];
    }
  }
}
