<script lang="ts">
  /**
   * The persistent tool rail — icon width and nothing more.
   *
   * #59 is specific that this stays narrow and icon-first, and that expanded
   * surfaces (the catalog above all) are *separate* contextual instruments
   * rather than this rail growing into a navigation sidebar. So the rail only
   * ever opens things; it never contains them.
   *
   * Two groups: the instruments from the shell's `TOOLS` table, then the scene
   * controls that act on the viewport directly rather than opening a surface.
   * Compact layout lays the same buttons out horizontally above the timeline —
   * the same controls in a different presentation, not a separate mobile bar.
   */
  import { Crosshair, Camera, Info, Keyboard } from 'lucide-svelte';
  import { TOOLS, shell, isToolOpen, toggleTool, type ToolDef } from '../../lib/shell.svelte';
  import { vs, cycleCamera, selectBody } from '../../lib/viewer-state.svelte';

  interface Props {
    pickModeActive: boolean;
    onTogglePick: () => void;
  }

  let { pickModeActive, onTogglePick }: Props = $props();

  const compact = $derived(shell.layout === 'compact');

  function hint(tool: ToolDef): string {
    return tool.shortcut ? `${tool.label} (${tool.shortcut.toUpperCase()})` : tool.label;
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

<nav
  bind:clientHeight={shell.railHeight}
  aria-label="Tools"
  class="pointer-events-auto absolute z-20 flex gap-0.5 rounded-lg border border-border bg-panel backdrop-blur-md p-1"
  class:flex-col={!compact}
  class:left-3={!compact}
  class:top-3={!compact}
  class:inset-x-2={compact}
  class:justify-center={compact}
  style={compact ? 'bottom: calc(var(--size-timeline) + 0.5rem)' : undefined}
>
  {#each TOOLS as tool (tool.id)}
    {@const Icon = tool.icon}
    <button
      class="rail-btn"
      aria-pressed={isToolOpen(tool.id)}
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

  <button
    class="rail-btn"
    aria-pressed={shell.shortcutsOpen}
    aria-label="Keyboard shortcuts"
    title="Keyboard shortcuts"
    onclick={() => (shell.shortcutsOpen = !shell.shortcutsOpen)}
  >
    <Keyboard size={16} />
  </button>
</nav>

<style>
  /* 36px square: the smallest that still takes a thumb reliably, which is what
     keeps the rail usable on a phone without inventing a second mobile control
     (#59 — hit targets, and no hover-only functionality). */
  .rail-btn {
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
