import { describe, expect, it } from 'vitest';
import type { InstantEvent, IntervalEvent } from '@cosmolabe/core';
import type { LeadRequest } from '@cosmolabe/three';
import {
  EVENT_PREVIEW_LEAD,
  EVENT_SELECTION_LEAD,
  eventLeadBody,
  eventLeadRequest,
  previewEventLead,
  selectEventLead,
  type EventLeadHost,
} from '../event-lead';

const approach: InstantEvent = {
  id: 'r1',
  queryId: 'q1',
  kind: 'closest-approach',
  temporality: 'instant',
  bodies: { observer: 'Europa Clipper', target: 'Europa' },
  label: 'Europa closest approach',
  et: 5000,
};

const eclipse: IntervalEvent = {
  id: 'r2',
  queryId: 'q2',
  kind: 'occultation',
  temporality: 'interval',
  bodies: { observer: 'Europa Clipper', front: 'Europa', back: 'SUN' },
  label: 'Eclipse',
  start: 100,
  end: 400,
};

/** A host that records the lead requests currently in force. */
function host() {
  const requests = new Map<string, Map<string, LeadRequest>>();
  const h: EventLeadHost & { requests: typeof requests } = {
    requests,
    setTrajectoryLead(name, key, request) {
      const byKey = requests.get(key) ?? new Map<string, LeadRequest>();
      if (request) byKey.set(name, request);
      else byKey.delete(name);
      requests.set(key, byKey);
    },
    clearTrajectoryLead(key) {
      requests.delete(key);
    },
  };
  return h;
}

describe('event leads', () => {
  it('puts the lead on the observer\'s trajectory', () => {
    expect(eventLeadBody(approach)).toBe('Europa Clipper');
    expect(eventLeadBody({ ...approach, bodies: { target: 'Europa' } })).toBe('Europa');
  });

  it('targets the event span: an instant is a zero-width span', () => {
    expect(eventLeadRequest(approach)).toEqual({ target: { start: 5000, end: 5000 } });
    expect(eventLeadRequest(eclipse)).toEqual({ target: { start: 100, end: 400 } });
  });

  it('keeps hover preview and selection independent', () => {
    const h = host();
    selectEventLead(h, eclipse);
    previewEventLead(h, approach);
    expect(h.requests.get(EVENT_SELECTION_LEAD)?.get('Europa Clipper')?.target).toEqual({ start: 100, end: 400 });
    expect(h.requests.get(EVENT_PREVIEW_LEAD)?.get('Europa Clipper')?.target).toEqual({ start: 5000, end: 5000 });
    // Leaving the hovered row ends only the preview.
    previewEventLead(h, null);
    expect(h.requests.has(EVENT_PREVIEW_LEAD)).toBe(false);
    expect(h.requests.get(EVENT_SELECTION_LEAD)?.size).toBe(1);
    selectEventLead(h, null);
    expect(h.requests.has(EVENT_SELECTION_LEAD)).toBe(false);
  });

  it('replaces rather than accumulates: a new selection withdraws the old one', () => {
    const h = host();
    selectEventLead(h, eclipse);
    selectEventLead(h, { ...approach, bodies: { observer: 'Juno' } });
    expect([...h.requests.get(EVENT_SELECTION_LEAD)!.keys()]).toEqual(['Juno']);
  });

  it('is a no-op without a renderer', () => {
    expect(() => previewEventLead(null, approach)).not.toThrow();
  });
});
