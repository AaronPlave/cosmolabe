import type { GeometryFinderProvider } from './provider.js';
import { EventKindRegistry, requiredRoles, type EventKind, type ResolvedEventQuery } from './registry.js';
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

  async run<P>(query: EventQuery<P>): Promise<EventSearchResult> {
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

    let sequence = 0;
    const ctx = {
      provider: this.provider,
      nextEventId: () => `${query.id}:${sequence++}`,
    };

    let events: GeometryEvent[];
    try {
      events = await (kind as unknown as EventKind<P>).run(resolved as ResolvedEventQuery<P>, ctx);
    } catch (cause) {
      return this.fault(query, {
        code: 'provider-error',
        message: cause instanceof Error ? cause.message : String(cause),
        window: query.window,
        cause,
      });
    }

    return { ok: true, queryId: query.id, events: [...events].sort(compareEvents) };
  }

  private fault(query: EventQuery<never> | EventQuery<any>, fault: EventSearchFault): EventSearchResult {
    return { ok: false, queryId: query.id, fault };
  }
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

  const step = query.step ?? kind.defaultStep;
  if (!Number.isFinite(step) || step <= 0) {
    return { code: 'invalid-step', message: 'Search step must be a positive number of seconds' };
  }
  if (step > end - start) {
    return {
      code: 'invalid-step',
      message: 'Search step is longer than the search window; no event could be detected',
      window: query.window,
    };
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

  return {
    ...query,
    bodies,
    step: query.step ?? kind.defaultStep,
    abcorr: query.abcorr ?? kind.defaultAbcorr ?? 'NONE',
  };
}
