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
   */
  import { Crosshair, Camera, Info, Keyboard } from 'lucide-svelte';
  import { TOOLS, shell, isToolOpen, isMinimized, toggleTool, type ToolDef } from '../../lib/shell.svelte';
  import { vs, cycleCamera, selectBody } from '../../lib/viewer-state.svelte';

  interface Props {
    pickModeActive: boolean;
    onTogglePick: () => void;
    /** Render bare, for a parent that supplies the surrounding chrome. */
    inline?: boolean;
  }

  let { pickModeActive, onTogglePick, inline = false }: Props = $props();

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
  class:rounded-lg={!inline}
  class:border={!inline}
  class:border-border={!inline}
  class:bg-panel={!inline}
  class:backdrop-blur-md={!inline}
  class:p-1={!inline}
  class:flex-col={!compact}
  class:gap-0.5={!compact}
  class:left-3={!inline && !compact}
  class:top-3={!inline && !compact}
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
  .rail::-webkit-scrollbar {
    display: none;
  }

  /* 36px square: the smallest that still takes a thumb reliably, which is what
     keeps the rail usable on a phone without inventing a second mobile control
     (#59 — hit targets, and no hover-only functionality). */
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
    cursor: pointer;
    transition: color 0.1s, background 0.1s;
  }
  .rail-btn:hover {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
  }
  /* Active state is a low-salience accent, not a filled block: selection and
     mission data own the strong colors in this UI, chrome does not. */
  .rail-btn[aria-pressed='true'] {
    color: var(--color-accent);
    background: var(--color-accent-muted);
  }
  /* Open but put away: the accent without the ground, plus a marker. Distinct
     from both a closed tool and the one on screen, because "your search is
     still here" is exactly what a user who minimized something needs to see. */
  .rail-btn.stowed {
    color: var(--color-accent);
    opacity: 0.65;
  }
  .rail-btn.stowed::after {
    content: '';
    position: absolute;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--color-accent);
    transform: translate(0, 13px);
  }

  .rail-divider {
    height: 1px;
    margin: 2px 4px;
    background: var(--color-border);
  }
  .rail-divider.horizontal {
    height: 24px;
    width: 1px;
    margin: 6px 2px;
    align-self: center;
  }
</style>
