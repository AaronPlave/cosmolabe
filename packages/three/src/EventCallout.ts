/**
 * Anchored annotation for one scene event: a compact label box joined to the
 * event geometry by a thin leader. Placement is a small, deterministic
 * heuristic — default up/right, flipped or lengthened to stay on screen and
 * off nearby labels, bodies, and the owning trajectory — not a general
 * label-layout engine.
 */

import { EMPHASIS_FADE_MS } from './emphasisFade.js';

export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface CalloutObstacles {
  /** Label boxes; `weight` > 1 for labels that must stay readable (pinned). */
  rects: ReadonlyArray<ScreenRect & { weight?: number }>;
  /**
   * Projected trajectory polyline as [x0, y0, x1, y1, ...] in CSS pixels.
   * A NaN pair breaks the line (a point behind the camera or off screen).
   */
  path: ArrayLike<number>;
  /** Projected body silhouettes. */
  discs: ReadonlyArray<{ x: number; y: number; r: number }>;
  /** Host UI covering the canvas (panels, docks): as bad as off-screen. */
  blockers?: ReadonlyArray<ScreenRect>;
}

export type CalloutDirection = 'ne' | 'nw' | 'se' | 'sw' | 'e' | 'w';

export interface CalloutPlacement {
  key: string;
  direction: CalloutDirection;
  box: ScreenRect;
  /** Leader polyline: start (just outside the glyph), elbow, shoulder end. */
  leader: [number, number, number, number, number, number];
  cost: number;
}

export interface CalloutContent {
  /** First line is the title; the rest are detail lines (at most two). */
  lines: readonly string[];
  /** CSS color for the leader, anchor tick, and title glyph. */
  color: string;
  /** Interaction state of the annotated feature. */
  tone: 'preview' | 'selected';
  /** Which feature the callout points at. */
  feature: 'point' | 'boundary';
}

const EDGE_MARGIN = 6;
/** Leader starts this far from the anchor so it never overprints the glyph. */
const LEADER_GAP = 9;
const SHOULDER = 6;
const DIRECTION_COST: Record<CalloutDirection, number> = { ne: 0, nw: 3, se: 4, sw: 6, e: 9, w: 11 };
const REACHES = [16, 30, 48];
/** Keep the previous placement unless another is clearly better. */
const HYSTERESIS = 12;
/** Leader sits a step below the marker it annotates: scaffolding, not geometry. */
const LEADER_OPACITY = 0.64;

function overlapArea(a: ScreenRect, b: ScreenRect): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Candidate box + leader for one direction and reach. */
function candidate(
  ax: number,
  ay: number,
  width: number,
  height: number,
  direction: CalloutDirection,
  reach: number,
): Omit<CalloutPlacement, 'cost'> {
  const sx = direction === 'nw' || direction === 'sw' || direction === 'w' ? -1 : 1;
  const sy = direction === 'ne' || direction === 'nw' ? -1 : direction === 'e' || direction === 'w' ? 0 : 1;
  // Diagonal leaders run at 45°; horizontal ones are a single straight run.
  const ex = ax + sx * reach;
  const ey = ay + sy * reach;
  const shoulderX = ex + sx * SHOULDER;
  // The shoulder runs into the box corner nearest the anchor, along the
  // border row (bottom for boxes above, top for boxes below); side
  // placements meet the middle of the near edge.
  const y0 = sy < 0 ? ey - height + 1 : sy > 0 ? ey : ey - height / 2;
  const x0 = sx > 0 ? shoulderX : shoulderX - width;
  const length = Math.hypot(ex - ax, ey - ay) || 1;
  const gap = Math.min(LEADER_GAP, length * 0.5);
  return {
    key: `${direction}:${reach}`,
    direction,
    box: { x0, y0, x1: x0 + width, y1: y0 + height },
    leader: [ax + (ex - ax) / length * gap, ay + (ey - ay) / length * gap, ex, ey, shoulderX, ey],
  };
}

/**
 * Choose where a callout of `width` × `height` goes for an anchor at
 * (`ax`, `ay`). Lower cost wins; ties resolve toward up/right.
 */
