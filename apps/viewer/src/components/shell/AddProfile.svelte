<script lang="ts">
  /**
   * "+ Profile": adds a continuous profile to the timeline. It lives in the
   * timeline's header chrome — under the transport controls on a desktop, in
   * the transport's action cluster on a phone — so adding a profile never
   * puts a divider row between the analysis rows.
   */
  import type { ContinuousProfileConfiguration } from '@cosmolabe/core';
  import { vs } from '../../lib/viewer-state.svelte';
  import { analysis, createConfiguredProfile } from '../../lib/analysis.svelte';
  import { profileQuantity } from '../../lib/profile-sampling';
  import { Plus } from 'lucide-svelte';
  import * as Popover from '$lib/components/ui/popover';
  import ProfileConfig from './ProfileConfig.svelte';

  interface Props {
    /** A phone's transport: a touch-sized button. */
    compact?: boolean;
  }

  let { compact = false }: Props = $props();

  let open = $state(false);

  /**
   * A new row starts pinned to something useful: the tracked body to the
   * selected one, or else to the shared relationship's target. Roles with
   * nothing to offer stay unset and inherit.
   */
  function seed(): ContinuousProfileConfiguration {
    const observer = vs.trackedBodyName ?? undefined;
    const candidate = vs.selectedBodyName ?? analysis.bodies.target;
    const target = candidate && candidate !== observer ? candidate : undefined;
    const bodies: ContinuousProfileConfiguration['bodies'] = {};
    if (observer) bodies.observer = observer;
    if (target) bodies.target = target;
    return { quantity: 'range', bodies };
  }

  function add(profile: ContinuousProfileConfiguration) {
    createConfiguredProfile(profile, profileQuantity(profile.quantity)?.label ?? profile.quantity);
    open = false;
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="add-profile-btn {compact ? 'compact' : ''}"
    title="Add a continuous profile — distance, speed, range rate or phase angle — on this time axis"
    aria-label="Add profile"
  >
    <Plus size={compact ? 14 : 12} /><span>Profile</span>
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content side="top" align="start" sideOffset={6} class="w-80 max-w-[calc(100vw-16px)] p-3">
      {#if open}
        <ProfileConfig initial={seed()} submitLabel="Add" onSubmit={add} />
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style>
  :global(.add-profile-btn) {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 3px;
    padding: 1px 6px 1px 4px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-label);
    white-space: nowrap;
    cursor: pointer;
  }
  :global(.add-profile-btn:hover) {
    color: var(--color-text-primary);
    background: var(--color-control-hover);
  }
  :global(.add-profile-btn.compact) {
    min-height: 34px;
    padding: 0 8px 0 6px;
    border-radius: 4px;
  }
</style>
