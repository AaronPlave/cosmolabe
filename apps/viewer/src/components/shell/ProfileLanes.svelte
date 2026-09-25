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
  import { timeline, profileRowHeight, type ProfileEventTick } from '../../lib/timeline.svelte';
  import { Plus } from 'lucide-svelte';
  import * as Popover from '$lib/components/ui/popover';
  import ProfileRow from './ProfileRow.svelte';
  import ProfileConfig from './ProfileConfig.svelte';

  interface Props {
    axisWidth: number;
    wide: boolean;
    ticks: readonly ProfileEventTick[];
  }

  let { axisWidth, wide, ticks }: Props = $props();

  // Disabled items are out of the analysis, as with event lanes. Hidden ones
  // stay listed (dimmed, with their eye toggle) so they can be shown again.
  const profiles = $derived(configuredProfiles().filter((item) => item.enabled));

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

<!-- The section header: where profiles start, and the way to add one. It
     sticks to the top of the scrolling region, so adding is never scrolled
     out of reach. -->
<div class="profiles-header">
  {#if profiles.length > 0}<span class="tl-secondary section-label">Profiles</span>{/if}
  <Popover.Root bind:open={addOpen}>
    <Popover.Trigger
      class="add-profile-btn {profiles.length === 0 ? 'labelled' : ''}"
      title="Add a continuous profile to the timeline"
      aria-label="Add profile"
    >
      <Plus size={12} />{#if profiles.length === 0}<span>Add profile</span>{/if}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content side="right" align="start" sideOffset={6} class="w-80 p-3">
        {#if addOpen}
          <ProfileConfig initial={seed()} submitLabel="Add" onSubmit={add} />
        {/if}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
  {#if profiles.length === 0}
    <span class="header-hint tl-secondary">Distance, speed, range rate or phase angle, on this time axis</span>
  {:else}
    <span class="rule" aria-hidden="true"></span>
  {/if}
</div>

{#each profiles as item, i (item.id)}
  <ProfileRow
    {item} {axisWidth} {wide} {ticks}
    height={profileRowHeight(!!timeline.expandedRows[item.id], wide)}
    first={i === 0}
    last={i === profiles.length - 1}
  />
{/each}

<style>
  /* One compact section control, left-aligned in the gutter's inset:
     "PROFILES +", then a faint rule across the timeline. Sticky at both
     edges: pinned under the top once scrolled past, and to the bottom while
     many lanes above would push it out of view. */
  .profiles-header {
    position: sticky;
    top: 0;
    bottom: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding-left: var(--tl-label-inset);
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    background: var(--color-panel);
  }
  .section-label {
    flex-shrink: 0;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  :global(.add-profile-btn) {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 4px;
    padding: 2px 3px;
    margin-left: 2px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--text-label);
    cursor: pointer;
    white-space: nowrap;
  }
  /* Alone, the button's text (not its padding) starts at the inset. */
  :global(.add-profile-btn.labelled) {
    margin-left: -3px;
    color: var(--color-text-primary);
  }
  :global(.add-profile-btn:hover) {
    color: var(--color-text-primary);
    background: var(--color-control-hover);
  }
  .rule {
    flex: 1;
    height: 1px;
    margin-left: 6px;
    background: rgba(255, 255, 255, 0.04);
  }
  .header-hint {
    min-width: 0;
    margin-left: 8px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
</style>