export function chooseCalloutPlacement(
  ax: number,
  ay: number,
  width: number,
  height: number,
  viewport: { width: number; height: number },
  obstacles: CalloutObstacles,
  previousKey?: string | null,
): CalloutPlacement {
  let best: CalloutPlacement | null = null;
  for (const direction of Object.keys(DIRECTION_COST) as CalloutDirection[]) {
    for (let r = 0; r < REACHES.length; r++) {
      const reach = direction === 'e' || direction === 'w' ? REACHES[r] + 4 : REACHES[r];
      const c = candidate(ax, ay, width, height, direction, reach);
      const cost = placementCost(c, viewport, obstacles) + DIRECTION_COST[direction] + r * 5 -
        (c.key === previousKey ? HYSTERESIS : 0);
      if (!best || cost < best.cost) best = { ...c, cost };
    }
  }
  return best!;
}

function placementCost(
  c: Omit<CalloutPlacement, 'cost'>,
  viewport: { width: number; height: number },
  obstacles: CalloutObstacles,
): number {
  const { box } = c;
  let cost = 0;
  const overflow =
    Math.max(0, EDGE_MARGIN - box.x0) + Math.max(0, box.x1 - (viewport.width - EDGE_MARGIN)) +
    Math.max(0, EDGE_MARGIN - box.y0) + Math.max(0, box.y1 - (viewport.height - EDGE_MARGIN));
  if (overflow > 0) cost += 400 + overflow * 8;
  for (const blocker of obstacles.blockers ?? []) {
    const area = overlapArea(box, blocker);
    if (area > 0) cost += 400 + area * 0.5;
  }

  // Labels: overlapping a pinned (selected / involved) label costs most.
  const padded = { x0: box.x0 - 3, y0: box.y0 - 3, x1: box.x1 + 3, y1: box.y1 + 3 };
  for (const rect of obstacles.rects) {
    const area = overlapArea(padded, rect);
    if (area > 0) cost += 40 * (rect.weight ?? 1) + area * 0.25 * (rect.weight ?? 1);
  }

  // The owning trajectory: prefer boxes that leave the path readable. Clip
  // each polyline segment to the box so sparse samples still register.
  const path = obstacles.path;
  let covered = 0;
  for (let i = 0; i + 3 < path.length; i += 2) {
    covered += clippedLength(path[i], path[i + 1], path[i + 2], path[i + 3], padded);
  }
  cost += Math.min(covered, 400) * 0.6;

  // Bodies: text over a bright disc is harder to read than over empty sky.
  const boxArea = (box.x1 - box.x0) * (box.y1 - box.y0) || 1;
  for (const disc of obstacles.discs) {
    let inside = 0;
    for (let gx = 0; gx < 4; gx++) {
      for (let gy = 0; gy < 3; gy++) {
        const px = box.x0 + (gx + 0.5) * (box.x1 - box.x0) / 4;
        const py = box.y0 + (gy + 0.5) * (box.y1 - box.y0) / 3;
        if ((px - disc.x) ** 2 + (py - disc.y) ** 2 <= disc.r * disc.r) inside++;
      }
    }
    cost += inside / 12 * Math.min(boxArea, 6000) * 0.01;
  }
  return cost;
}

/** Length of segment a→b inside `rect` (Liang–Barsky); 0 for broken segments. */
function clippedLength(ax: number, ay: number, bx: number, by: number, rect: ScreenRect): number {
  if (!Number.isFinite(ax + ay + bx + by)) return 0;
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, ax - rect.x0], [dx, rect.x1 - ax], [-dy, ay - rect.y0], [dy, rect.y1 - ay],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return 0;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return 0;
    }
  }
  return (t1 - t0) * Math.hypot(dx, dy);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** DOM half: one box + one leader, positioned in CSS pixels over the canvas. */
export class EventCallout {
  private readonly box: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly leader: SVGPolylineElement;
  private readonly tick: SVGCircleElement;
  private content: CalloutContent | null = null;
  private contentKey = '';
  private size: { width: number; height: number } | null = null;
  private previousKey: string | null = null;
  private lastTransform = '';
  private lastPoints = '';
  private shown = false;
  private direction: CalloutDirection | null = null;

