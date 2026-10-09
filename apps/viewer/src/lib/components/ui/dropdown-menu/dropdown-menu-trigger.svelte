<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  let { ref = $bindable(null), ...rest }: DropdownMenu.TriggerProps = $props();
</script>
<DropdownMenu.Trigger bind:ref {...rest} />
