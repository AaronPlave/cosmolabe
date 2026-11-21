// Plugin timeline tracks (`ui.timelineTracks`, plugins/PluginUI.ts): the slot
// a renderer plugin fills to put interval bars on the timeline. Declared from
// the start and consumed by nothing until the observation work (#28 Phase 2)
// gave it a first contributor; read here so the dock stays a consumer of the
// plugin API rather than of any one plugin.

import type { PluginTimelineTrack, RendererContext, TimeInterval } from '@cosmolabe/three';

export interface ResolvedTrack {
  track: PluginTimelineTrack;
  intervals: TimeInterval[];
}

interface TrackSource {
  getPlugins(): readonly { ui?: { timelineTracks?: PluginTimelineTrack[] } }[];
  getContext(): RendererContext;
}

/** Every contributed track, with its intervals for `[startEt, endEt]`. A
 *  track that throws is dropped with a warning rather than taking the
 *  timeline down with it. */
export function resolvePluginTracks(source: TrackSource | null, startEt: number, endEt: number): ResolvedTrack[] {
  if (!source) return [];
  const ctx = source.getContext();
  const out: ResolvedTrack[] = [];
  for (const plugin of source.getPlugins()) {
    for (const track of plugin.ui?.timelineTracks ?? []) {
      try {
        out.push({ track, intervals: track.getIntervals(startEt, endEt, ctx) });
      } catch (err) {
        console.warn(`[Cosmolabe] timeline track "${track.id}" failed:`, err);
      }
    }
  }
  return out;
}

/** The intervals containing `et`. */
export function intervalsAt(intervals: readonly TimeInterval[], et: number): TimeInterval[] {
  return intervals.filter((i) => et >= i.startEt && et <= i.endEt);
}
