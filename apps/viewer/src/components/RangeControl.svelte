<script lang="ts">
  /**
   * The timeline's range control: names the span it is framing ("Full
   * mission · 7.9 yr", or a zoomed "10.9 hr") and opens the duration presets
   * and framing options. Beside the track when collapsed, in the axis caption
   * when expanded.
   */
  import { ChevronDown } from 'lucide-svelte';
  import * as Popover from '$lib/components/ui/popover';

  interface Props {
    /** The visible span, e.g. "43 d". */
    label: string;
    /** What the span is, when not just a zoom: "Full mission". */
    context?: string;
    /** `caption`: quiet, sized for the axis caption. */
    variant?: 'inline' | 'caption';
    /** Framing presets offered above "Fit mission". */
    fitOptions?: readonly { label: string; onSelect: () => void }[];
    onSetZoom?: (seconds: number) => void;
    onResetZoom?: () => void;
  }

  let { label, context = '', variant = 'inline', fitOptions = [], onSetZoom, onResetZoom }: Props = $props();

  let open = $state(false);

  const ZOOM_PRESETS = [
    { label: '1 min', seconds: 60 },
    { label: '10 min', seconds: 600 },
    { label: '1 hr', seconds: 3600 },
    { label: '6 hr', seconds: 21600 },
    { label: '1 day', seconds: 86400 },
    { label: '1 wk', seconds: 604800 },
    { label: '1 mo', seconds: 2592000 },
    { label: '6 mo', seconds: 15552000 },
    { label: '1 yr', seconds: 31556952 },
  ];

  function choose(fn: (() => void) | undefined) {
    open = false;
    fn?.();
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="icon-btn range-btn font-mono justify-center {variant === 'inline' ? 'min-w-16' : 'caption'}"
    title="Set time range (scroll over the timeline to zoom)"
  >
    {context ? `${context} · ${label}` : label}
    <ChevronDown size={10} />
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content side="top" sideOffset={8} class="w-max min-w-36 max-w-[calc(100vw-16px)] p-1">
      <div class="flex flex-col gap-0.5">
        {#each ZOOM_PRESETS as preset}
          <button class="zoom-preset" onclick={() => choose(() => onSetZoom?.(preset.seconds))}>
            {preset.label}
          </button>
        {/each}
        <div class="border-t border-border mt-0.5 pt-0.5">
          {#each fitOptions as option}
            <button class="zoom-preset" onclick={() => choose(option.onSelect)}>
              {option.label}
            </button>
          {/each}
          <button class="zoom-preset text-accent" onclick={() => choose(onResetZoom)}>
            Fit mission
          </button>
        </div>
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style>
  :global(.range-btn) {
    gap: 3px;
    font-size: 10px;
    white-space: nowrap;
  }
  :global(.range-btn.caption) {
    padding: 0 6px;
    font-size: var(--text-metadata);
    color: var(--color-text-muted);
  }
  .zoom-preset {
    width: 100%;
    padding: 3px 8px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-interface);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  }
  .zoom-preset:hover {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }
</style>
