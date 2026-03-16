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
export class InstrumentView {
  readonly camera: THREE.PerspectiveCamera;
  private sensor: SensorFrustum | null = null;
  private readonly options: Required<InstrumentViewOptions>;
  private readonly overlayDiv: HTMLDivElement;
  private readonly labelDiv: HTMLDivElement;
  private readonly fovDiv: HTMLDivElement;
  private _active = false;
  /** Instrument native aspect ratio (hFov / vFov). Used for letterboxing. */
  private instrAspect = 1;

  constructor(
    private readonly canvasParent: HTMLElement,
    options: InstrumentViewOptions = {},
  ) {
    this.options = {
      width: options.width ?? 320,
      height: options.height ?? 240,
      margin: options.margin ?? 16,
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

    canvasParent.appendChild(this.overlayDiv);
  }

  get active(): boolean { return this._active; }
  get sensorName(): string | undefined { return this.sensor?.body.name; }

  /** Set the active instrument sensor (or null to deactivate). */
  setSensor(sensor: SensorFrustum | null): void {
    this.sensor = sensor;
    this._active = sensor != null;
    this.overlayDiv.style.display = this._active ? 'block' : 'none';

    if (sensor) {
      const geo = sensor.body.geometryData as Record<string, unknown> | undefined;
      const hFov = (geo?.horizontalFov as number) ?? 10;
      const vFov = (geo?.verticalFov as number) ?? hFov;

      // Use the instrument's actual FOV and aspect ratio
      this.instrAspect = hFov / vFov;
      this.camera.fov = vFov;
      this.camera.aspect = this.instrAspect;
      this.camera.updateProjectionMatrix();

      this.fovDiv.textContent = `${hFov}°×${vFov}°`;

      // Update border color from sensor frustum color
      const fc = geo?.frustumColor as number[] | undefined;
      if (fc) {
        const hex = '#' + new THREE.Color(fc[0], fc[1], fc[2]).getHexString();
        this.overlayDiv.style.borderColor = hex;
        this.labelDiv.style.color = hex;
      }

      this.labelDiv.textContent = sensor.body.name;
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
      // SPICE pxform returns instrument→J2000 rotation matrix (row-major).
      // Boresight is instrument +Z → 3rd column of R in J2000.
      const r = spiceRotation;
      const boresight = new THREE.Vector3(r[2], r[5], r[8]).normalize();
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

    // Three.js setViewport/setScissor expect CSS logical pixels (NOT device pixels).
    // They multiply by pixelRatio internally.
    const canvas = renderer.domElement;
    const pipW = this.options.width;
    const pipH = this.options.height;
    const m = this.options.margin;
    const [pipX, pipY] = this.viewportXY(canvas.clientWidth, canvas.clientHeight, pipW, pipH, m);

    // Fit the instrument's native aspect ratio inside the PiP rectangle (letterbox/pillarbox)
    const pipAspect = pipW / pipH;
    let vw: number, vh: number, vx: number, vy: number;
    if (this.instrAspect > pipAspect) {
      // Instrument is wider than PiP → fit width, pillarbox (bars top/bottom)
      vw = pipW;
      vh = pipW / this.instrAspect;
      vx = pipX;
      vy = pipY + (pipH - vh) / 2;
    } else {
      // Instrument is taller than PiP → fit height, letterbox (bars left/right)
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
      renderer.setClearColor(0x060612, 1);
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
    const { width, height, margin, corner } = this.options;
    this.overlayDiv.style.width = `${width}px`;
    this.overlayDiv.style.height = `${height}px`;

    // Reset positions
    this.overlayDiv.style.top = '';
    this.overlayDiv.style.bottom = '';
    this.overlayDiv.style.left = '';
    this.overlayDiv.style.right = '';

    switch (corner) {
      case 'top-left':
        this.overlayDiv.style.top = `${margin}px`;
        this.overlayDiv.style.left = `${margin}px`;
        break;
      case 'top-right':
        this.overlayDiv.style.top = `${margin}px`;
        this.overlayDiv.style.right = `${margin}px`;
        break;
      case 'bottom-left':
        this.overlayDiv.style.bottom = `${margin}px`;
        this.overlayDiv.style.left = `${margin}px`;
        break;
      case 'bottom-right':
        this.overlayDiv.style.bottom = `${margin}px`;
        this.overlayDiv.style.right = `${margin}px`;
        break;
    }
  }

  /** Compute the GL viewport origin (bottom-left) from the corner setting. */
  private viewportXY(
    canvasW: number, canvasH: number,
    w: number, h: number, m: number,
  ): [number, number] {
    switch (this.options.corner) {
      case 'top-left':
        return [m, canvasH - m - h];
      case 'top-right':
        return [canvasW - m - w, canvasH - m - h];
      case 'bottom-left':
        return [m, m];
      case 'bottom-right':
        return [canvasW - m - w, m];
    }
  }
}
