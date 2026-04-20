<script lang="ts">
  import {
    vs, trackBody, lookAtBody,
    setBodyVisible, showAllBodies, hideAllBodies,
  } from '../lib/viewer-state.svelte';
  import { X, Search } from 'lucide-svelte';
  import * as Button from '$lib/components/ui/button';
  import Input from '$lib/components/ui/input/input.svelte';
  import Checkbox from '$lib/components/ui/checkbox/checkbox.svelte';

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  let search = $state('');
  let soloMode = $state(false);

  let filtered = $derived(
    search.trim()
      ? vs.bodies.filter(b => b.name.toLowerCase().includes(search.toLowerCase()))
      : vs.bodies
  );

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

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('drawer-backdrop')) onClose();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="drawer-backdrop absolute inset-0 z-30" onclick={handleBackdropClick}>
    <div class="absolute top-3 left-3 bottom-16 w-60 bg-black/90 backdrop-blur-xl border border-border rounded-lg flex flex-col animate-slide-in overflow-hidden">
      <!-- Header -->
      <div class="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5 shrink-0">
        <span class="text-[13px] font-semibold text-text-primary">Bodies</span>
        <span class="text-[10px] text-text-muted bg-surface-3 px-1.5 py-px rounded-full">{vs.bodies.length}</span>
        <button class="ml-auto bg-transparent border-none text-text-muted cursor-pointer p-0.5 rounded hover:text-text-primary" onclick={onClose}><X size={14} /></button>
      </div>

      <!-- Search -->
      <div class="relative mx-2.5 mb-1.5 shrink-0">
        <Search size={12} class="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
        <Input bind:value={search} type="text" placeholder="Search..." class="pl-7 h-7 text-[12px] bg-surface-3 border-border" />
      </div>

      <!-- Controls -->
      <div class="flex gap-1 px-2.5 pb-2 border-b border-border shrink-0">
        <Button.Root variant="outline" size="sm" class="h-6 text-[11px] px-2" onclick={showAllBodies}>Show All</Button.Root>
        <Button.Root variant="outline" size="sm" class="h-6 text-[11px] px-2" onclick={hideAllBodies}>Hide All</Button.Root>
        <Button.Root variant={soloMode ? 'default' : 'outline'} size="sm" class="h-6 text-[11px] px-2" onclick={() => soloMode = !soloMode}>Solo</Button.Root>
      </div>

      <!-- Body list -->
      <div class="flex-1 overflow-y-auto py-1 px-1.5">
        {#each filtered as body (body.name)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="flex items-center gap-1.5 px-1.5 py-0.5 rounded cursor-pointer text-[12px] transition-colors hover:bg-surface-3 {body.name === vs.lookAtBodyName ? 'bg-accent-muted' : ''}"
            onclick={() => handleBodyClick(body.name)}
            oncontextmenu={(e) => handleBodyContext(e, body.name)}
            title={body.classification ?? body.name}
          >
            <Checkbox
              checked={body.visible}
              onCheckedChange={(v: boolean | 'indeterminate') => { setBodyVisible(body.name, v === true); }}
              class="h-3.5 w-3.5"
              onclick={(e: MouseEvent) => e.stopPropagation()}
            />
            <span class="truncate {body.visible ? 'text-text-primary' : 'text-text-muted'} {body.name === vs.lookAtBodyName ? 'text-accent italic' : ''}">{body.name}</span>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  @keyframes slide-in {
    from { transform: translateX(-100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  .animate-slide-in { animation: slide-in 0.15s ease; }
</style>
