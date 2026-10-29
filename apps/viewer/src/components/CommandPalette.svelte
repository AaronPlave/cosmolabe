<script lang="ts">
  import * as Command from '$lib/components/ui/command';
  import { getCommands, getBodyCommands } from '../lib/commands';
  import { selectAndFlyTo, getRenderer, vs } from '../lib/viewer-state.svelte';
  import { selectPlace, searchPlaces, isPlaceAvailable } from '../lib/places';
  import { Orbit, Eye, Camera, Timer, MapPin } from 'lucide-svelte';

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open = $bindable(), onClose }: Props = $props();
  let searchValue = $state('');
  let placeBody = $state('');
  let placeKind = $state('');
  const placeBodies = $derived([...new Set(vs.places?.places.filter(isPlaceAvailable).map(p => p.layer.body) ?? [])]);
  const placeKinds = $derived([...new Set(vs.places?.places.filter(p => isPlaceAvailable(p) && (!placeBody || p.layer.body === placeBody)).map(p => p.kind) ?? [])].sort());
  const filteredPlaces = $derived(searchPlaces(searchValue, { body: placeBody, kind: placeKind, activeBody: vs.trackedBodyName ?? undefined }));

  $effect(() => { if (placeBody && !placeBodies.includes(placeBody)) placeBody = ''; });
  $effect(() => { if (placeKind && !placeKinds.includes(placeKind)) placeKind = ''; });

  // Our own substring filtering — shadcn command uses bits-ui which wraps cmdk
  let filteredBodies = $derived.by(() => {
    const all = getBodyCommands();
    if (!searchValue.trim()) return all;
    const q = searchValue.toLowerCase().trim();
    return all.filter(b => b.name.toLowerCase().includes(q));
  });

  let filteredCommands = $derived.by(() => {
    const all = getCommands();
    if (!searchValue.trim()) return all;
    const q = searchValue.toLowerCase().trim();
    return all.filter(c => c.label.toLowerCase().includes(q));
  });

  let filteredCategories = $derived(
    [...new Set(filteredCommands.map(c => c.category))]
  );

  let hasResults = $derived(filteredPlaces.length > 0 || filteredBodies.length > 0 || filteredCommands.length > 0);

  function handleSelect(id: string) {
    const renderer = getRenderer();
    if (!renderer) return;

    const bodyCmd = getBodyCommands().find(b => `body:${b.name}` === id);
    if (bodyCmd) { selectAndFlyTo(bodyCmd.name); onClose(); return; }

    const cmd = getCommands().find(c => c.id === id);
    if (cmd) { cmd.execute(renderer); onClose(); }
  }

  function categoryIcon(cat: string) {
    switch (cat) {
      case 'Time': return Timer;
      case 'Camera': return Camera;
      default: return Eye;
    }
  }

  function onOpenChange(isOpen: boolean) {
    if (!isOpen) onClose();
    if (isOpen) searchValue = '';
  }
</script>

<Command.Dialog bind:open {onOpenChange} shouldFilter={false}>
  <Command.Input bind:value={searchValue} placeholder="Search places, bodies, commands..." />
  <div class="flex flex-wrap gap-2 px-3 py-2 text-xs">
    <select aria-label="Place body" bind:value={placeBody} onchange={() => placeKind = ''} class="max-w-full bg-surface-3 rounded p-1">
      <option value="">All place bodies</option>
      {#each placeBodies as body}<option value={body}>{body}</option>{/each}
    </select>
    <select aria-label="Place type" bind:value={placeKind} class="max-w-full bg-surface-3 rounded p-1">
      <option value="">All place types</option>
      {#each placeKinds as kind}<option value={kind}>{kind}</option>{/each}
    </select>
  </div>
  <Command.List>
    {#if !hasResults}
      <Command.Empty>No results found</Command.Empty>
    {/if}
    {#if filteredPlaces.length}
      <Command.Group heading="Places · select for details and Fly / Jump">
        {#each filteredPlaces as place (place.ref)}
          <Command.Item value={`place:${place.ref}`} onSelect={() => { selectPlace(place); onClose(); }}>
            <MapPin class="text-muted-foreground shrink-0" />
            <div class="min-w-0"><div class="truncate">{place.name}</div><div class="text-[11px] text-muted-foreground truncate">{place.layer.body} · {place.kind} · {place.origin}</div></div>
          </Command.Item>
        {/each}
      </Command.Group>
    {:else}
      <p class="px-4 py-2 text-xs text-muted-foreground">{vs.places?.places.length ? 'No places match these names or filters.' : 'No place data loaded. Open a catalog with named geographic points.'}</p>
    {/if}

    {#if filteredBodies.length > 0}
      <Command.Group heading="Bodies">
        {#each filteredBodies as body}
          <Command.Item
            value={body.name}
            onSelect={() => handleSelect(`body:${body.name}`)}
          >
            <Orbit class="text-muted-foreground" />
            <span>{body.name}</span>
            {#if body.category}
              <span class="ml-auto text-[11px] text-muted-foreground">{body.category}</span>
            {/if}
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}

    {#each filteredCategories as category}
      {@const cmds = filteredCommands.filter(c => c.category === category)}
      {#if cmds.length > 0}
        <Command.Group heading={category}>
          {#each cmds as cmd}
            {@const Icon = categoryIcon(category)}
            <Command.Item
              value={cmd.label}
              onSelect={() => handleSelect(cmd.id)}
            >
              <Icon class="text-muted-foreground" />
              <span>{cmd.label}</span>
              {#if cmd.shortcut}
                <Command.Shortcut>{cmd.shortcut}</Command.Shortcut>
              {/if}
            </Command.Item>
          {/each}
        </Command.Group>
      {/if}
    {/each}
  </Command.List>
</Command.Dialog>
