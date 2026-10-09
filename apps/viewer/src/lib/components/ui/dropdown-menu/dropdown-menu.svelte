<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  let { open = $bindable(false), ...rest }: DropdownMenu.RootProps = $props();
</script>
<DropdownMenu.Root bind:open {...rest} />
