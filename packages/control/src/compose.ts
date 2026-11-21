/**
 * Deterministic camera composition (#345): swing the camera around the object
 * it tracks until other objects are in view, keeping its distance, the clock
 * and the selection. A bounded search over the existing `circleCenter` orbit,
 * steered by `getViewComposition` — no camera math of its own, no raw poses,
 * nothing a script author could not do by hand with the same two calls.
 *
 * It refuses rather than guesses: when the tracked object fills too much of
 * the view for anything to sit beside it, it says how far out the camera would
 * have to be instead of moving.
 */
import type { CircleDirection, ScriptComposedObject, ScriptViewComposition, ViewerControl } from './contracts.js';

export interface ComposeOutcome {
  readonly status: 'composed' | 'unchanged';
  readonly moves: readonly { readonly direction: CircleDirection; readonly degrees: number }[];
  readonly anchorRangeKm: number;
  readonly composition: ScriptViewComposition;
}

/** Fraction of the half-viewport a target centre may use. */
const MARGIN = 0.8;
const MAX_ROUNDS = 6;
/** Clearance beyond the anchor's disc, degrees, so its centre is beside rather than behind it. */
const CLEARANCE_DEG = 2;

const rad = (deg: number) => deg * Math.PI / 180;
const deg = (r: number) => r * 180 / Math.PI;
const round = (v: number) => Math.round(v * 1000) / 1000;

/** Unit direction in camera space (x right, y up, z forward) from a bearing. */
function cameraVector(o: ScriptComposedObject) {
  const [h, e] = o.bearingDeg!.map(rad);
  return { x: Math.cos(e) * Math.sin(h), y: Math.sin(e), z: Math.cos(e) * Math.cos(h) };
}

function placed(o: ScriptComposedObject | undefined, anchor: ScriptComposedObject): boolean {
  if (!o?.inView || !o.ndc || Math.abs(o.ndc[0]) > MARGIN || Math.abs(o.ndc[1]) > MARGIN) return false;
  if (o.occlusion?.basis === 'model-bounds') return true; // Bounds cannot establish a blocked line of sight.
  if (o.occlusion?.kind === 'full') return false;
  // A target whose centre is behind the anchor's disc is not "beside" it.
  return !(o.occlusion?.by === anchor.object);
}

/**
 * Orbit the tracked `anchor` so every `target` centre is in view. Throws, with
 * the reason, when it cannot: a missing read, an untracked anchor, an unknown
 * name, or a goal the current distance makes impossible. Moves already made
 * stay made; the thrown message says so.
 */
