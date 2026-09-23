/**
 * Future trajectory as spatial context for events (#105).
 *
 * An event ahead of the playhead sits somewhere on a path the scene is not
 * otherwise drawing: the trail only shows where a body has been. So the event
 * surfaces ask the renderer for a *lead* — the loaded trajectory after the
 * current simulation time — on the trajectory the event is about, following
 * the shared interaction model: hover previews, selection commits.
 *
 * This module decides only *what* to ask for. How much path that becomes, how
 * it is windowed when the event is far away, and where the data ends are the
 * trajectory renderer's, so there is exactly one owner of trajectory geometry.
 */
import { eventEnd, eventStart, focusForEvent, type GeometryEvent } from '@cosmolabe/core';
import type { LeadRequest } from '@cosmolabe/three';

/** Request keys: one per consumer, so a preview never undoes a selection. */
export const EVENT_PREVIEW_LEAD = 'event-preview';
export const EVENT_SELECTION_LEAD = 'event-selection';

/** The renderer surface this needs. */
export interface EventLeadHost {
  setTrajectoryLead(name: string, key: string, request: LeadRequest | null): void;
  clearTrajectoryLead(key: string): void;
}

/**
 * Whose trajectory an event's lead belongs on.
 *
 * The observer when there is one — the spacecraft whose closest approach,
 * range window or eclipse it is, and the trajectory the event's marker sits
 * on — otherwise the body the event focuses.
 */
export function eventLeadBody(event: GeometryEvent): string | undefined {
  return event.bodies.observer ?? focusForEvent(event).primary;
}

/** The lead an event asks for: reach its span, or show context around it. */
export function eventLeadRequest(event: GeometryEvent): LeadRequest {
  return { target: { start: eventStart(event), end: eventEnd(event) } };
}

function apply(host: EventLeadHost | null, key: string, event: GeometryEvent | null): void {
  if (!host) return;
  host.clearTrajectoryLead(key);
  if (!event) return;
  const body = eventLeadBody(event);
  if (body) host.setTrajectoryLead(body, key, eventLeadRequest(event));
}

/** Hover: temporarily reveal enough future path to place the event. */
export function previewEventLead(host: EventLeadHost | null, event: GeometryEvent | null): void {
  apply(host, EVENT_PREVIEW_LEAD, event);
}

/** Selection: keep the event's future path visible until it is cleared. */
export function selectEventLead(host: EventLeadHost | null, event: GeometryEvent | null): void {
  apply(host, EVENT_SELECTION_LEAD, event);
}
