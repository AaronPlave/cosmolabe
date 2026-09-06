/**
 * The script that reproduces a view.
 *
 * Pure: it takes the read side's state and emits text. It holds nothing, reads
 * nothing, and needs no renderer — which is what makes the round-trip test
 * (snapshot a state, parse it, execute it against a recording host, compare)
 * possible at all, and that test is what keeps `snapshot` honest as verbs are
 * added.
 *
 * This is the intended single serializer for view state. Two others exist today
 * — catalog `Viewpoint` JSON and `apps/viewer/src/lib/camera-view-io.ts` — and
 * unifying them is not this change's job; recording the end state here is what
 * keeps a fourth from being added silently. The repo already has the scar:
 * `applyNamedViewpoint` exists because three copies of one rule drifted.
 */
import type { ScriptVec3, ViewerSnapshotState } from './contracts.js';
import { LAYERS } from './verbs.js';

/**
 * A number the parser will read back as the same number.
 *
 * 12 significant digits: at Saturn's distance from the Sun (~1.4e9 km) that is
 * millimetre resolution on a camera position, and it keeps `60` printing as
 * `60` rather than `60.000000000000004`.
 */
function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Number(value.toPrecision(12)));
}

/** Bare when it can be, quoted when it must be. */
export function quote(value: string): string {
  if (value.length > 0 && !/[\s"#[\]\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function vector(v: ScriptVec3): string {
  return `[${num(v[0])}, ${num(v[1])}, ${num(v[2])}]`;
}

/**
 * Render `state` as a runnable script.
 *
 * The order is the point. Playback is stopped first so nothing moves while the
 * rest is applied; the camera is placed *after* the frame and the tracked
 * object, because both of those move it; and playback is restored last.
 */
export function snapshotScript(state: ViewerSnapshotState): string {
  const lines: string[] = ['# Cosmolabe snapshot'];

  lines.push('setPlaying off');
  lines.push(`setTime ${quote(state.timeText ?? num(state.time))}`);
  lines.push(`setTimeRate ${num(state.rate)}`);

  // `untrack` rather than nothing: a snapshot is meant to *reproduce* the view,
  // and running one over a scene that is tracking something else should not
  // leave that tracking in place.
  lines.push(state.tracked ? `gotoObject ${quote(state.tracked)}` : 'untrack');

  lines.push(
    state.frame.body
      ? `setFrame ${state.frame.mode} ${quote(state.frame.body)}`
      : `setFrame ${state.frame.mode}`,
  );

  // Aim before pose. Pointing at an object drives the orbit centre every frame,
  // so it has to be established before the explicit target below rather than
  // after, where it would look like the pose had simply been overwritten.
  lines.push(state.lookAt ? `pointAtObject ${quote(state.lookAt)}` : 'clearLookAt');

  lines.push(`setFov ${num(state.camera.fov)}`);
  lines.push(
    `setCamera ${vector(state.camera.position)} ${vector(state.camera.target)} ${vector(state.camera.up)}`,
  );

  for (const layer of LAYERS) {
    const on = state.layers[layer.id];
    if (on === undefined) continue;
    lines.push(`setLayer ${layer.id} ${on ? 'on' : 'off'}`);
  }

  lines.push(state.selected ? `select ${quote(state.selected)}` : 'deselect');

  // Persistent only: `ViewerSnapshotState.note` carries a caption that will stay
  // up, and a timed one never reaches here. Emitting it without a duration is
  // therefore reproducing the note rather than changing what it means.
  if (state.note) lines.push(`displayNote ${quote(state.note)}`);
  if (state.playing) lines.push('setPlaying on');

  return lines.join('\n') + '\n';
}
