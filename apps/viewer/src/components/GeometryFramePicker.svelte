<script lang="ts">
  import { ChevronsUpDown, Check } from 'lucide-svelte';
  import * as Popover from '$lib/components/ui/popover';
  import { tick } from 'svelte';
  import { FRAME_GROUPS, type geometryFrameOptions } from '../lib/geometry-frames';

  let { value, options, onSelect, open = $bindable(false) }: {
    value: string;
    options: ReturnType<typeof geometryFrameOptions>;
    onSelect: (name: string) => void;
    open?: boolean;
  } = $props();
  const id = $props.id();
  let query = $state('');
  let activeName = $state('');
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  const filtered = $derived(options.filter(option => `${option.name} ${option.label}`.toLowerCase().includes(query.toLowerCase())));
  const selected = $derived(options.find(option => option.name === value));
  const navigable = $derived(FRAME_GROUPS.flatMap(group => filtered.filter(option => option.group === group && option.availability === 'available')));
  const optionId = (name: string) => `${id}-${encodeURIComponent(name)}`;
  function select(name: string) {
    if (options.find(option => option.name === name)?.availability !== 'available') return;
    onSelect(name); open = false;
  }
  async function navigate(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) return;
    if ((event.key === 'Home' || event.key === 'End') && query) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Enter') { select(activeName); return; }
    if (!navigable.length) return;
    const current = navigable.findIndex(option => option.name === activeName);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? navigable.length - 1
      : event.key === 'ArrowDown' ? Math.min(current + 1, navigable.length - 1)
      : current < 0 ? navigable.length - 1 : Math.max(0, current - 1);
    activeName = navigable[index].name;
    await tick();
    const row = document.getElementById(optionId(activeName));
    if (!row || !list) return;
    // Scroll only on keyboard navigation, and only this list (never the page/panel).
    const bounds = row.getBoundingClientRect(), viewport = list.getBoundingClientRect();
    if (bounds.top < viewport.top) list.scrollTop += bounds.top - viewport.top;
    else if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom;
  }
  $effect(() => {
    if (activeName && !navigable.some(option => option.name === activeName)) activeName = '';
  });
</script>

<Popover.Root bind:open onOpenChange={() => { query = ''; activeName = ''; }}>
  <Popover.Trigger class="ui-control mt-1 flex w-full min-w-0 items-center justify-between gap-2 rounded border border-border bg-surface-3 px-2 py-1.5 text-left text-text-primary" aria-label="Axes frame">
    <span class="min-w-0 truncate" title={selected?.label ?? value}>{selected?.label ?? (value || 'Select frame…')}</span>
    <ChevronsUpDown size={13} class="shrink-0 text-text-muted"/>
  </Popover.Trigger>
  <Popover.Content align="start" sideOffset={4} onOpenAutoFocus={event => { event.preventDefault(); input?.focus(); }} class="w-[320px] max-w-[calc(100vw-24px)] rounded border border-border-strong bg-surface-2 p-1">
    <input bind:this={input} bind:value={query} oninput={() => activeName = ''} onkeydown={navigate}
      role="combobox" aria-label="Search frames" aria-autocomplete="list" aria-expanded={open}
      aria-controls={`${id}-list`} aria-activedescendant={activeName ? optionId(activeName) : undefined}
      class="ui-control m-1 rounded border border-border bg-surface-3 px-2 py-1.5 text-text-primary outline-none focus:border-border-strong"
      placeholder="Search frames…" autocomplete="off" spellcheck="false" />
    <div bind:this={list} id={`${id}-list`} role="listbox" aria-label="Reference frames" class="max-h-72 overflow-y-auto overscroll-contain">
      {#if filtered.length === 0}<p class="ui-helper px-2 py-3">No known frames match.</p>{/if}
      {#each FRAME_GROUPS as group}
        {@const choices = filtered.filter(option => option.group === group)}
        {#if choices.length}
          <div role="group" aria-label={group}>
            <div class="ui-label px-2 pt-3 pb-1">{group}</div>
            {#each choices as option (option.name)}
              <button type="button" role="option" id={optionId(option.name)} aria-selected={value === option.name}
                disabled={option.availability !== 'available'} tabindex="-1"
                onpointerenter={() => activeName = option.name} onclick={() => select(option.name)}
                class="frame-option flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left" class:active={activeName === option.name}>
                <div class="min-w-0 flex-1">
                  <div class="ui-body whitespace-normal break-words">{option.label}</div>
                  {#if option.label !== option.name}<div class="ui-helper break-all font-mono">{option.name}</div>{/if}
                  {#if option.availability === 'unavailable'}<div class="ui-helper whitespace-normal">Unavailable at this time</div>{/if}
                </div>
                {#if value === option.name}<Check size={13} class="shrink-0"/>{/if}
              </button>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
  </Popover.Content>
</Popover.Root>


<style>
  .frame-option { color: var(--color-text-primary); }
  .frame-option.active:not(:disabled) { background: var(--color-control-hover); }
  .frame-option:disabled { color: var(--color-text-muted); cursor: not-allowed; }
</style>
