<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import { cn } from '$lib/utils';
  let { class: className, sideOffset = 4, align = 'end', ...rest }: DropdownMenu.ContentProps = $props();
</script>
<DropdownMenu.Portal>
  <DropdownMenu.Content {sideOffset} {align} class={cn('z-[200] min-w-32 rounded border border-border bg-panel p-1 text-text-primary shadow-lg outline-none', className)} {...rest} />
</DropdownMenu.Portal>
