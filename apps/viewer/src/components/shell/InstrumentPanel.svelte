<script lang="ts">
  /**
   * The one contextual-panel primitive (#59).
   *
   * Every analysis surface goes in one of these rather than placing itself: the
   * panel says what it *is*, and the shell decides where it sits. That is not
   * tidiness — three panels previously hardcoded `absolute top-3 left-3` and
   * drew on top of each other whenever two were open.
   *
   * A panel is a manipulable instrument, not a fixed dashboard column:
   *
   * - **Drag the header** and it leaves the dock, floating where it was picked
   *   up. The dock is where panels start, not where they live.
   * - **Drag the corner** of a floating panel to resize it.
   * - **Minimize** to give the scene its space back without losing the panel's
   *   search, selection or form — the thing closing would destroy.
   *
   * Floating panels use `position: fixed`, which escapes the dock's scroll
   * clipping without a portal. Clicking one raises it, which is the only sense
   * in which there is a stack: `shell.panelOrder` is a focus order, and the
   * `z-index` falls out of it. That is the whole of the "window management"
   * here — a rectangle, two constraints in `panel-geometry.ts`, one ordered
   * list, and no tiling, snapping or persistence.
   *
   * The chrome is deliberately quiet: a hairline border, one translucent
   * surface, a 10px uppercase caption, no shadow except while floating, where a
   * faint one is what separates the panel from the scene behind it.
   */
  import type { Snippet } from 'svelte';
  import { X, Minus, Square, PictureInPicture2, Dock } from 'lucide-svelte';
  import {
    shell, isMinimized, toggleMinimized, isFloating, floatOf, setFloat, dockPanel,
    raisePanel, panelZIndex, setPanelMounted, type PanelKey,
  } from '../../lib/shell.svelte';
  import { moveFloat, resizeFloat, floatFromDocked, type FloatRect } from '../../lib/panel-geometry';

  interface Props {
    /**
     * Which panel this is. Without one the panel is a plain box — it cannot be
     * minimized, dragged or floated, because there is nowhere to keep that.
     */
    key?: PanelKey;
    title: string;
    /** Desktop width in px while docked. Ignored when floating or compact. */
    width?: number;
    onClose?: () => void;
    /** Rendered to the right of the title — small readouts or per-panel controls. */
    actions?: Snippet;
    children: Snippet;
  }

  let { key, title, width = 320, onClose, actions, children }: Props = $props();

  let root = $state<HTMLElement | null>(null);

  // A rendered panel is one the shell can consider on screen — which is what
  // lets Escape dismiss what the user is actually looking at without the shell
  // having to model why each panel is up.
  $effect(() => {
    if (key == null) return;
    const k = key;
    setPanelMounted(k, true);
    return () => setPanelMounted(k, false);
  });

  const compact = $derived(shell.layout === 'compact');
  const minimized = $derived(key != null && isMinimized(key));
  // Floating is a desktop gesture: at a phone width a panel is the sheet, and
  // there is no room to put it anywhere else.
  const floating = $derived(key != null && !compact && isFloating(key));
  const rect = $derived(floating && key != null ? floatOf(key) : null);

  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

  /**
   * One gesture loop for both the header drag and the corner resize.
   *
   * Window listeners rather than pointer capture, because a drag that starts on
   * the header often ends over the canvas, and capture on the header would hand
   * the canvas the release.
   */
  function gesture(e: PointerEvent, apply: (base: FloatRect, dx: number, dy: number) => FloatRect) {
    if (key == null || e.button !== 0) return;
    const el = root;
    if (!el) return;
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const box = el.getBoundingClientRect();
    const base: FloatRect = floatOf(key) ?? floatFromDocked(
      { x: box.left, y: box.top, w: box.width, h: box.height },
      viewport(),
    );
    const panel = key;
    let started = false;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // A few pixels of slack, so a click on the header is not a one-pixel drag
      // that silently undocks the panel.
      if (!started && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      started = true;
      setFloat(panel, apply(base, dx, dy), viewport());
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /**
   * Any press anywhere on the panel brings it forward — a click on its body
   * counts as using it, not only a grab of its header. Runs before the header
   * and grip handlers, which are nested inside this one.
   */
  function onPanelPointerDown() {
    if (key != null) raisePanel(key);
  }

  function onHeaderPointerDown(e: PointerEvent) {
    // Buttons in the header are controls, not handles.
    if ((e.target as HTMLElement | null)?.closest('button')) return;
    if (compact) return;
    gesture(e, (base, dx, dy) => moveFloat(base, dx, dy, viewport()));
  }

  function onGripPointerDown(e: PointerEvent) {
    gesture(e, (base, dx, dy) => resizeFloat(base, dx, dy, viewport()));
  }

  /** Lifts the panel out of its dock in place, for people who would rather
   *  press a button than discover that the header drags. */
  function undock() {
    if (key == null || !root) return;
    const box = root.getBoundingClientRect();
    setFloat(
      key,
      floatFromDocked({ x: box.left, y: box.top, w: box.width, h: box.height }, viewport()),
      viewport(),
    );
  }

  const style = $derived.by(() => {
    if (compact) return undefined;
    if (rect) {
      // Height is dropped while minimized so the panel shrinks to its header
      // rather than leaving a translucent empty box over the scene.
      const h = minimized ? '' : ` height: ${rect.h}px;`;
      return `position: fixed; left: ${rect.x}px; top: ${rect.y}px; width: ${rect.w}px;${h} z-index: ${key != null ? panelZIndex(key) : 16}`;
    }
    return `width: ${width}px`;
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section
  bind:this={root}
  class="instrument shell-surface pointer-events-auto flex min-h-7 shrink flex-col overflow-hidden rounded-[5px] border backdrop-blur-sm"
  class:w-full={compact}
  class:floating
  class:minimized
  {style}
  onpointerdown={onPanelPointerDown}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header
    class="panel-header flex h-[34px] shrink-0 items-center gap-2 border-b px-3"
    class:draggable={key != null && !compact}
    class:border-transparent={minimized}
    onpointerdown={onHeaderPointerDown}
    ondblclick={() => key != null && toggleMinimized(key)}
  >
    <h2 class="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
      {title}
    </h2>

    {#if actions && !minimized}{@render actions()}{/if}

    {#if key != null && floating}
      <button class="panel-btn" onclick={() => dockPanel(key)} title="Return to dock" aria-label="Return {title} to dock">
        <Dock size={13} />
      </button>
    {:else if key != null && !compact}
      <button class="panel-btn" onclick={undock} title="Float this panel" aria-label="Float {title}">
        <PictureInPicture2 size={13} />
      </button>
    {/if}

    {#if key != null}
      <!-- Minimize, not close: an instrument put away keeps its state, and the
           user should not have to rebuild a search to see the scene. -->
      <button
        class="panel-btn"
        onclick={() => toggleMinimized(key)}
        title={minimized ? 'Restore' : 'Minimize'}
        aria-label={minimized ? `Restore ${title}` : `Minimize ${title}`}
        aria-expanded={!minimized}
      >
        {#if minimized}<Square size={11} />{:else}<Minus size={13} />{/if}
      </button>
    {/if}

    {#if onClose}
      <button class="panel-btn -mr-1.5" onclick={onClose} aria-label="Close {title}" title="Close">
        <X size={13} />
      </button>
    {/if}
  </header>

  {#if !minimized}
    <div class="instrument-body min-h-0 overflow-y-auto overflow-x-hidden">
      {@render children()}
    </div>

    {#if floating}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="grip" onpointerdown={onGripPointerDown} title="Resize"></div>
    {/if}
  {/if}
</section>

<style>
  .instrument {
    position: relative;
    animation: instrument-in var(--duration-chrome) var(--ease-chrome);
    transition:
      border-color var(--duration-chrome) var(--ease-chrome),
      background var(--duration-chrome) var(--ease-chrome),
      box-shadow var(--duration-chrome) var(--ease-chrome);
  }
  /* The one place a shadow is warranted: a floating panel has no dock edge to
     sit against, so something has to separate it from the scene. */
  .instrument.floating {
    border-color: rgba(184, 197, 220, 0.2);
    background:
      linear-gradient(180deg, var(--color-chrome-highlight), transparent 18px),
      var(--color-panel-raised);
    box-shadow: var(--shadow-float);
  }
  .instrument:hover {
    border-color: rgba(184, 197, 220, 0.155);
  }
  .instrument.minimized {
    border-color: rgba(184, 197, 220, 0.135);
    background: var(--color-panel-raised);
  }
  .instrument.minimized .panel-header {
    color: var(--color-text-primary);
  }
  .instrument.minimized::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 2px;
    background: var(--color-chrome-active);
    opacity: 0.65;
  }
  .panel-header {
    border-color: var(--color-chrome-divider);
    background: var(--color-panel-header);
  }
  .instrument-body {
    scrollbar-gutter: stable;
    padding: var(--space-ui-3) var(--space-ui-4);
    font-family: var(--font-sans);
    font-size: var(--text-interface);
    font-weight: 420;
    line-height: var(--leading-interface);
  }
  .instrument-body :global(select),
  .instrument-body :global(input:not([type='range']):not([type='checkbox'])) {
    min-height: var(--size-control);
    padding-inline: var(--space-ui-2);
    border-color: var(--color-border-default);
    border-radius: var(--radius-control);
    background: var(--color-control);
    font-size: var(--text-interface);
    line-height: 1.2;
    transition:
      border-color var(--duration-chrome) var(--ease-chrome),
      background var(--duration-chrome) var(--ease-chrome);
  }
  .instrument-body :global(select:hover),
  .instrument-body :global(input:not([type='range']):not([type='checkbox']):hover) {
    border-color: var(--color-border-strong);
    background: color-mix(in srgb, var(--color-control) 92%, white);
  }
  .instrument-body :global(select:disabled),
  .instrument-body :global(input:disabled),
  .instrument-body :global(button:disabled) {
    cursor: default;
    opacity: 0.42;
  }
  .instrument-body :global(select:not(.font-mono)),
  .instrument-body :global(input:not([type='range']):not([type='checkbox']):not(.font-mono)),
  .instrument-body :global(button:not(.font-mono)) {
    font-family: var(--font-sans);
    font-weight: 440;
    font-size: var(--text-interface);
  }
  @keyframes instrument-in {
    from { opacity: 0; transform: translateY(-2px); }
    to   { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .instrument { animation: none; }
  }

  header.draggable {
    cursor: grab;
    /* The drag is ours; the browser must not also pan or select. */
    touch-action: none;
    user-select: none;
  }
  header.draggable:active {
    cursor: grabbing;
  }

  /* 28px square, inside a 34px header. Compact bumps these to a thumb-sized
     target below, where there is no hover to fall back on. */
  .panel-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--color-text-muted);
    cursor: pointer;
    transition:
      color var(--duration-chrome) var(--ease-chrome),
      background var(--duration-chrome) var(--ease-chrome),
      transform var(--duration-chrome) var(--ease-chrome);
  }
  .panel-btn:hover {
    color: var(--color-text-primary);
    background: var(--color-control-hover);
  }
  .panel-btn:active {
    transform: translateY(1px);
    background: var(--color-control-pressed);
  }

  .grip {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 18px;
    height: 18px;
    cursor: nwse-resize;
    touch-action: none;
    /* Two hairlines rather than an icon: visible when looked for, invisible
       otherwise, which is the register the rest of this chrome is in. */
    background:
      linear-gradient(135deg, transparent 0 55%, var(--color-border-active) 55% 65%, transparent 65% 78%, var(--color-border-active) 78% 88%, transparent 88%);
  }

  @media (max-width: 719px), (pointer: coarse) {
    .panel-header {
      height: 40px;
      padding-inline: 12px 6px;
    }
    .panel-btn {
      width: 36px;
      height: 36px;
    }
    .instrument-body {
      padding: var(--space-ui-3) var(--space-ui-4) var(--space-ui-4);
    }
  }
</style>