  constructor(container: HTMLElement) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    Object.assign(this.svg.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none', overflow: 'visible', display: 'none',
    });
    this.leader = document.createElementNS(SVG_NS, 'polyline');
    this.leader.setAttribute('fill', 'none');
    this.leader.setAttribute('stroke-width', '1');
    this.leader.setAttribute('stroke-linejoin', 'round');
    this.leader.setAttribute('stroke-opacity', String(LEADER_OPACITY));
    this.tick = document.createElementNS(SVG_NS, 'circle');
    this.tick.setAttribute('r', '1.4');
    this.tick.setAttribute('fill-opacity', '0.9');
    this.svg.append(this.leader, this.tick);

    this.box = document.createElement('div');
    this.box.className = 'cosmolabe-event-callout';
    Object.assign(this.box.style, {
      position: 'absolute', left: '0', top: '0', display: 'none', pointerEvents: 'none',
      padding: '4px 8px 5px', borderRadius: '2px',
      // Neutral and quiet: the glyph and leader carry event color and state.
      border: '1px solid rgba(190, 206, 216, 0.1)',
      background: 'rgba(9, 13, 18, 0.8)',
      whiteSpace: 'nowrap', willChange: 'transform',
    });
    container.append(this.svg, this.box);
  }

  setContent(content: CalloutContent | null): void {
    const key = content ? JSON.stringify(content) : '';
    if (key === this.contentKey) return;
    this.fadeOut();
    this.contentKey = key;
    this.content = content;
    this.size = null;
    this.previousKey = null;
    this.box.replaceChildren();
    if (!content) return;
    const [title, ...details] = content.lines;
    const titleRow = document.createElement('div');
    Object.assign(titleRow.style, {
      display: 'flex', alignItems: 'center', gap: '5px',
      font: '550 11px/15px var(--font-sans, system-ui, sans-serif)',
      color: '#e4ebef', letterSpacing: '0.01em',
    });
    titleRow.append(this.glyph(content), document.createTextNode(title ?? ''));
    this.box.append(titleRow);
    details.slice(0, 2).forEach((line, i) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        font: '400 10px/14px var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
        fontVariantNumeric: 'tabular-nums',
        color: i === 0 ? '#a9b8c1' : '#7f909a',
        paddingLeft: '13px',
      });
      row.textContent = line;
      this.box.append(row);
    });
    this.leader.setAttribute('stroke', content.color);
    this.tick.setAttribute('fill', content.color);
  }

  /**
   * Place the callout for an anchor in CSS pixels, or hide it with `null`.
   * Returns the occupied box so labels can yield to it.
   */
  update(
    anchor: { x: number; y: number } | null,
    viewport: { width: number; height: number },
    obstacles: CalloutObstacles,
  ): ScreenRect | null {
    // A spatial annotation needs its anchor in view: pinned to a screen edge
    // (or under host UI) it would point at nothing.
    const inView = anchor && anchor.x >= 0 && anchor.y >= 0 &&
      anchor.x <= viewport.width && anchor.y <= viewport.height &&
      !(obstacles.blockers ?? []).some((b) =>
        anchor.x >= b.x0 && anchor.x <= b.x1 && anchor.y >= b.y0 && anchor.y <= b.y1);
    if (!inView || !this.content) {
      this.hide();
      return null;
    }
    this.box.style.display = 'block';
    this.svg.style.display = 'block';
    if (!this.size || this.size.width === 0) {
      this.size = { width: this.box.offsetWidth, height: this.box.offsetHeight };
    }
    const placement = chooseCalloutPlacement(
      anchor.x, anchor.y, this.size.width, this.size.height, viewport, obstacles, this.previousKey,
    );
    this.previousKey = placement.key;
    // Flipping sides is a jump, not a move: fade the old side out in place.
    if (this.shown && placement.direction !== this.direction) this.fadeOut();
    this.direction = placement.direction;
    // Keep the box inside the viewport even when every candidate overflows;
    // the leader still reaches the anchor.
    const dx = Math.max(EDGE_MARGIN - placement.box.x0,
      Math.min(0, viewport.width - EDGE_MARGIN - placement.box.x1));
    const dy = Math.max(EDGE_MARGIN - placement.box.y0,
      Math.min(0, viewport.height - EDGE_MARGIN - placement.box.y1));
    const x0 = Math.round(placement.box.x0 + dx);
    const y0 = Math.round(placement.box.y0 + dy);
    const transform = `translate(${x0}px, ${y0}px)`;
    if (transform !== this.lastTransform) {
      this.box.style.transform = transform;
      this.lastTransform = transform;
    }
    const [sx, sy, ex, ey, hx, hy] = placement.leader;
    // Horizontal shoulder on a half-pixel row stays a crisp 1px line at DPR 1.
    const shoulderY = Math.round(hy + dy) + 0.5;
    const points = `${sx.toFixed(1)},${sy.toFixed(1)} ${(ex + dx).toFixed(1)},${shoulderY} ${(hx + dx).toFixed(1)},${shoulderY}`;
    if (points !== this.lastPoints) {
      this.leader.setAttribute('points', points);
      this.tick.setAttribute('cx', sx.toFixed(1));
      this.tick.setAttribute('cy', sy.toFixed(1));
      this.lastPoints = points;
    }
    if (!this.shown) {
      this.shown = true;
      this.fadeIn();
    }
    return { x0, y0, x1: x0 + this.size.width, y1: y0 + this.size.height };
  }

  hide(): void {
    this.fadeOut();
    this.box.style.display = 'none';
    this.svg.style.display = 'none';
    this.previousKey = null;
  }

  /**
   * Leave a fading copy of what is on screen now; the live nodes hide or move.
   * Swaps cross-fade in place rather than flying the box across the screen.
   */
  private fadeOut(): void {
    if (!this.shown) return;
    this.shown = false;
    this.direction = null;
    const parent = this.box.parentElement;
    if (!parent) return;
    for (const node of [this.svg, this.box]) {
      const ghost = node.cloneNode(true) as HTMLElement | SVGSVGElement;
      ghost.style.transition = 'none';
      ghost.style.opacity = node.style.opacity || '1';
      parent.insertBefore(ghost, this.svg);
      void ghost.getBoundingClientRect(); // commit the start value
      ghost.style.transition = `opacity ${EMPHASIS_FADE_MS}ms linear`;
      ghost.style.opacity = '0';
      setTimeout(() => ghost.remove(), EMPHASIS_FADE_MS + 50);
    }
  }

  private fadeIn(): void {
    for (const node of [this.svg, this.box]) {
      node.style.transition = 'none';
      node.style.opacity = '0';
      void node.getBoundingClientRect();
      node.style.transition = `opacity ${EMPHASIS_FADE_MS}ms linear`;
      node.style.opacity = '1';
    }
  }

  dispose(): void {
    this.box.remove();
    this.svg.remove();
  }

  /** Title glyph mirrors the scene state: softly filled on hover, solid when selected. */
  private glyph(content: CalloutContent): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '8');
    svg.setAttribute('height', '8');
    svg.setAttribute('viewBox', '0 0 8 8');
    svg.style.flex = 'none';
    if (content.feature === 'boundary') {
      const bar = document.createElementNS(SVG_NS, 'line');
      bar.setAttribute('x1', '4');
      bar.setAttribute('x2', '4');
      bar.setAttribute('y1', '0.5');
      bar.setAttribute('y2', '7.5');
      bar.setAttribute('stroke', content.color);
      bar.setAttribute('stroke-width', '1.5');
      svg.append(bar);
      return svg;
    }
    const diamond = document.createElementNS(SVG_NS, 'path');
    diamond.setAttribute('d', 'M4 0.8 L7.2 4 L4 7.2 L0.8 4 Z');
    diamond.setAttribute('stroke', content.color);
    diamond.setAttribute('stroke-width', '1');
    diamond.setAttribute('fill', content.color);
    diamond.setAttribute('fill-opacity', content.tone === 'selected' ? '1' : '0.35');
    svg.append(diamond);
    return svg;
  }
}
