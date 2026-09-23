<script lang="ts">
  /**
   * The persistent tool rail — icon width and nothing more.
   *
   * #59 is specific that this stays narrow and icon-first, and that expanded
   * surfaces (the catalog above all) are *separate* contextual instruments
   * rather than this rail growing into a navigation sidebar. So the rail only
   * ever opens things; it never contains them.
   *
   * Compact gives it a second job. With one sheet on screen at a time, the rail
   * is also the switcher: a press on the visible instrument puts it away, a
   * press on any other brings it forward. Nothing closes, so nothing is lost —
   * which is why a minimized tool reads differently here from a closed one.
   *
   * `inline` drops the rail's own box so the compact layout can fold it into
   * one bottom dock with the timeline, instead of stacking two bordered bars.
   *
   * The compact row scrolls rather than squeezing. It fits today; it will not
   * once #58's event kinds and #57's measurement tools arrive, and a row that
   * silently drops its last button is a worse failure than one that scrolls.
   *
   * The first button opens the catalog switcher (#94). It is not the Catalog
   * tool: that browses the bodies of the loaded scene, this replaces the scene.
   */
  import { Search, Crosshair, Camera, Info, Keyboard, FolderOpen } from 'lucide-svelte';
  import * as Popover from '$lib/components/ui/popover';
  import CatalogMenu from './CatalogMenu.svelte';
  import type { CatalogEntry } from '../../lib/catalog-sources';
  import { TOOLS, shell, isToolOpen, isMinimized, toggleTool, type ToolDef } from '../../lib/shell.svelte';
  import { vs, cycleCamera, selectBody } from '../../lib/viewer-state.svelte';

  interface Props {
    pickModeActive: boolean;
    onTogglePick: () => void;
    onOpenSearch: () => void;
    /** A catalog chosen from the switcher. */
    onSelectCatalog: (sourceId: string, entry: CatalogEntry) => void;
    /** Local files chosen from the switcher. */
    onOpenFiles: (files: File[]) => void;
    /** Render bare, for a parent that supplies the surrounding chrome. */
    inline?: boolean;
  }

  let { pickModeActive, onTogglePick, onOpenSearch, onSelectCatalog, onOpenFiles, inline = false }: Props = $props();

  const compact = $derived(shell.layout === 'compact');

  function hint(tool: ToolDef): string {
    return tool.shortcut ? `${tool.label} (${tool.shortcut.toUpperCase()})` : tool.label;
  }

  /**
   * A tool can be in three states, and the button has to say which: closed,
   * open and showing, or open but put away. The third is the one worth marking
   * — it is what tells the user their search is still there.
   */
  function state(tool: ToolDef): 'closed' | 'active' | 'stowed' {
    if (!isToolOpen(tool.id)) return 'closed';
    if (isMinimized(tool.id)) return 'stowed';
    if (compact && tool.presentation === 'panel' && shell.activeSheet !== tool.id) return 'stowed';
    return 'active';
  }

  /**
   * The body info panel is driven by the selection rather than by an open flag,
   * so its rail button acts on the selection: clear it, or — with nothing
   * selected — select whatever the camera is tracking.
   */
  function toggleInfo() {
    if (vs.selectedBodyName) selectBody(null);
    else if (vs.trackedBodyName) selectBody(vs.trackedBodyName);
  }
</script>

