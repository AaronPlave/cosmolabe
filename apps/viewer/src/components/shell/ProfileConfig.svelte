<script lang="ts">
  /**
   * Add / configure one continuous profile — the quantity and the pair it is
   * measured between. Lives in a popover off the row label rather than in a
   * settings panel, so configuring a row happens next to the row.
   *
   * A role left on "Shared" stays unset in the configuration and resolves
   * through the shared analysis relationship (#60) at sampling time; picking a
   * body pins it, so one row can compare a different pair from the rest.
   */
  import type { ContinuousProfileConfiguration, EventParticipants } from '@cosmolabe/core';
  import { vs } from '../../lib/viewer-state.svelte';
  import { analysis } from '../../lib/analysis.svelte';
  import { PROFILE_QUANTITIES } from '../../lib/profile-sampling';
  import Button from '$lib/components/ui/button/button.svelte';
  import { ArrowDown, ArrowUp, Eye, EyeOff, Trash2 } from 'lucide-svelte';

  interface Props {
    initial: ContinuousProfileConfiguration;
    submitLabel: string;
    onSubmit: (profile: ContinuousProfileConfiguration) => void;
    /** Present when editing an existing row. */
    visible?: boolean;
    onToggleVisible?: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onRemove?: () => void;
  }

  let {
    initial, submitLabel, onSubmit,
    visible, onToggleVisible, onMoveUp, onMoveDown, onRemove,
  }: Props = $props();

  // Form-local copies; the popover remounts this on each open.
  // svelte-ignore state_referenced_locally
  let quantity = $state(initial.quantity);
  // svelte-ignore state_referenced_locally
  let observer = $state(initial.bodies?.observer ?? '');
  // svelte-ignore state_referenced_locally
  let target = $state(initial.bodies?.target ?? '');
  // svelte-ignore state_referenced_locally
  let illuminator = $state(initial.bodies?.illuminator ?? '');

  function sharedLabel(role: 'observer' | 'target' | 'illuminator'): string {
    const shared = analysis.bodies[role];
    if (shared) return `Shared (${shared})`;
    if (role === 'observer' && vs.trackedBodyName) return `Shared (tracked: ${vs.trackedBodyName})`;
    if (role === 'illuminator') return 'Shared (Sun)';
    return 'Shared (none)';
  }

  function submit() {
    const bodies: EventParticipants = {};
    if (observer) bodies.observer = observer;
    if (target) bodies.target = target;
    if (quantity === 'phase-angle' && illuminator) bodies.illuminator = illuminator;
    onSubmit({ ...initial, quantity, bodies });
  }

  const selectClass = 'ui-control min-w-0 flex-1 bg-surface-3 text-text-primary border border-border rounded px-1.5 py-1 cursor-pointer outline-none';
</script>

<div class="flex flex-col gap-1.5">
  <label class="flex items-center gap-2">
    <span class="ui-label w-12 shrink-0">Quantity</span>
    <select class={selectClass} bind:value={quantity}>
      {#each PROFILE_QUANTITIES as q}
        <option value={q.id}>{q.label}</option>
      {/each}
    </select>
  </label>

  {#snippet bodyPicker(label: string, role: 'observer' | 'target' | 'illuminator', value: string, set: (v: string) => void)}
    <label class="flex items-center gap-2">
      <span class="ui-label w-12 shrink-0">{label}</span>
      <select class={selectClass} {value} onchange={(e) => set((e.target as HTMLSelectElement).value)}>
        <option value="">{sharedLabel(role)}</option>
        {#each vs.bodies as body}
          <option value={body.name}>{body.name}{body.name === vs.trackedBodyName ? ' (tracked)' : ''}</option>
        {/each}
      </select>
    </label>
  {/snippet}

  {@render bodyPicker('From', 'observer', observer, (v) => observer = v)}
  {@render bodyPicker('To', 'target', target, (v) => target = v)}
  {#if quantity === 'phase-angle'}
    {@render bodyPicker('Light', 'illuminator', illuminator, (v) => illuminator = v)}
  {/if}

  {#if onToggleVisible || onMoveUp || onMoveDown || onRemove}
    <!-- Row actions: showing it, where it sits among the profiles, and — last,
         and quiet until hovered — removing it. -->
    <div class="mt-1 flex items-center gap-1 border-t border-border pt-2">
      {#if onToggleVisible}
        <button class="cfg-action" onclick={onToggleVisible}>
          {#if visible}<EyeOff size={12} /> Hide{:else}<Eye size={12} /> Show{/if}
        </button>
      {/if}
      {#if onMoveUp || onMoveDown}
        <span class="cfg-move" role="group" aria-label="Move row">
          <button class="cfg-action" onclick={onMoveUp} disabled={!onMoveUp} aria-label="Move row up" title="Move row up">
            <ArrowUp size={12} />
          </button>
          <button class="cfg-action" onclick={onMoveDown} disabled={!onMoveDown} aria-label="Move row down" title="Move row down">
            <ArrowDown size={12} />
          </button>
        </span>
      {/if}
      <span class="flex-1"></span>
      {#if onRemove}
        <button class="cfg-action danger" onclick={onRemove}><Trash2 size={12} /> Remove</button>
      {/if}
    </div>
  {/if}
  <div class="flex justify-end">
    <Button size="sm" onclick={submit}>{submitLabel}</Button>
  </div>
</div>

<style>
  .cfg-action {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 6px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-label);
    cursor: pointer;
  }
  .cfg-action:hover:not(:disabled) {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
  }
  .cfg-action:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .cfg-move {
    display: inline-flex;
    align-items: center;
  }
  .cfg-move::before {
    content: 'Move';
    margin: 0 2px 0 6px;
    color: var(--color-text-muted);
    font-size: var(--text-metadata);
  }
  .cfg-action.danger {
    color: var(--color-text-muted);
  }
  .cfg-action.danger:hover {
    color: var(--color-error);
  }
</style>
