<script lang="ts">
  /**
   * Making a layer by hand (#200), from the Layers view's "…" menu: a new
   * empty layer, or plain GeoJSON that does not say which body or convention
   * it was written in. Drawing never needs this form; it uses the body's
   * annotations layer. A new layer takes the convention of the body's
   * existing layers, behind *Coordinate convention*; an import must state it,
   * because plain GeoJSON would otherwise mean Earth WGS84.
   */
  import { ChevronLeft } from 'lucide-svelte';
  import { describeGeographicCoordinates, type GeographicCoordinates } from '@cosmolabe/core';
  import { Button } from '$lib/components/ui/button';
  import SegmentedControl from '$lib/components/ui/segmented-control.svelte';
  import * as Select from '$lib/components/ui/select';
  import { vs, getRenderer } from '../lib/viewer-state.svelte';
  import { openLayer } from '../lib/geographic-layers.svelte';
  import { edits, createLayer, importLayerText, bodyReferenceShape, inferredCoordinates, drawBody } from '../lib/geographic-editing.svelte';

  let form = $derived(edits.form!);
  let importing = $derived(form.mode === 'import');
  let drawable = $derived(vs.bodies.map((b) => b.name).filter((name) =>
    getRenderer()?.getBodyMesh(name)?.body.geometryType === 'Globe' && bodyReferenceShape(name)));

  let body = $state(drawBody() ?? '');
  let name = $state('');
  let latitude = $state<GeographicCoordinates['latitude']>('planetocentric');
  let direction = $state<GeographicCoordinates['longitudeDirection']>('east');
  let domain = $state<GeographicCoordinates['longitudeDomain']>('-180..180');
  // svelte-ignore state_referenced_locally
  let conventionOpen = $state(importing);
  let shape = $derived(body ? bodyReferenceShape(body) : null);

  // The body's existing convention is the default.
  $effect(() => {
    const c = body ? inferredCoordinates(body) : null;
    if (!c) return;
    latitude = c.latitude; direction = c.longitudeDirection; domain = c.longitudeDomain;
  });

  const fileStem = (n: string) => n.replace(/\.(geo)?json$/i, '');

  function submit() {
    if (!shape) return;
    const coordinates: GeographicCoordinates = { latitude, longitudeDirection: direction, longitudeDomain: domain, referenceShape: shape };
    const id = form.mode === 'import'
      ? importLayerText(form.text, { body, name: name.trim() || fileStem(form.fileName), coordinates })
      : createLayer({ body, name: name.trim() || `${body} notes`, coordinates });
    if (!id) return;
    edits.form = null;
    openLayer(id);
  }
</script>

<section class="layer-form" aria-label={importing ? 'Import GeoJSON' : 'New layer'}>
  <nav><button class="surface-crumb-back" onclick={() => (edits.form = null)}><ChevronLeft size={13} /> Layers</button></nav>
  <h3 class="title">{importing ? 'Import GeoJSON' : 'New layer'}</h3>
  {#if form.mode === 'import'}
    <p class="ui-helper">{form.fileName} does not say which body or coordinate convention it uses (plain GeoJSON means Earth WGS84). Choose what it was written in; coordinates are read in that convention and kept as written.</p>
  {/if}
  <label class="field"><span class="ui-label">Name</span>
    <input class="text" bind:value={name} placeholder={form.mode === 'import' ? fileStem(form.fileName) : `${body} notes`} aria-label="Name" /></label>
  <span class="ui-label">Body</span>
  <Select.Root type="single" value={body} onValueChange={(v) => (body = v)}>
    <Select.Trigger size="sm" class="ui-control h-7 w-full rounded border-border bg-surface-3 px-2 text-text-primary" aria-label="Body">
      <Select.Value>{body || 'Body…'}</Select.Value>
    </Select.Trigger>
    <Select.Content align="start" class="max-h-64 rounded border border-border-strong bg-surface-2 p-1">
      {#each drawable as b (b)}<Select.Item value={b} label={b} />{/each}
    </Select.Content>
  </Select.Root>
  <details class="disclosure" bind:open={conventionOpen}>
    <summary>Coordinate convention</summary>
    <div class="convention">
      <SegmentedControl value={latitude} options={['planetocentric', 'planetographic']} label="Latitude convention" onValueChange={(v) => (latitude = v as typeof latitude)} />
      <div class="row">
        <SegmentedControl value={direction} options={['east', 'west']} label="Positive longitude direction" onValueChange={(v) => (direction = v as typeof direction)} />
        <SegmentedControl value={domain} options={['-180..180', '0..360']} label="Longitude range" onValueChange={(v) => (domain = v as typeof domain)} />
      </div>
    </div>
  </details>
  {#if shape}
    <p class="ui-helper muted">{describeGeographicCoordinates({ latitude, longitudeDirection: direction, longitudeDomain: domain, referenceShape: shape })}.</p>
  {/if}
  <div class="row">
    <Button size="sm" class="ui-control flex-1" onclick={submit} disabled={!shape}>{importing ? 'Import' : 'Create'}</Button>
    <Button variant="secondary" size="sm" class="ui-control flex-1" onclick={() => (edits.form = null)}>Cancel</Button>
  </div>
  {#if edits.message}<p class="ui-helper warn" role="status">{edits.message}</p>{/if}
</section>

<style>
  .layer-form { display: flex; flex-direction: column; gap: 6px; }
  .title { margin: 0; color: var(--color-text-primary); font-size: var(--text-body, 13px); font-weight: 600; }
  .field { display: flex; flex-direction: column; gap: 2px; }
  .text {
    height: 26px;
    padding: 0 6px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }
  .convention { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .muted { color: var(--color-text-muted); }
  .warn { color: var(--color-warning); }
</style>
