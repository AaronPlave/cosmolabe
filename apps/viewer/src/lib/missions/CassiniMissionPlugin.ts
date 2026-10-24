// Cassini's mission adapter (issue #28, Phase 2) — in the viewer, not in
// `plugins/stock`, because it is one mission's and siting it correctly is the
// point. The observations themselves render without it: they are generic
// `Observations` items drawn by the renderer's ObservationsVisualizer. What
// this adds is mission context on top:
//
//  - a timeline track grouping the scene's Cassini observations by their
//    archive campaign key (OPUS `CASSINIobsname`), one interval per campaign,
//    labels raw. The grouping is `campaignSpans`, which never decodes the key;
//    decoding `ISS_000RI_SOISPTURN183_SP` into its parts would belong here.
//    A campaign's interval is its envelope — first frame to last — not
//    continuous imaging, so the lane says so and a second lane ticks the
//    individual frames inside it.
//  - an info section naming a selected observation's campaign and frames.
//
// Delete this file and its registration, and the footprints still render;
// only the campaign lane and the info rows go.

import {
  campaignSpans,
  catalogTimeParser,
  observationFromCosmographia,
  type Body,
  type Observation,
  type Universe,
} from '@cosmolabe/core';
import type { PluginUISlots, RendererContext, RendererPlugin } from '@cosmolabe/three';

const COLOR = '#4d9bff';

/** The Cassini observations in a universe: `Observations` items whose sensor
 *  rides on the Cassini spacecraft. */
function cassiniObservations(universe: Universe): Observation[] {
  const spice = universe.spiceInstance;
  const parse = catalogTimeParser(spice ? (s) => spice.str2et(s) : undefined);
  const out: Observation[] = [];
  for (const body of universe.getAllBodies()) {
    if (body.geometryType !== 'Observations' || !body.geometryData) continue;
    const sensor = universe.getBody(String(body.geometryData.sensor ?? ''));
    if (sensor?.parentName !== 'Cassini') continue;
    try {
      out.push(observationFromCosmographia(body.name, body.parentName ?? '', body.geometryData, parse));
    } catch {
      // Malformed items are the visualizer's to report; the lane just skips them.
    }
  }
  return out;
}

/** True when a universe has anything for this plugin to show. */
export function hasCassiniObservations(universe: Universe): boolean {
  return cassiniObservations(universe).length > 0;
}

export class CassiniMissionPlugin implements RendererPlugin {
  readonly name = 'cassini-mission';
  private spans: ReturnType<typeof campaignSpans> | null = null;

  private campaigns(universe: Universe) {
    this.spans ??= campaignSpans(cassiniObservations(universe));
    return this.spans;
  }

  readonly ui: PluginUISlots = {
    timelineTracks: [
      {
        id: 'cassini-campaigns',
        label: 'ISS campaigns (span)',
        color: COLOR,
        getIntervals: (startEt: number, endEt: number, ctx: RendererContext) =>
          this.campaigns(ctx.universe)
            .filter((s) => s.endEt >= startEt && s.startEt <= endEt)
            .map((s) => {
              const frames = s.observations.reduce((n, o) => n + o.groups.length, 0);
              return { startEt: s.startEt, endEt: s.endEt, label: `${s.campaign} · ${frames} frame${frames === 1 ? '' : 's'}` };
            }),
      },
      {
        id: 'cassini-frames',
        label: 'ISS frames',
        color: COLOR,
        getIntervals: (startEt: number, endEt: number, ctx: RendererContext) =>
          this.campaigns(ctx.universe).flatMap((s) =>
            s.observations.flatMap((o) =>
              o.groups
                .filter((g) => g.endEt >= startEt && g.startEt <= endEt)
                .map((g) => ({ startEt: g.startEt, endEt: g.endEt, label: s.campaign })),
            ),
          ),
      },
    ],
    infoSections: [
      {
        id: 'cassini-observation',
        label: 'Observation',
        order: 5,
        render: (body: Body, _et: number, ctx: RendererContext) => {
          if (body.geometryType !== 'Observations') return null;
          const span = this.campaigns(ctx.universe).find((s) => s.observations.some((o) => o.name === body.name));
          if (!span) return null;
          const obs = span.observations.find((o) => o.name === body.name)!;
          return {
            rows: [
              { label: 'Campaign', value: span.campaign },
              { label: 'Target', value: obs.target },
              { label: 'Sensor', value: obs.sensor ?? '—' },
              { label: 'Frames', value: String(obs.groups.length) },
            ],
          };
        },
      },
    ],
  };
}
