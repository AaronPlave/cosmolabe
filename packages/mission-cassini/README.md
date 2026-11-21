# @cosmolabe/mission-cassini

Cassini's mission plugin (issue #28, Phase 2). It applies to any scene whose
`Observations` items are taken by a sensor riding on the Cassini spacecraft,
and adds:

- an **ISS campaigns (span)** timeline lane: the scene's Cassini observations
  grouped by their archive campaign key (OPUS `CASSINIobsname`), one interval
  per campaign, from first frame to last — an envelope, not continuous imaging;
- an **ISS frames** lane ticking each individual frame;
- an **Observation** info section for a selected observation (campaign,
  target, sensor, frames).

The campaign key is carried opaque and never decoded here. The observation
footprints themselves are drawn by the renderer's generic
`ObservationsVisualizer` and do not depend on this package: remove it and they
still render.

The host installs it through its mission-plugin registry (`registration.ts`);
a catalog never names it.
