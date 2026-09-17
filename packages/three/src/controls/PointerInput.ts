/**
 * Pointer-event plumbing shared by `CameraController` and the camera modes that
 * read input directly.
 *
 * The controls used to bind `mousedown` / `mousemove` / `mouseup`, which a touch
 * device never synthesizes for a drag — a phone could look at the scene and not
 * navigate it. Everything now arrives as a `PointerEvent`, with two paths:
 *
 * - **Mouse and pen** keep the old behaviour exactly: button-filtered drags with
 *   per-event pixel deltas, the drag surviving a pointer that leaves the canvas.
 * - **Touch** goes through `TouchGestureTracker`, which turns raw contacts into
 *   one-finger drag and two-finger pinch/pan deltas.
 *
 * `pointerType` is what separates them, so a pen behaves like a mouse rather
 * than like a finger.
 */

/** A pointer position — the part of `PointerEvent` the gesture math needs. */
export interface PointerSample {
  pointerId: number;
  clientX: number;
  clientY: number;
}

/** Callbacks for the touch half of the input. All deltas are in CSS pixels. */
export interface TouchGestureHandlers {
  /** One-finger drag, relative to the previous move. */
  onDrag?(dx: number, dy: number): void;
  /**
   * Two-finger gesture, relative to the previous move: `scale` is the pinch
   * ratio (>1 = fingers spreading = zoom in), `dx`/`dy` the centroid movement.
   */
  onPinch?(scale: number, dx: number, dy: number): void;
  /**
   * The number of active fingers changed, with the gesture's new anchor in
   * client coordinates — the finger itself for one, the centroid for two.
   * Emitted before the first delta of the new count, so a consumer can drop the
   * state that belonged to the old gesture and anchor the new one. A count of 0
   * (anchor 0, 0) means every finger has lifted.
   */
  onCountChange?(count: number, x: number, y: number): void;
}

/**
 * Turns raw touch contacts into one- and two-finger gestures.
 *
 * Kept free of the DOM so the gesture math is testable without a browser:
 * `attachPointerInput` feeds it `PointerEvent`s, but any `PointerSample` will do.
 * A third finger is tracked but ignored — the gesture stays two-fingered until
 * the count drops back, which avoids a wild jump when a palm grazes the glass.
 */
export class TouchGestureTracker {
  private readonly points = new Map<number, { x: number; y: number }>();
  /** Previous centroid and spread, for the two-finger deltas. */
  private prevX = 0;
  private prevY = 0;
  private prevDist = 0;

  constructor(private readonly handlers: TouchGestureHandlers) {}

  get activeCount(): number { return this.points.size; }

  down(e: PointerSample): void {
    this.points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.resetGesture();
    this.handlers.onCountChange?.(this.points.size, this.prevX, this.prevY);
  }

  move(e: PointerSample): void {
    const p = this.points.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;

    if (this.points.size === 1) {
      const dx = e.clientX - this.prevX;
      const dy = e.clientY - this.prevY;
      this.prevX = e.clientX;
      this.prevY = e.clientY;
      if (dx !== 0 || dy !== 0) this.handlers.onDrag?.(dx, dy);
      return;
    }

    const [a, b] = [...this.points.values()];
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    // A pinch of zero spread has no ratio to report; treat it as pan-only.
    const scale = this.prevDist > 0 && dist > 0 ? dist / this.prevDist : 1;
    const dx = cx - this.prevX;
    const dy = cy - this.prevY;
    this.prevX = cx;
    this.prevY = cy;
    this.prevDist = dist;
    if (scale !== 1 || dx !== 0 || dy !== 0) this.handlers.onPinch?.(scale, dx, dy);
  }

  up(e: PointerSample): void {
    if (!this.points.delete(e.pointerId)) return;
    this.resetGesture();
    this.handlers.onCountChange?.(this.points.size, this.prevX, this.prevY);
  }

  /** Drop every contact — a `pointercancel`, or the window losing focus. */
  cancel(): void {
    if (this.points.size === 0) return;
    this.points.clear();
    this.resetGesture();
    this.handlers.onCountChange?.(0, 0, 0);
  }

