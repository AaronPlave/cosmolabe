<script lang="ts">
  /**
   * The one contextual-panel primitive (#59).
   *
   * Every analysis surface goes in one of these rather than positioning itself:
   * the panel says what it *is*, and `PanelDock` decides where it sits. That is
   * not tidiness — three panels previously hardcoded `absolute top-3 left-3`
   * and drew on top of each other whenever two were open.
   *
   * The chrome is deliberately quiet: a hairline border, one translucent
   * surface, a 10px uppercase caption, and no shadow or colored header. The
   * scene is the subject; this is an instrument reading over it.
   */
  import type { Snippet } from 'svelte';
  import { X } from 'lucide-svelte';
  import { shell } from '../../lib/shell.svelte';

  interface Props {
    title: string;
    /** Desktop width in px. Ignored when compact, where panels are full-width sheets. */
    width?: number;
    onClose?: () => void;
    /** Rendered to the right of the title — small readouts or per-panel controls. */
    actions?: Snippet;
    children: Snippet;
  }

  let { title, width = 320, onClose, actions, children }: Props = $props();

  const compact = $derived(shell.layout === 'compact');
</script>

<section
  class="instrument pointer-events-auto flex flex-col min-h-0 shrink-0 border border-border rounded-md bg-panel backdrop-blur-md text-[12px]"
  class:w-full={compact}
  style={compact ? undefined : `width: ${width}px`}
>
  <header class="flex items-center gap-2 shrink-0 px-2.5 h-7 border-b border-border/60">
    <h2 class="flex-1 min-w-0 truncate text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
      {title}
    </h2>
    {#if actions}{@render actions()}{/if}
    {#if onClose}
      <!-- 28px of hit target on a 13px glyph: the close control has to survive
           a thumb, per #59's touch requirement, without growing the header. -->
      <button
        class="-mr-1.5 flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:text-text-primary"
        onclick={onClose}
        aria-label="Close {title}"
      >
        <X size={13} />
      </button>
    {/if}
  </header>

  <div class="min-h-0 overflow-y-auto overflow-x-hidden px-2.5 py-2">
    {@render children()}
  </div>
</section>

<style>
  .instrument {
    animation: instrument-in 0.12s ease;
  }
  @keyframes instrument-in {
    from { opacity: 0; transform: translateY(-2px); }
    to   { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .instrument { animation: none; }
  }
</style>
