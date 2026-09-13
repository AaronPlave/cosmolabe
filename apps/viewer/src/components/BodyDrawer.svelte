<script lang="ts">
  import {
    vs,
    trackBody,
    lookAtBody,
    setBodyVisible,
    showAllBodies,
    hideAllBodies,
    type BodyEntry,
  } from "../lib/viewer-state.svelte";
  import { Search, ChevronRight, Eye, EyeClosed } from "lucide-svelte";
  import { toolDef } from "../lib/shell.svelte";
  import InstrumentPanel from './shell/InstrumentPanel.svelte';
  import * as Button from "$lib/components/ui/button";
  import Input from "$lib/components/ui/input/input.svelte";

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let search = $state("");
  let soloMode = $state(false);
  let collapsed = $state<Set<string>>(new Set());

  interface TreeNode {
    body: BodyEntry;
    children: TreeNode[];
  }

  /** Build tree from flat body list using parentName */
  function buildTree(bodies: BodyEntry[]): TreeNode[] {
    const byName = new Map<string, TreeNode>();
    const roots: TreeNode[] = [];

    // Create nodes
    for (const b of bodies) {
      byName.set(b.name, { body: b, children: [] });
    }

    // Link children to parents
    for (const b of bodies) {
      const node = byName.get(b.name)!;
      if (b.parentName && byName.has(b.parentName)) {
        byName.get(b.parentName)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  let tree = $derived(buildTree(vs.bodies));

  /** When searching, flatten to matching bodies (ignore tree structure) */
  let searchResults = $derived(
    search.trim()
      ? vs.bodies.filter((b) =>
          b.name.toLowerCase().includes(search.toLowerCase()),
        )
      : null,
  );

  let isSearching = $derived(searchResults !== null);

  function toggleCollapse(name: string) {
    const next = new Set(collapsed);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    collapsed = next;
  }

  function handleBodyClick(name: string) {
    if (soloMode) {
      hideAllBodies();
      setBodyVisible(name, true);
      soloMode = false;
    } else {
      trackBody(name);
    }
  }

  function handleBodyContext(e: MouseEvent, name: string) {
    e.preventDefault();
    lookAtBody(name);
  }

</script>

{#snippet bodyRow(body: BodyEntry, indent: number)}
  <div
    class="flex items-center gap-1 py-0.5 rounded text-[12px] transition-colors hover:bg-surface-3 {body.name ===
    vs.lookAtBodyName
      ? 'bg-accent-muted'
      : ''}"
    style="padding-left: {indent}px; padding-right: 6px;"
  >
    <button
      class="shrink-0 bg-transparent border-none cursor-pointer p-0.5 rounded transition-colors text-text-primary hover:opacity-100 opacity-50"
      onclick={() => setBodyVisible(body.name, !body.visible)}
      title={body.visible ? "Hide" : "Show"}
    >
      {#if body.visible}<Eye size={16} />{:else}<EyeClosed size={16} />{/if}
    </button>
    <button
      class="flex-1 min-w-0 flex items-center gap-8 bg-transparent border-none cursor-pointer text-left p-0"
      onclick={() => handleBodyClick(body.name)}
      oncontextmenu={(e) => handleBodyContext(e, body.name)}
      title={body.classification ?? body.name}
    >
      <span
        class="truncate {body.visible
          ? 'text-text-primary'
          : 'text-text-muted'} {body.name === vs.lookAtBodyName
          ? 'text-accent italic'
          : ''}">{body.name}</span
      >
      {#if body.classification}
        <span class="ml-auto text-[10px] text-text-muted shrink-0"
          >{body.classification}</span
        >
      {/if}
    </button>
  </div>
{/snippet}

<!-- Chevron width = ~18px (12px icon + 6px padding). Leaf nodes get that as extra left indent. -->
{#snippet treeNode(node: TreeNode, depth: number)}
  {@const indent = 4 + depth * 16}
  {#if node.children.length > 0}
    <div>
      <div class="flex items-center gap-1">
        <button
          class="shrink-0 bg-transparent border-none text-text-muted cursor-pointer p-0.5 transition-transform {collapsed.has(
            node.body.name,
          )
            ? ''
            : 'rotate-90'}"
          style="margin-left: {indent}px;"
          onclick={(e) => {
            e.stopPropagation();
            toggleCollapse(node.body.name);
          }}
        >
          <ChevronRight size={14} />
        </button>
        <div class="flex-1 min-w-0">
          {@render bodyRow(node.body, 0)}
        </div>
      </div>
      {#if !collapsed.has(node.body.name)}
        {#each node.children as child (child.body.name)}
          {@render treeNode(child, depth + 1)}
        {/each}
      {/if}
    </div>
  {:else}
    {@render bodyRow(node.body, indent + 18)}
  {/if}
{/snippet}

<InstrumentPanel key="catalog" title="Bodies" width={toolDef('catalog').width} {onClose}>
  {#snippet actions()}
    <span class="rounded-full bg-surface-3 px-1.5 py-px text-[10px] text-text-muted">
      {vs.bodies.length}
    </span>
  {/snippet}

  <!-- Keep the catalog useful for large body sets without letting it become a
       full-height drawer. The shared panel body handles the outer scrolling. -->
  <div class="flex max-h-[28rem] min-h-0 flex-col">

      <!-- Search -->
      <div class="relative mb-1.5 shrink-0">
        <Search
          size={12}
          class="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
        />
        <Input
          bind:value={search}
          type="text"
          placeholder="Search..."
          class="pl-7 h-7 text-[12px] bg-surface-3 border-border"
        />
      </div>

      <!-- Controls -->
      <div class="flex gap-1 pb-2 border-b border-border shrink-0">
        <Button.Root
          variant="outline"
          size="sm"
          class="h-6 text-[11px] px-2"
          onclick={showAllBodies}>Show All</Button.Root
        >
        <Button.Root
          variant="outline"
          size="sm"
          class="h-6 text-[11px] px-2"
          onclick={hideAllBodies}>Hide All</Button.Root
        >
        <Button.Root
          variant={soloMode ? "default" : "outline"}
          size="sm"
          class="h-6 text-[11px] px-2"
          onclick={() => (soloMode = !soloMode)}>Solo</Button.Root
        >
      </div>

      <!-- Body tree / search results -->
      <div class="min-h-0 flex-1 overflow-y-auto py-1 px-1">
        {#if isSearching}
          <!-- Flat search results -->
          {#each searchResults ?? [] as body (body.name)}
            {@render bodyRow(body, 0)}
          {/each}
          {#if searchResults?.length === 0}
            <div class="text-[11px] text-text-muted text-center py-4">
              No matches
            </div>
          {/if}
        {:else}
          <!-- Hierarchical tree -->
          {#each tree as node (node.body.name)}
            {@render treeNode(node, 0)}
          {/each}
        {/if}
      </div>
  </div>
</InstrumentPanel>
