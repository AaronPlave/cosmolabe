<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import { cn } from '$lib/utils';
  let { class: className, ...rest }: DropdownMenu.ItemProps = $props();
</script>
<DropdownMenu.Item class={cn('ui-control cursor-pointer rounded px-2 py-1.5 outline-none data-highlighted:bg-control-hover data-disabled:opacity-50', className)} {...rest} />
