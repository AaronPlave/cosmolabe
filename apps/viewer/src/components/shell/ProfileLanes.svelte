<script lang="ts">
  /**
   * The continuous-profile rows of the timeline (#65): every configured
   * `continuous-profile` item in the shared analysis model, stacked in row
   * order against the transport track's axis, directly after the event lanes
   * — one run of rows, with no section row between them. Adding a profile is
   * the timeline header's `AddProfile`.
   *
   * No row is built in. Distance, relative speed, range rate and phase angle
   * are the starting vocabulary, not a fixed chart set; each row picks its own
   * quantity and pair, and any number of them can coexist.
   */
  import { configuredProfiles } from '../../lib/analysis.svelte';
  import { timeline, profileRowHeight, type ProfileEventTick } from '../../lib/timeline.svelte';
  import ProfileRow from './ProfileRow.svelte';

  interface Props {
    axisWidth: number;
    wide: boolean;
    ticks: readonly ProfileEventTick[];
    /** Event lanes above: the first profile marks the change of row type. */
    afterLanes: boolean;
  }

  let { axisWidth, wide, ticks, afterLanes }: Props = $props();

  // Disabled items are out of the analysis, as with event lanes. Hidden ones
  // stay listed (dimmed, with their eye toggle) so they can be shown again.
  const profiles = $derived(configuredProfiles().filter((item) => item.enabled));
</script>

{#each profiles as item, i (item.id)}
  <ProfileRow
    {item} {axisWidth} {wide} {ticks}
    height={profileRowHeight(!!timeline.expandedRows[item.id], wide)}
    first={i === 0}
    last={i === profiles.length - 1}
    boundary={i === 0 && afterLanes}
  />
{/each}
