<script lang="ts">
  import { ToggleGroup } from 'bits-ui';
  interface Props { value: string; options: readonly string[]; label: string; onValueChange: (value: string) => void; }
  let { value, options, label, onValueChange }: Props = $props();
</script>

<ToggleGroup.Root type="single" bind:value={() => value, next => { if (next) onValueChange(next); }} aria-label={label}>
  {#snippet child({ props })}
    <div {...props} role="radiogroup" class="segmented-control">
      {#each options as option}
        <ToggleGroup.Item value={option} class="ui-control segment">{option}</ToggleGroup.Item>
      {/each}
    </div>
  {/snippet}
</ToggleGroup.Root>

<style>
  :global(.segmented-control) { display: flex; padding: 2px; gap: 2px; border: 1px solid var(--color-chrome-border); border-radius: 5px; background: var(--color-surface-1); }
  :global(.segmented-control .segment) { flex: 1; min-width: 0; padding: 4px 6px; border: 1px solid transparent; border-radius: 3px; text-transform: capitalize; cursor: pointer; color: var(--color-text-secondary); }
  :global(.segmented-control .segment:hover) { background: var(--color-hover); }
  :global(.segmented-control .segment[data-state='on']) { background: var(--color-surface-3); border-color: var(--color-border-strong); color: var(--color-text-primary); }
  :global(.segmented-control .segment:focus-visible) { outline: 2px solid var(--color-primary-accent); outline-offset: -1px; }
</style>