{#snippet buttons()}
  <Popover.Root bind:open={shell.catalogMenuOpen}>
    <Popover.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          class="rail-btn"
          aria-label="Open catalog"
          title={vs.catalogName ? `Open catalog (O) — current: ${vs.catalogName}` : 'Open catalog (O)'}
        >
          <FolderOpen size={16} />
        </button>
      {/snippet}
    </Popover.Trigger>
    <CatalogMenu
      onSelect={onSelectCatalog}
      onFiles={onOpenFiles}
      close={() => (shell.catalogMenuOpen = false)}
    />
  </Popover.Root>

  <div class="rail-divider" class:horizontal={compact}></div>

  <button
    class="rail-btn"
    aria-label="Search commands"
    title="Search commands (Cmd+K)"
    onclick={onOpenSearch}
  >
    <Search size={16} />
  </button>

  <div class="rail-divider" class:horizontal={compact}></div>

  {#each TOOLS as tool (tool.id)}
    {@const Icon = tool.icon}
    {@const s = state(tool)}
    <button
      class="rail-btn"
      class:stowed={s === 'stowed'}
      aria-pressed={s === 'active'}
      aria-label={tool.label}
      title={hint(tool)}
      onclick={() => toggleTool(tool.id)}
    >
      <Icon size={16} />
    </button>
  {/each}

  <div class="rail-divider" class:horizontal={compact}></div>

  <button
    class="rail-btn"
    aria-pressed={pickModeActive}
    aria-label="Pick surface"
    title="Pick surface (P)"
    onclick={onTogglePick}
  >
    <Crosshair size={16} />
  </button>

  <button class="rail-btn" aria-label="Camera mode" title="Camera mode (M)" onclick={() => cycleCamera()}>
    <Camera size={16} />
  </button>

  <button
    class="rail-btn"
    aria-pressed={!!vs.selectedBodyName}
    aria-label="Body info"
    title="Body info"
    onclick={toggleInfo}
  >
    <Info size={16} />
  </button>

  {#if !compact}
    <button
      class="rail-btn"
      aria-pressed={shell.shortcutsOpen}
      aria-label="Keyboard shortcuts"
      title="Keyboard shortcuts"
      onclick={() => (shell.shortcutsOpen = !shell.shortcutsOpen)}
    >
      <Keyboard size={16} />
    </button>
  {/if}
{/snippet}

<nav
  aria-label="Tools"
  class="rail flex"
  class:pointer-events-auto={!inline}
  class:absolute={!inline}
  class:z-20={!inline}
  class:desktop-rail={!inline && !compact}
  class:flex-col={!compact}
  class:gap-0.5={!compact}
  class:overflow-x-auto={compact}
  class:px-1={inline}
  class:py-1={inline}
>
  {#if compact}
    <!-- The buttons get their own row so centring and scrolling do not fight:
         `justify-center` on a scroll container clips the overflow at the
         *start*, putting the first tools permanently out of reach. `margin:
         auto` centres while there is room and gives way once there is not. -->
    <div class="m-auto flex shrink-0 gap-0.5">{@render buttons()}</div>
  {:else}
    {@render buttons()}
  {/if}
</nav>

<style>
  .rail {
    /* The compact row is a scroller; its scrollbar would be chrome on chrome. */
    scrollbar-width: none;
  }
  .desktop-rail {
    top: 0;
    left: 0;
    width: var(--size-rail);
    height: fit-content;
    max-height: calc(100% - var(--size-bottom-chrome) - 8px);
    box-sizing: border-box;
    padding: 10px 6px;
    border-right: 1px solid var(--color-chrome-border);
    border-bottom: 1px solid var(--color-chrome-border);
    border-bottom-right-radius: var(--radius-md);
    background: var(--color-panel);
    box-shadow: inset -1px 0 rgba(255, 255, 255, 0.015);
    backdrop-filter: blur(8px);
    overflow-y: auto;
  }
  .rail::-webkit-scrollbar {
    display: none;
  }

  /* Desktop stays compact without clipping its hover ground. Compact retains
     larger touch targets below. */
  .rail-btn {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    opacity: 0.82;
    cursor: pointer;
    transition:
      color var(--duration-chrome) var(--ease-chrome),
      background var(--duration-chrome) var(--ease-chrome),
      transform var(--duration-chrome) var(--ease-chrome);
  }
  .rail-btn:hover {
    color: var(--color-text-primary);
    background: var(--color-control-hover);
    opacity: 1;
  }
  .rail-btn:active {
    transform: scale(0.94);
  }
  /* Active state is monochrome and low-salience: selection and mission data
     own the strong colors in this UI, chrome does not. */
  .rail-btn[aria-pressed='true'],
  .rail-btn[aria-expanded='true'] {
    color: var(--color-chrome-active);
    background: var(--color-chrome-active-bg);
    opacity: 1;
  }
  .rail-btn[aria-pressed='true']::before,
  .rail-btn[aria-expanded='true']::before {
    content: '';
    position: absolute;
    left: -4px;
    width: 2px;
    height: 14px;
    border-radius: 2px;
    background: var(--color-chrome-active);
  }
  /* Open but put away: muted chrome plus a marker. Distinct
     from both a closed tool and the one on screen, because "your search is
     still here" is exactly what a user who minimized something needs to see. */
  .rail-btn.stowed {
    color: var(--color-text-secondary);
    opacity: 0.72;
  }
  .rail-btn :global(svg) {
    stroke-width: 1.75;
  }
  .rail-btn.stowed::after {
    content: '';
    position: absolute;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--color-chrome-active);
    transform: translate(0, 13px);
  }

  .rail-divider {
    height: 1px;
    margin: 5px 7px;
    background: var(--color-border-default);
  }
  .rail-divider.horizontal {
    height: 24px;
    width: 1px;
    margin: 6px 2px;
    align-self: center;
  }

  @media (max-width: 719px) {
    .rail-btn {
      width: 42px;
      height: 42px;
    }
    .rail-btn[aria-pressed='true']::before,
    .rail-btn[aria-expanded='true']::before {
      left: 50%;
      top: auto;
      bottom: -4px;
      width: 14px;
      height: 2px;
      transform: translateX(-50%);
    }
    .rail-btn.stowed::after {
      transform: translate(0, 15px);
    }
  }
</style>
