import { crane, dolly, getRenderer } from './viewer-state.svelte';

type CameraMoveId = 'cam:dolly-in' | 'cam:dolly-out' | 'cam:crane-up' | 'cam:crane-down';

const MOVES: Record<CameraMoveId, { kind: 'dolly' | 'crane'; sign: 1 | -1 }> = {
  'cam:dolly-in': { kind: 'dolly', sign: -1 },
  'cam:dolly-out': { kind: 'dolly', sign: 1 },
  'cam:crane-up': { kind: 'crane', sign: 1 },
  'cam:crane-down': { kind: 'crane', sign: -1 },
};

/** Fraction of the speed reference covered per second; the keys' Shift-free WASD rate is 1.0. */
const HELD_MOVE_RATE = 0.55;

const held = new Set<CameraMoveId>();
let frame = 0;
let lastFrameMs = 0;

export function startHeldCameraMove(id: string): void {
  if (!(id in MOVES)) return;
  held.add(id as CameraMoveId);
  if (!frame) frame = requestAnimationFrame(step);
}

export function stopHeldCameraMove(id: string): void {
  held.delete(id as CameraMoveId);
  if (held.size === 0) stopLoop();
}

export function stopAllHeldCameraMoves(): void {
  held.clear();
  stopLoop();
}

function stopLoop(): void {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  lastFrameMs = 0;
}

function step(now: number): void {
  frame = 0;
  const renderer = getRenderer();
  if (!renderer || held.size === 0) {
    stopAllHeldCameraMoves();
    return;
  }

  const dt = lastFrameMs ? Math.min((now - lastFrameMs) / 1000, 0.05) : 0;
  lastFrameMs = now;
  const controller = renderer.cameraController;
  // Recomputed every frame, so a mode change or descent while held re-scales at once.
  const amountKm = controller.moveSpeedReference * HELD_MOVE_RATE * dt / renderer.scaleFactor;

  for (const id of held) {
    const move = MOVES[id];
    const amount = move.sign * amountKm;
    const moved = move.kind === 'dolly' ? dolly(amount) : crane(amount);
    if (!moved) held.delete(id);
  }

  if (held.size > 0) frame = requestAnimationFrame(step);
  else stopLoop();
}