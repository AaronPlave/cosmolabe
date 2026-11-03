import { describe, expect, it } from 'vitest';
import { actionMetadata, actionStatus, approvalPresentation } from '../ask/presentation';

describe('Ask presentation of the shared action contract', () => {
  it('decodes Event Finder configuration for people without changing exact approval input', () => {
    const definition = { id: 'q', query: { kind: 'closest-approach', bodies: { observer: 'Voyager 1', target: 'Jupiter' }, window: { start: 0, end: 10 } } };
    const pending = { kind: 'authoring', operation: 'events.upsertEventQuery', input: JSON.stringify({ definition: JSON.stringify(definition) }) };
    const original = pending.input;
    const display = approvalPresentation(pending, et => `UTC ${et}`);
    expect(display.title).toBe('Set up closest approach search');
    expect(display.description).toContain('Voyager 1 → Jupiter · UTC 0 → UTC 10');
    expect(display.description).toContain('adds or updates');
    expect(JSON.parse(display.exact).definition).toEqual(definition);
    expect(pending.input).toBe(original);
  });
  it('uses registry metadata for new actions and keeps lookups out of normal status', () => {
    expect(actionMetadata({ name: 'invokeCapability', input: { id: 'events.presentEventResult' } }).label).toBe('Show a computed encounter');
    const steps = [{ id: 'schema', name: 'describeCapabilities', input: {}, result: { ok: true as const, summary: '' } }];
    expect(actionStatus({ status: 'done', steps })).not.toMatch(/lookup|unverified/);
    expect(actionStatus({ status: 'done', steps: [...steps, { id: 'a', name: 'invokeCapability', input: { id: 'events.presentEventResult' }, result: { ok: true, summary: '' } }] })).toContain('1 viewer step completed');
  });
});
