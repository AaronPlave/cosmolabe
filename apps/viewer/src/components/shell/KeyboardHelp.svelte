<script lang="ts">
  import { X } from 'lucide-svelte';
  import { KEYMAP } from '../../lib/keymap';
  import { shell } from '../../lib/shell.svelte';

  const groups = $derived.by(() => [...new Set(KEYMAP.map(binding => binding.category))].map(category => ({
    category,
    bindings: KEYMAP.filter(binding => binding.category === category),
  })));
</script>

{#if shell.shortcutsOpen}
  <dialog
    open
    data-scene-occluder
    class="m-0 fixed bottom-[calc(var(--size-dock-base)+0.75rem)] left-[calc(var(--size-rail)+0.75rem)] z-40 w-[min(42rem,calc(100vw-1.5rem))] max-h-[min(32rem,55vh)] overflow-y-auto rounded-md border border-border bg-panel/95 p-3 text-text-primary shadow-xl backdrop-blur-md"
    aria-label="Keyboard shortcuts"
  >
    <header class="mb-3 flex items-center justify-between border-b border-border-subtle pb-2">
      <h2 class="m-0 text-sm font-semibold">Keyboard shortcuts</h2>
      <button class="grid h-7 w-7 place-items-center rounded text-text-muted hover:bg-control-hover hover:text-text-primary" aria-label="Close keyboard help" title="Close keyboard help" onclick={() => shell.shortcutsOpen = false}>
        <X size={15} />
      </button>
    </header>
    <div class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {#each groups as group (group.category)}
        <section aria-label={group.category}>
          <h3 class="mb-1 text-metadata font-semibold uppercase text-text-faint">{group.category}</h3>
          <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {#each group.bindings as binding (binding.id)}
              <dt class="m-0 self-center">
                <kbd class="rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-mono text-metadata text-text-secondary">{binding.display}</kbd>
              </dt>
              <dd class="m-0 self-center text-xs text-text-secondary">{binding.label}</dd>
            {/each}
          </dl>
        </section>
      {/each}
    </div>
  </dialog>
{/if}