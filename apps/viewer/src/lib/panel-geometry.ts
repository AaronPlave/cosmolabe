/**
 * Geometry for floating instrument panels.
 *
 * Plain functions over rectangles, deliberately outside the Svelte state module:
 * the interesting part of dragging a panel is not the pointer plumbing but the
 * constraints — a panel must not be dragged off-screen where it cannot be
 * dragged back, and must not be resized smaller than its own header. Those are
 * worth testing without a browser.
 *
 * Coordinates are viewport pixels, matching `position: fixed`.
 */

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Smallest a panel may be resized to: narrower than this and its header wraps. */
export const MIN_PANEL_W = 220;
export const MIN_PANEL_H = 120;

/**
 * How much of a panel must stay on screen. Enough of the header to grab and to
 * read the title — a panel dragged to a corner stays recoverable by dragging,
 * with no "reset layout" command needed to rescue it.
 */
export const KEEP_VISIBLE_X = 120;
export const KEEP_VISIBLE_Y = 28;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Constrains a panel's position so a grabbable strip of it stays on screen.
 *
 * Size is clamped first, because a panel wider than the viewport would
 * otherwise have no legal position at all.
 */
export function clampFloat(rect: FloatRect, viewport: Viewport): FloatRect {
  const w = clamp(rect.w, MIN_PANEL_W, Math.max(MIN_PANEL_W, viewport.width));
  const h = clamp(rect.h, MIN_PANEL_H, Math.max(MIN_PANEL_H, viewport.height));
  // Left of zero is allowed, up to the point where too little is left to grab;
  // above zero is not, because a header dragged above the top edge cannot be
  // grabbed at all.
  const minX = Math.min(0, viewport.width - w) - Math.max(0, w - KEEP_VISIBLE_X);
  const maxX = Math.max(0, viewport.width - KEEP_VISIBLE_X);
  const maxY = Math.max(0, viewport.height - KEEP_VISIBLE_Y);
  return { x: clamp(rect.x, minX, maxX), y: clamp(rect.y, 0, maxY), w, h };
}

/** Applies a drag delta to the rect a gesture started from. */
export function moveFloat(base: FloatRect, dx: number, dy: number, viewport: Viewport): FloatRect {
  return clampFloat({ ...base, x: base.x + dx, y: base.y + dy }, viewport);
}

/**
 * Applies a resize delta from the bottom-right grip.
 *
 * The origin stays put, so the panel grows away from its header and the handle
 * the user is holding stays under the pointer.
 */
export function resizeFloat(base: FloatRect, dx: number, dy: number, viewport: Viewport): FloatRect {
  return clampFloat({ ...base, w: base.w + dx, h: base.h + dy }, viewport);
}

/**
 * The rect a panel should float at when it is dragged out of a dock: exactly
 * where it already is, so the gesture looks like picking the panel up rather
 * than like it jumping to a new place and then moving.
 */
export function floatFromDocked(box: FloatRect, viewport: Viewport): FloatRect {
  return clampFloat(box, viewport);
}
