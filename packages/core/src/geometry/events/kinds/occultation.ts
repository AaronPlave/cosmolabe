import type { EventKind } from '../registry.js';
import type { IntervalEvent } from '../types.js';

/** The mutually exclusive occultation states exposed by CSPICE GFOCLT. */
export type OccultationState = 'partial' | 'full' | 'annular';

export interface OccultationParams {
  /** Search every classified state, or only one GFOCLT occultation type. */
  state?: 'all' | OccultationState;
}

const STATE_LABEL: Record<OccultationState, string> = {
  partial: 'Partial',
  full: 'Full',
  annular: 'Annular',
};

const GFOCLT_TYPE: Record<OccultationState, string> = {
  partial: 'PARTIAL',
  full: 'FULL',
  annular: 'ANNULAR',
};

/** The states one search asks GFOCLT for, in the order it asks. */
function requestedStates(params: OccultationParams | undefined): OccultationState[] {
  const requested = params?.state ?? 'all';
  return requested === 'all' ? ['partial', 'full', 'annular'] : [requested];
}

/**
 * Eclipse and body/body occultation windows, computed by SPICE GFOCLT.
 *
 * The same geometry covers a spacecraft entering a planet's shadow (observer
 * spacecraft, back Sun), a solar/lunar eclipse, and a general body occulting
 * another body. Running the three disjoint classified GFOCLT searches instead
 * of one `ANY` search preserves the physical state on every returned interval.
 */
export const occultationKind: EventKind<OccultationParams> = {
  kind: 'occultation',
  label: 'Eclipse / occultation',
  description:
    'Intervals when a foreground body blocks all or part of a background body as seen by the observer. Use the Sun as the background body to find eclipse and shadow-entry windows.',
  temporality: 'interval',
  roles: [
    { role: 'observer', label: 'Observer' },
    { role: 'back', label: 'Background' },
    { role: 'front', label: 'Foreground' },
  ],
  params: [
    {
      kind: 'choice',
      key: 'state',
      label: 'State',
      default: 'all',
      options: [
        { value: 'all', label: 'All (classified)' },
        { value: 'partial', label: 'Partial only' },
        { value: 'full', label: 'Full only' },
        { value: 'annular', label: 'Annular only' },
      ],
      help: 'SPICE classifies partial, full, and annular occultations from apparent body disks.',
    },
  ],
  primaryRole: 'back',
  // Partial ingress/egress can last only a few tens of seconds for a nearby
  // spacecraft; a minute missed the deterministic Cassini/Saturn fixture.
  defaultStep: 10,
  defaultAbcorr: 'LT',

  validate: (query) => {
    const state = query.params?.state;
    if (state !== 'all' && state !== 'partial' && state !== 'full' && state !== 'annular') {
      return {
        code: 'invalid-params',
        message: 'State must be all, partial, full, or annular',
      };
    }
    const { observer, front, back } = query.bodies;
    if (observer === front || observer === back || front === back) {
      return {
        code: 'invalid-params',
        message: 'Observer, foreground, and background must be different bodies',
      };
    }
    return undefined;
  },

  // One GFOCLT per requested state, over the same window: clean slices.
  plannedCalls: (query) => requestedStates(query.params).length,

  run: async (query, ctx) => {
    const observer = query.bodies.observer!;
    const front = query.bodies.front!;
    const back = query.bodies.back!;
    const states = requestedStates(query.params);
    const events: IntervalEvent[] = [];

    for (const state of states) {
      const found = await ctx.provider.gfoclt(
        GFOCLT_TYPE[state],
        front,
        'ELLIPSOID',
        `IAU_${front}`,
        back,
        'ELLIPSOID',
        `IAU_${back}`,
        query.abcorr,
        observer,
        query.step,
        [query.window],
      );

      for (const window of found) {
        const stateLabel = STATE_LABEL[state];
        const phenomenon = back.toUpperCase() === 'SUN' ? 'eclipse' : 'occultation';
        events.push({
          id: ctx.nextEventId(),
          queryId: query.id,
          kind: query.kind,
          temporality: 'interval',
          start: window.start,
          end: window.end,
          bodies: { observer, back, front },
          state,
          label: query.label ?? `${stateLabel} ${phenomenon}: ${front} in front of ${back}`,
          metrics: [
            {
              key: 'duration',
              label: 'Duration',
              value: window.end - window.start,
              unit: 's',
              precision: 0,
            },
          ],
        });
      }
    }

    return events;
  },
};