export function composeView(host: ViewerControl, anchor: string, targets: readonly string[]): ComposeOutcome {
  if (!host.getViewComposition) throw new Error('this viewer cannot observe view composition');
  const read = () => host.getViewComposition!([anchor, ...targets]);
  const others = [...new Set(targets)].filter(t => t !== anchor);
  if (!others.length) throw new Error('name at least one object other than the anchor to bring into view');
  let view = read();
  if (view.tracked !== anchor) throw new Error(`the camera orbits ${view.tracked ?? 'nothing'}, not ${anchor}; track or frame ${anchor} first`);
  const missing = view.objects.filter(o => !o.available).map(o => o.object);
  if (missing.length) throw new Error(`not in this scene: ${missing.join(', ')}`);

  const startEt = view.et, selected = host.getSelected();
  const range0 = view.objects[0].rangeKm!;
  const vHalf = rad(view.fovDeg / 2), hHalf = Math.atan(Math.tan(vHalf) * view.aspect);
  // Aim a little inside the accepted box so rounding cannot leave a target on its edge.
  const hMax = deg(Math.atan(0.9 * MARGIN * Math.tan(hHalf))), vMax = deg(Math.atan(0.9 * MARGIN * Math.tan(vHalf)));
  const anchorDisc = view.objects[0].angularRadiusDeg ?? 0;
  const minOff = anchorDisc + CLEARANCE_DEG;
  // Room beside the anchor along the screen's longer axis.
  if (minOff >= Math.max(hMax, vMax)) {
    const radius = view.objects[0].radiusKm ?? 0;
    const need = radius > 0 ? radius / Math.sin(rad(Math.max(hMax, vMax) / 2)) : null;
    throw new Error(`${anchor} fills the view at ${round(range0)} km, so nothing can sit beside it without moving out${need ? `; about ${round(need)} km would leave room` : ''}. The camera did not move`);
  }

  const moves: { direction: CircleDirection; degrees: number }[] = [];
  const swing = (direction: CircleDirection, degrees: number) => {
    if (!(degrees >= 0.01)) return;
    if (!host.circleCenter(direction, degrees)) throw new Error(`the camera frame does not allow orbiting${moves.length ? '; earlier swings remain' : ''}`);
    moves.push({ direction, degrees: round(degrees) });
    view = read();
  };
  const objectsOf = (v: ScriptViewComposition) => v.objects.filter(o => others.includes(o.object));

  for (let i = 0; i < MAX_ROUNDS; i++) {
    const anchorNow = view.objects[0];
    const worst = objectsOf(view).find(o => !placed(o, anchorNow));
    if (!worst) break;
    // Work in the image plane: yaw h = atan2(x, z) and pitch p = atan2(y, z)
    // map straight to screen position, tan(h) / tan(hHalf) and tan(p) / tan(vHalf).
    const [h] = worst.bearingDeg!;
    const { x, y, z } = cameraVector(worst);
    // Keep the target on the side of the screen it is already on, as far off
    // the anchor as needed and no farther than the viewport allows.
    const side = Math.hypot(x, y) > 1e-6 ? [x / Math.hypot(x, y), y / Math.hypot(x, y)] : [1, 0];
    const now = z > 0 ? Math.hypot(x, y) / z : 1e6;
    const t = Math.max(now, Math.tan(rad(minOff)));
    const uMax = Math.tan(rad(hMax)), wMax = Math.tan(rad(vMax));
    let u = Math.max(-uMax, Math.min(uMax, side[0] * t)), w = Math.max(-wMax, Math.min(wMax, side[1] * t));
    // The box clipped the target back over the anchor: use the roomier axis instead.
    if (Math.hypot(u, w) < Math.tan(rad(minOff))) {
      if (uMax >= wMax) { u = (x < 0 ? -1 : 1) * uMax; w = 0; } else { u = 0; w = (y < 0 ? -1 : 1) * wMax; }
    }
    const hd = deg(Math.atan(u)), pd = deg(Math.atan(w));
    // A far target moves across the screen the way the camera swings.
    swing(h > hd ? 'left' : 'right', Math.abs(h - hd));
    const after = cameraVector(objectsOf(view).find(o => o.object === worst.object)!);
    const p = deg(Math.atan2(after.y, after.z));
    swing(p > pd ? 'down' : 'up', Math.abs(p - pd));
  }

  const anchorAfter = view.objects[0];
  if (Math.abs(anchorAfter.rangeKm! - range0) > Math.max(1e-6, range0 * 1e-3)) throw new Error('the camera distance changed while composing; inspect the view');
  if (view.et !== startEt && !view.playing) throw new Error('the clock moved while composing; inspect the view');
  if (host.getSelected() !== selected) throw new Error('the selection changed while composing; inspect the view');
  const failed = objectsOf(view).filter(o => !placed(o, anchorAfter));
  if (failed.length) {
    const why = failed.map(o => o.occlusion ? `${o.object} is ${o.occlusion.kind === 'full' ? 'hidden' : 'partly hidden'} behind ${o.occlusion.by}` : `${o.object} could not be brought inside the frame`).join('; ');
    throw new Error(`${why}. ${moves.length ? `The camera swung ${moves.length} times around ${anchor} and stays there` : 'The camera did not move'}; distance kept at ${round(range0)} km`);
  }
  return { status: moves.length ? 'composed' : 'unchanged', moves, anchorRangeKm: round(anchorAfter.rangeKm!), composition: view };
}
