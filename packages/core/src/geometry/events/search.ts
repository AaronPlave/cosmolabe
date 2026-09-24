import type { EventSearchProgress } from './progress.js';
import type { GeometryFinderProvider } from './provider.js';
import {
  EventKindRegistry,
  defaultParams,
  requiredRoles,
  type EventKind,
  type ResolvedEventQuery,
} from './registry.js';
import {
  compareEvents,
  type EventParticipants,
  type EventQuery,
  type EventSearchFault,
  type EventSearchResult,
  type GeometryEvent,
} from './types.js';

export interface EventSearchOptions {
  registry: EventKindRegistry;
  provider: GeometryFinderProvider;
}

/** Per-search options for {@link EventSearch.run}. */
export interface EventSearchRunOptions {
  /**
   * Where this search's whole-search progress goes. The search tells it how
   * many geometry calls to expect and when each begins; the caller, which is
   * what hears the provider's per-call progress, feeds that in. Omit it and the
   * search runs exactly as it would without.
   */
  progress?: EventSearchProgress;
}

/**
 * Runs {@link EventQuery}s against registered {@link EventKind}s.
 *
 * The service owns everything that is the same for every kind: validating the
 * shared fields, filling in the kind's defaults, minting event ids, sorting
 * results chronologically, and turning a thrown provider error into a
 * structured fault. Kinds are left with the geometry.
 *
 * Faults are returned, not thrown: "we could not look" (`ok: false`) and "we
 * looked and found nothing" (`ok: true` with no events) are different answers
 * and callers should be able to show them differently.
 */
export class EventSearch {
  private readonly registry: EventKindRegistry;
  private readonly provider: GeometryFinderProvider;

  constructor(options: EventSearchOptions) {
    this.registry = options.registry;
    this.provider = options.provider;
  }

  /** Kinds available to search, for building a query-configuration UI. */
  kinds(): EventKind<never>[] {
    return this.registry.list();
  }

  async run<P>(query: EventQuery<P>, options?: EventSearchRunOptions): Promise<EventSearchResult> {
    const kind = this.registry.get(query.kind);
    if (!kind) {
      return this.fault(query, {
        code: 'unknown-kind',
        message: `No event kind registered as "${query.kind}"`,
      });
    }

    const shared = validateShared(query, kind);
    if (shared) return this.fault(query, shared);

    const resolved = resolveQuery(query, kind);

    const specific = (kind as unknown as EventKind<P>).validate?.(resolved as EventQuery<P>);
    if (specific) return this.fault(query, specific);

    const progress = options?.progress;
    progress?.plan(
      (kind as unknown as EventKind<P>).plannedCalls?.(resolved as ResolvedEventQuery<P>) ?? 1,
    );

    let sequence = 0;
    const ctx = {
      provider: progress ? countingCalls(this.provider, progress) : this.provider,
      nextEventId: () => `${query.id}:${sequence++}`,
    };

    let events: GeometryEvent[];
    try {
      events = await (kind as unknown as EventKind<P>).run(resolved as ResolvedEventQuery<P>, ctx);
    } catch (cause) {
      progress?.seal();
      return this.fault(query, {
        code: 'provider-error',
        message: cause instanceof Error ? cause.message : String(cause),
        window: query.window,
        cause,
      });
    }

    // The kind's declared primary role applies to every event it returns that
    // did not name its own, so `focusForEvent` never has to guess for a kind
    // that has already answered the question.
    // The search is answered. Whatever follows — an explanation for an empty
    // result — is not part of what the bar describes, and reports nothing.
    progress?.complete();

    const stamped = kind.primaryRole
      ? events.map((event) => (event.primaryRole ? event : { ...event, primaryRole: kind.primaryRole }))
      : events;

    if (stamped.length > 0) {
      return { ok: true, queryId: query.id, events: stamped.sort(compareEvents) };
    }

    // "Nothing matched" is an answer, and some kinds can say why. The
    // explanation is strictly a bonus: one that throws leaves the empty result
    // exactly as it was, since failing to explain an answer is not failing to
    // produce it.
    let hint: string | undefined;
    try {
      hint = await (kind as unknown as EventKind<P>).explainEmpty?.(
        resolved as ResolvedEventQuery<P>,
        ctx,
      );
    } catch {
      hint = undefined;
    }

    return { ok: true, queryId: query.id, events: [], ...(hint ? { hint } : {}) };
  }

  private fault(query: EventQuery<never> | EventQuery<any>, fault: EventSearchFault): EventSearchResult {
    return { ok: false, queryId: query.id, fault };
  }
}

/**
 * The provider, with each GF call marking the start of a new slice of
 * `progress`. `range` is a position lookup, not a geometry search: it reports
 * nothing and passes straight through.
 */
function countingCalls(
  provider: GeometryFinderProvider,
  progress: EventSearchProgress,
): GeometryFinderProvider {
  const counted = <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      progress.beginCall();
      return fn.apply(provider, args);
    };
  return {
    ...(provider.range ? { range: provider.range.bind(provider) } : {}),
    gfdist: counted(provider.gfdist),
    gfsep: counted(provider.gfsep),
    gfoclt: counted(provider.gfoclt),
    gfposc: counted(provider.gfposc),
  };
}

/** Shared checks every kind gets for free. */
function validateShared(query: EventQuery<any>, kind: EventKind<never>): EventSearchFault | undefined {
  const { start, end } = query.window;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return {
      code: 'invalid-window',
      message: 'Search window must be a finite interval with end after start',
      window: query.window,
    };
  }

  // Only finiteness and sign are checked. A GF step is a sampling step, not a
  // span the confinement window has to contain: GF samples the window's
  // endpoints too, so a step longer than the window still resolves a condition
  // that changes across it — coarsely, but not not-at-all. Rejecting those
  // would block legitimate searches over short analysis windows. A kind whose
  // geometry needs a tighter step says so in its own `validate`.
  const step = query.step ?? kind.defaultStep;
  if (!Number.isFinite(step) || step <= 0) {
    return { code: 'invalid-step', message: 'Search step must be a positive number of seconds' };
  }

  for (const spec of requiredRoles(kind)) {
    const body = query.bodies[spec.role] ?? spec.default;
    if (!body) {
      return {
        code: 'missing-body',
        message: `${kind.label} requires a body for "${spec.label}"`,
        role: spec.role,
      };
    }
  }

  return undefined;
}

function resolveQuery<P>(query: EventQuery<P>, kind: EventKind<never>): ResolvedEventQuery<P> {
  const bodies: EventParticipants = { ...query.bodies };
  for (const spec of kind.roles) {
    if (!bodies[spec.role] && spec.default) bodies[spec.role] = spec.default;
  }

  // Declared param defaults fill only the keys the caller left out, so a kind
  // can add a parameter without invalidating queries written before it existed.
  const defaults = defaultParams(kind);
  const params = (
    Object.keys(defaults).length ? { ...defaults, ...(query.params ?? {}) } : query.params
  ) as P | undefined;

  return {
    ...query,
    bodies,
    params,
    step: query.step ?? kind.defaultStep,
    abcorr: query.abcorr ?? kind.defaultAbcorr ?? 'NONE',
  };
}
