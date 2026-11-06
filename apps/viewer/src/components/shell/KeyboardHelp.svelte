<script lang="ts">
  /** Keyboard reference for the rail's help popover, grouped, with what is unavailable in the current camera mode marked. */
  import { KEYMAP } from '../../lib/keymap';
  import { vs, getRenderer } from '../../lib/viewer-state.svelte';

  // Dolly, crane and WASD flight need a camera that is not placed by its frame.
  const movesAvailable = $derived((vs.cameraMode, getRenderer()?.cameraController.acceptsOrbitMoves ?? false));
  const needsMoves = (id: string) => id.startsWith('camera:') || id.startsWith('cam:dolly-') || id.startsWith('cam:crane-');

  const groups = $derived([...new Set(KEYMAP.map(binding => binding.category))].map(category => ({
    category,
    bindings: KEYMAP.filter(binding => binding.category === category).map(binding => ({
      ...binding,
      unavailable: needsMoves(binding.id) && !movesAvailable,
    })),
  })));
</script>

<div class="flex max-h-[min(32rem,calc(100cqh-1.5rem))] flex-col gap-3 overflow-y-auto">
  {#each groups as group (group.category)}
    <section aria-label={group.category}>
      <h3 class="mb-1 text-metadata font-semibold uppercase text-text-faint">{group.category}</h3>
      <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {#each group.bindings as binding (binding.id)}
          <dt class="m-0 self-center" class:opacity-50={binding.unavailable}>
            <kbd class="rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-mono text-metadata text-text-secondary">{binding.display}</kbd>
          </dt>
          <dd class="m-0 self-center text-xs text-text-secondary" class:opacity-50={binding.unavailable}>
            {binding.label}{#if binding.unavailable}<span class="text-text-faint"> · not in this camera mode</span>{/if}
          </dd>
        {/each}
      </dl>
    </section>
  {/each}
</div>
