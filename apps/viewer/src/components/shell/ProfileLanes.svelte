<script lang="ts">
  /**
   * The continuous-profile depth of the timeline (#65): every configured
   * `continuous-profile` item in the shared analysis model, stacked in row
   * order against the transport track's axis, plus the affordance that adds
   * one.
   *
   * No row is built in. Distance, relative speed, range rate and phase angle
   * are the starting vocabulary, not a fixed chart set; each row picks its own
   * quantity and pair, and any number of them can coexist.
   */
  import type { ContinuousProfileConfiguration } from '@cosmolabe/core';
  import { vs } from '../../lib/viewer-state.svelte';
  import { analysis, configuredProfiles, createConfiguredProfile } from '../../lib/analysis.svelte';
  import { profileQuantity } from '../../lib/profile-sampling';
  import type { ProfileEventTick } from '../../lib/timeline.svelte';
  import { Plus } from 'lucide-svelte';
  import * as Popover from '$lib/components/ui/popover';
  import ProfileRow from './ProfileRow.svelte';
  import ProfileConfig from './ProfileConfig.svelte';

  interface Props {
    axisLeft: number;
    axisWidth: number;
    wide: boolean;
    ticks: readonly ProfileEventTick[];
  }

  let { axisLeft, axisWidth, wide, ticks }: Props = $props();

  const profiles = $derived(configuredProfiles());

  let addOpen = $state(false);

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
    addOpen = false;
  }
</script>

{#each profiles as item, i (item.id)}
  <ProfileRow
    {item} {axisLeft} {axisWidth} {wide} {ticks}
    first={i === 0}
    last={i === profiles.length - 1}
  />
{/each}

<div class="lanes-footer" class:empty={profiles.length === 0}>
  <div
    class="footer-add"
    style={wide ? `left: 0; width: ${Math.max(0, axisLeft - 8)}px; justify-content: flex-end` : `left: ${axisLeft}px`}
  >
    <Popover.Root bind:open={addOpen}>
      <Popover.Trigger class="add-profile-btn" title="Add a continuous profile to the timeline">
        <Plus size={11} /> Profile
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" sideOffset={8} class="w-72 p-3">
          {#if addOpen}
            <ProfileConfig initial={seed()} submitLabel="Add" onSubmit={add} />
          {/if}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>
  {#if profiles.length === 0}
    <span class="footer-hint" style="left: {wide ? axisLeft : axisLeft + 72}px; width: {wide ? axisWidth : Math.max(0, axisWidth - 72)}px">
      Plot distance, speed, range rate or phase angle on this axis
    </span>
  {/if}
</div>

<style>
  .lanes-footer {
    position: relative;
    height: 22px;
    border-top: 1px solid var(--color-chrome-divider);
  }
  .lanes-footer.empty {
    border-top: none;
  }
  .footer-add {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
  }
  :global(.add-profile-btn) {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-muted);
    font-size: var(--text-metadata);
    cursor: pointer;
    white-space: nowrap;
  }
  :global(.add-profile-btn:hover) {
    color: var(--color-text-primary);
    background: var(--color-control-hover);
  }
  .footer-hint {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    overflow: hidden;
    color: var(--color-text-muted);
    font-size: var(--text-metadata);
    white-space: nowrap;
    text-overflow: ellipsis;
    pointer-events: none;
  }
</style>
