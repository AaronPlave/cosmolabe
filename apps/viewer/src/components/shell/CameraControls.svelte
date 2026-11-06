<script lang="ts">
  /**
   * The camera actions, in one place beside the other rail instruments:
   * one-shot viewpoints (Top, Sun, Velocity), held dolly/crane moves, and a
   * labelled vector view behind an advanced section. Mouse and keyboard
   * gestures stay first-class; this is the discoverable, touch-sized route to
   * the same moves.
   */
  import { ArrowDownToLine, ArrowUpToLine, ZoomIn, ZoomOut } from 'lucide-svelte';
  import { vs, getRenderer, cycleCamera, applyViewPreset, setViewFromDirection, viewCenterName } from '../../lib/viewer-state.svelte';
  import { startHeldCameraMove, stopHeldCameraMove } from '../../lib/held-camera-moves';
  import { geometryFrameOptions } from '../../lib/geometry-frames';
  import { getUniverse, getMissionFrameNames } from '../../lib/loader';
  import { shortcutFor } from '../../lib/keymap';
  import { parseViewVector } from '../../lib/view-vector';
  import type { ViewPreset } from '@cosmolabe/core';

  const center = $derived(viewCenterName());
  const modeLabel = $derived(vs.cameraMode.replaceAll('-', ' '));

  const PRESETS: { id: ViewPreset; label: string; detail: string }[] = [
    { id: 'top', label: 'Top', detail: 'orbit normal' },
    { id: 'sun', label: 'Sun', detail: 'from the Sun' },
    { id: 'velocity', label: 'Velocity', detail: 'along travel' },
  ];

  // An unavailable preset is shown as such, with the reason, rather than enabled
  // because a body happens to be selected.
  const presets = $derived(PRESETS.map(p => {
    const result = applyViewPreset(p.id, center, { place: false });
    return { ...p, reason: result.ok ? null : result.reason };
  }));

  let viewMessage = $state('');
  function applyPreset(id: ViewPreset) {
    const result = applyViewPreset(id, center);
    viewMessage = result.ok ? '' : result.reason;
  }

  // ── Held moves ──
  const MOVES = [
    { id: 'cam:dolly-in', label: 'Dolly in', hint: shortcutFor('cam:dolly-in'), icon: ZoomIn },
    { id: 'cam:dolly-out', label: 'Dolly out', hint: shortcutFor('cam:dolly-out'), icon: ZoomOut },
    { id: 'cam:crane-up', label: 'Crane up', hint: shortcutFor('cam:crane-up'), icon: ArrowUpToLine },
    { id: 'cam:crane-down', label: 'Crane down', hint: shortcutFor('cam:crane-down'), icon: ArrowDownToLine },
  ] as const;
  const movesAvailable = $derived((vs.cameraMode, getRenderer()?.cameraController.acceptsOrbitMoves ?? false));
  let pressed = $state<string | null>(null);

  function hold(id: string, event: PointerEvent) {
    event.preventDefault();
    (event.currentTarget as HTMLButtonElement).setPointerCapture(event.pointerId);
    pressed = id;
    startHeldCameraMove(id);
  }
  function release(id: string) {
    if (pressed === id) pressed = null;
    stopHeldCameraMove(id);
  }
  function keyHold(id: string, event: KeyboardEvent, down: boolean) {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (down && !event.repeat) { pressed = id; startHeldCameraMove(id); }
    else if (!down) release(id);
  }
  $effect(() => { if (!movesAvailable) { for (const m of MOVES) stopHeldCameraMove(m.id); pressed = null; } });

  // ── View from a vector ──
  let advancedOpen = $state(false);
  let vector = $state({ x: '0', y: '0', z: '1' });
  let vectorCenter = $state('');
  let vectorFrame = $state('');
  let vectorMessage = $state('');
  const targetCenter = $derived(vectorCenter || center);
  const frames = $derived.by(() => {
    const universe = advancedOpen ? getUniverse() : null;
    return universe
      ? geometryFrameOptions(universe, getMissionFrameNames(), universe.time, targetCenter || undefined).filter(o => o.availability === 'available')
      : [];
  });

  function applyVector(event: SubmitEvent) {
    event.preventDefault();
    const parsed = parseViewVector(vector.x, vector.y, vector.z);
    if (!parsed.ok) { vectorMessage = parsed.reason; return; }
    const result = setViewFromDirection({ kind: 'vector', vector: parsed.vector, ...(vectorFrame ? { frame: vectorFrame } : {}) }, targetCenter);
    vectorMessage = result.ok ? '' : result.reason;
  }
  const field = 'ui-control w-full min-w-0 rounded border border-border bg-surface-3 px-1.5 py-1 font-mono text-xs';
</script>

