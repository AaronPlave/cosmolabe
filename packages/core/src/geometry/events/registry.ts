import type { GeometryFinderProvider } from './provider.js';
import type {
  EtSeconds,
  EventParticipants,
  EventRole,
  EventQuery,
  EventRoleSpec,
  EventSearchFault,
  EventTemporality,
  GeometryEvent,
} from './types.js';

/** What a kind's `run` is handed: the GF boundary plus result-id minting. */
export interface EventKindContext {
  provider: GeometryFinderProvider;
  /**
   * Mints an id unique within this search result. Ids are positional, so the
   * same query run twice mints the same ids — they address an event within one
   * result set, and are not an identity for the event across searches.
   */
  nextEventId(): string;
}

/**
 * One kind of geometry search — "closest approach", "occultation", "in range".
 *
 * A kind owns exactly two things: which roles and parameters it needs, and how
 * to turn those into GF calls and {@link GeometryEvent}s. Everything else —
 * listing, sorting, timeline placement, selection, focusing the 3D view — is
 * handled generically by the shared model, so adding a kind is a bounded
 * change rather than a new subsystem.
 */
export interface EventKind<P = Record<string, unknown>> {
  /** Stable identifier used in `EventQuery.kind`. */
  kind: string;
  /** Human label for pickers and result grouping. */
  label: string;
  /** What this kind yields; `undefined` when it yields both. */
  temporality?: EventTemporality;
  /** Roles this kind consumes, in the order a picker should present them. */
  roles: readonly EventRoleSpec[];
  /**
   * The role whose body selecting one of this kind's events should select.
   * The search service stamps it onto every event the kind returns that does
   * not set its own. Leave unset to accept `focusForEvent`'s fallback.
   */
  primaryRole?: EventRole;
  /**
   * Default GF search step (s), used when the query omits one. Pick it from
   * the shortest event this kind should not miss; see `EventQuery.step`.
   */
  defaultStep: EtSeconds;
  /** Default aberration correction, used when the query omits one. */
  defaultAbcorr?: string;
  /**
   * Kind-specific validation of `query.params`, beyond the shared checks the
   * search service already applies (known kind, required roles, sane window
   * and step). Return a fault to reject the query.
   */
  validate?(query: EventQuery<P>): EventSearchFault | undefined;
  /** Runs the search. Faults are raised by throwing; the service wraps them. */
  run(query: ResolvedEventQuery<P>, ctx: EventKindContext): Promise<GeometryEvent[]>;
}

/**
 * An {@link EventQuery} after the service has applied the kind's defaults, so
 * `run` never has to re-derive them.
 */
export interface ResolvedEventQuery<P = Record<string, unknown>>
  extends Omit<EventQuery<P>, 'step' | 'abcorr' | 'bodies'> {
  bodies: EventParticipants;
  step: EtSeconds;
  abcorr: string;
}

/** Registered event kinds, keyed by `kind`. */
export class EventKindRegistry {
  private readonly kinds = new Map<string, EventKind<never>>();

  /** Registers a kind, replacing any prior registration of the same name. */
  register<P>(kind: EventKind<P>): this {
    this.kinds.set(kind.kind, kind as unknown as EventKind<never>);
    return this;
  }

  get(kind: string): EventKind<never> | undefined {
    return this.kinds.get(kind);
  }

  has(kind: string): boolean {
    return this.kinds.has(kind);
  }

  /** All registered kinds, for building a "what can I search for?" picker. */
  list(): EventKind<never>[] {
    return [...this.kinds.values()];
  }
}

/** Roles a kind requires, i.e. those a caller must fill in. */
export function requiredRoles(kind: EventKind<never>): EventRoleSpec[] {
  return kind.roles.filter((r) => r.required !== false);
}
