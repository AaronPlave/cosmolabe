<script lang="ts">
  import * as Command from '$lib/components/ui/command';
  import * as Dialog from '$lib/components/ui/dialog';
  import { getCommands, getBodyCommands, getCommandCategories } from '../lib/commands';
  import { trackBody, getRenderer } from '../lib/viewer-state.svelte';
  import { Orbit, Eye, Camera, Timer } from 'lucide-svelte';

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open = $bindable(), onClose }: Props = $props();
  let searchValue = $state('');

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

  let hasResults = $derived(filteredBodies.length > 0 || filteredCommands.length > 0);

  function handleSelect(id: string) {
    const renderer = getRenderer();
    if (!renderer) return;

    const bodyCmd = getBodyCommands().find(b => `body:${b.name}` === id);
    if (bodyCmd) { trackBody(bodyCmd.name); onClose(); return; }

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
  <Command.Input bind:value={searchValue} placeholder="Search bodies, commands..." />
  <Command.List>
    {#if !hasResults}
      <Command.Empty>No results found</Command.Empty>
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
