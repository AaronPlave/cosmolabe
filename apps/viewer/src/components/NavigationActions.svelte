<script lang="ts">
  import { Navigation } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  let { disabled = false, onJump }: { disabled?: boolean; onJump: () => void } = $props();
</script>
<div class="flex gap-2 justify-end">
  <Button type="button" variant="secondary" size="sm" {disabled} onclick={onJump} title="Cut straight to the view">Jump to</Button>
  <Button type="submit" size="sm" {disabled} title="Fly there (Enter)"><Navigation size={13} /> Fly to</Button>
</div>