<div class="flex max-h-[min(34rem,calc(100cqh-1.5rem))] flex-col gap-3 overflow-y-auto text-xs text-text-secondary">
  <section aria-label="Camera mode" class="flex items-center justify-between gap-2">
    <div class="min-w-0">
      <div class="ui-section-label">Camera</div>
      <div class="truncate text-text-primary capitalize">{modeLabel}</div>
    </div>
    <button class="action" onclick={() => cycleCamera()} title={`Next camera mode${shortcutFor('cam:cycle') ? ` (${shortcutFor('cam:cycle')})` : ''}`}>Next mode</button>
  </section>

  <section aria-label="Views">
    <div class="ui-section-label">View {center ? `of ${center}` : ''}</div>
    <p class="helper">One-shot viewpoints that switch to free orbit. <b>Top</b> looks down the orbital normal, not geographic north.</p>
    <div class="grid grid-cols-3 gap-1.5">
      {#each presets as p (p.id)}
        <button class="action tall" disabled={!!p.reason} title={p.reason ?? `${p.label} view of ${center}`} onclick={() => applyPreset(p.id)}>
          <span>{p.label}</span><span class="detail">{p.detail}</span>
        </button>
      {/each}
    </div>
    {#each presets.filter(p => p.reason) as p (p.id)}
      <p class="helper mt-1">{p.label} unavailable: {p.reason}</p>
    {/each}
    {#if viewMessage}<p class="helper text-error mt-1" role="alert">{viewMessage}</p>{/if}
  </section>

  <section aria-label="Move">
    <div class="ui-section-label">Move (hold)</div>
    <div class="grid grid-cols-4 gap-1.5">
      {#each MOVES as m (m.id)}
        {@const Icon = m.icon}
        <button
          class="action tall"
          disabled={!movesAvailable}
          aria-pressed={pressed === m.id}
          aria-label={m.label}
          title={`${m.label}${m.hint ? ` · hold ${m.hint}` : ''}`}
          style="touch-action: none"
          onpointerdown={(e) => hold(m.id, e)}
          onpointerup={() => release(m.id)}
          onpointercancel={() => release(m.id)}
          onlostpointercapture={() => release(m.id)}
          onkeydown={(e) => keyHold(m.id, e, true)}
          onkeyup={(e) => keyHold(m.id, e, false)}
          onblur={() => release(m.id)}
        >
          <Icon size={16} />
          {#if m.hint}<span class="detail">{m.hint}</span>{/if}
        </button>
      {/each}
    </div>
    {#if !movesAvailable}<p class="helper mt-1">Not available in {modeLabel}: its frame places the camera. Switch to free orbit to move.</p>{/if}
  </section>

  <details bind:open={advancedOpen}>
    <summary class="ui-section-label cursor-pointer select-none">Advanced: view from a vector</summary>
    <form class="mt-1.5 flex flex-col gap-2" onsubmit={applyVector}>
      <p class="helper">Places the camera along the vector from the center, looking back at it.</p>
      <label class="flex flex-col gap-0.5">Center
        <select class={field} bind:value={vectorCenter}>
          <option value="">Current ({center || 'none'})</option>
          {#each vs.bodies as b (b.name)}<option value={b.name}>{b.name}</option>{/each}
        </select>
      </label>
      <label class="flex flex-col gap-0.5">Reference frame
        <select class={field} bind:value={vectorFrame}>
          <option value="">Scene frame (Ecliptic J2000)</option>
          {#each frames as f (f.name)}<option value={f.name}>{f.label}</option>{/each}
        </select>
      </label>
      <div class="grid grid-cols-3 gap-1.5">
        {#each [['x', 'X'], ['y', 'Y'], ['z', 'Z']] as const as [axis, name] (axis)}
          <label class="flex flex-col gap-0.5">{name}
            <input class={field} type="number" step="any" inputmode="decimal" bind:value={vector[axis]} aria-invalid={!!vectorMessage} />
          </label>
        {/each}
      </div>
      <button class="action" type="submit" disabled={!targetCenter}>Set view</button>
      {#if vectorMessage}<p class="helper text-error" role="alert">{vectorMessage}</p>{/if}
    </form>
  </details>
</div>

<style>
  .helper { margin: 2px 0 6px; color: var(--color-text-muted); line-height: 1.35; }
  .action {
    display: flex;
    min-height: 36px;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    padding: 4px 8px;
    border: 1px solid var(--color-border-default);
    border-radius: 4px;
    background: var(--color-surface-3, transparent);
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  .action.tall { min-height: 44px; }
  .detail { font-size: var(--text-metadata); color: var(--color-text-muted); }
  .action:hover:not(:disabled) { background: var(--color-control-hover); color: var(--color-text-primary); }
  .action:active:not(:disabled), .action[aria-pressed='true'] { background: var(--color-control-active); color: var(--color-text-primary); }
  .action:disabled { cursor: not-allowed; opacity: 0.45; }
  .action:focus-visible, summary:focus-visible { outline: 1px solid var(--color-border-strong); outline-offset: 1px; }
</style>
