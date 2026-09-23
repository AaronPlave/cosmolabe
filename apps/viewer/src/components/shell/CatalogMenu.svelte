<script lang="ts">
  /**
   * The in-viewer catalog switcher (issue #94): the catalog chooser in a small
   * popover off the rail, floating over the scene — not a modal, not a
   * header, and not the rail expanding into a sidebar.
   *
   * Kept apart from the Catalog tool on purpose. That panel browses the
   * *contents* of the loaded catalog — bodies, spacecraft, systems — and
   * turning it into a way to replace the scene would mix "what is in this
   * scene" with "which scene". This one only lists catalogs to open.
   *
   * Opening it touches nothing: the scene stays up until a replacement is
   * chosen, and choosing one goes through the normal loader like any other
   * load.
   *
   * Rendered inside the rail's `Popover.Root`, so the rail owns the trigger
   * (and its styling) and this owns what the popover shows. Compact anchors it
   * to the whole bottom dock rather than the button, so it rises above the
   * dock as a full-width sheet instead of covering the transport.
   */
  import * as Popover from '$lib/components/ui/popover';
  import CatalogChooser, { CHOOSER_SURFACE, CHOOSER_OVER_SCENE } from '../CatalogChooser.svelte';
  import { shell } from '../../lib/shell.svelte';
  import { vs } from '../../lib/viewer-state.svelte';
  import type { CatalogEntry } from '../../lib/catalog-sources';

  interface Props {
    onSelect: (sourceId: string, entry: CatalogEntry) => void;
    onFiles: (files: File[]) => void;
    close: () => void;
  }

  let { onSelect, onFiles, close }: Props = $props();

  const compact = $derived(shell.layout === 'compact');
</script>

<Popover.Content
  side={compact ? 'top' : 'right'}
  align={compact ? 'center' : 'start'}
  sideOffset={compact ? 8 : 22}
  alignOffset={compact ? 0 : 4}
  collisionPadding={8}
  customAnchor={compact ? '.compact-dock' : null}
  class="{CHOOSER_SURFACE} {CHOOSER_OVER_SCENE} {compact ? 'compact w-[calc(100vw-1rem)]' : 'w-[300px]'}"
  onEscapeKeydown={(e) => {
    // Handled: tell the viewer's own Escape handling not to also dismiss a
    // panel behind the popover.
    e.preventDefault();
    close();
  }}
>
  <CatalogChooser {onSelect} {onFiles} {close} currentName={vs.catalogName} />
</Popover.Content>