  /**
   * Re-seed the centroid and spread from the fingers that are down now, so the
   * first move after a finger lands or lifts reports a delta against the new
   * arrangement rather than a jump from the old one.
   */
  private resetGesture(): void {
    const pts = [...this.points.values()];
    if (pts.length === 1) {
      this.prevX = pts[0].x;
      this.prevY = pts[0].y;
      this.prevDist = 0;
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      this.prevX = (a.x + b.x) / 2;
      this.prevY = (a.y + b.y) / 2;
      this.prevDist = Math.hypot(a.x - b.x, a.y - b.y);
    } else {
      this.prevX = 0;
      this.prevY = 0;
      this.prevDist = 0;
    }
  }
}

/**
 * A pinch expressed as the `deltaY` an equivalent wheel gesture would carry, so
 * a mode can run its existing wheel curve instead of growing a second
 * sensitivity to keep in step.
 *
 * `scale` > 1 (fingers spreading) means zoom in, which is a negative `deltaY`.
 * The 400 matches a pinch that doubles the finger spread to roughly four wheel
 * notches of 100, which is about what a trackpad pinch produces for the same
 * hand movement.
 */
export function pinchToWheelDelta(scale: number): number {
  return -Math.log2(scale) * 400;
}

/** Handlers for `attachPointerInput`. */
export interface PointerInputSpec extends TouchGestureHandlers {
  /**
   * A mouse or pen button went down on the canvas. Runs in the capture phase,
   * so a consumer can `stopPropagation()` before the orbit controls see it.
   */
  onButtonDown?(e: PointerEvent): void;
  /** Mouse or pen movement while a button is held, as a per-event pixel delta. */
  onButtonDrag?(dx: number, dy: number, e: PointerEvent): void;
  /** A mouse or pen button was released (anywhere, not just over the canvas). */
  onButtonUp?(e: PointerEvent): void;
  /** The window lost focus, or a pointer was cancelled — drop all drag state. */
  onCancel?(): void;
  /** Suppress the native context menu on the canvas (default: false). */
  preventContextMenu?: boolean;
}

/**
 * Bind one set of pointer listeners to `canvas` and return the detach function.
 *
 * `pointerdown` is bound on the canvas in the capture phase (matching the
 * `mousedown` listeners this replaces), while move and up go on the window so a
 * drag that leaves the canvas still tracks — the same reach the old
 * `window.addEventListener('mousemove', …)` had.
 */
export function attachPointerInput(canvas: HTMLElement, spec: PointerInputSpec): () => void {
  const touch = new TouchGestureTracker(spec);
  /** Mouse/pen buttons currently held, so a drag needs no per-mode bookkeeping. */
  const held = new Set<number>();
  let prevX = 0;
  let prevY = 0;

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') { touch.down(e); return; }
    held.add(e.pointerId);
    prevX = e.clientX;
    prevY = e.clientY;
    spec.onButtonDown?.(e);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') { touch.move(e); return; }
    if (!held.has(e.pointerId)) return;
    const dx = e.clientX - prevX;
    const dy = e.clientY - prevY;
    prevX = e.clientX;
    prevY = e.clientY;
    spec.onButtonDrag?.(dx, dy, e);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === 'touch') { touch.up(e); return; }
    held.delete(e.pointerId);
    spec.onButtonUp?.(e);
  };

  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerType === 'touch') { touch.cancel(); return; }
    held.delete(e.pointerId);
    spec.onButtonUp?.(e);
  };

  const onBlur = () => {
    held.clear();
    touch.cancel();
    spec.onCancel?.();
  };

  const onContextMenu = (e: Event) => e.preventDefault();

  canvas.addEventListener('pointerdown', onPointerDown, { capture: true });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('blur', onBlur);
  if (spec.preventContextMenu) canvas.addEventListener('contextmenu', onContextMenu);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('blur', onBlur);
    if (spec.preventContextMenu) canvas.removeEventListener('contextmenu', onContextMenu);
  };
}
