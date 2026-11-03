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
    expect(actionStatus({ status: 'done', steps: [...steps, { id: 'a', name: 'invokeCapability', input: { id: 'events.presentEventResult' }, result: { ok: true, summary: '' } }] })).toContain('1 viewer change completed');
  });
  it('has one meaningful status across research, execution, approval and terminal states', () => {
    const step = (name: string, result: null | { ok: true; summary: string } = null) => ({ id: name, name, input: {}, result });
    expect(actionStatus({ status: 'running', steps: [] })).toBe('Researching…');
    expect(actionStatus({ status: 'running', steps: [step('runEventQuery')] })).toBe('Running Event Finder…');
    expect(actionStatus({ status: 'running', steps: [step('removeBookmark')] }, true)).toBe('Approval needed');
    expect(actionStatus({ status: 'done', steps: [step('getSpatialContext', { ok: true, summary: '' })] })).toBe('Request completed');
    expect(actionStatus({ status: 'refusal', steps: [] })).toBe('No viewer changes confirmed');
    expect(actionStatus({ status: 'cancelled', steps: [] })).toBe('Request stopped');
    expect(actionStatus({ status: 'done', steps: [step('waitUntilReady', { ok: true, summary: '' }), step('screenshot', { ok: true, summary: '' })] })).toBe('Request completed');
  });

  it('never counts read-only success or declined edits as changes', () => {
    const steps = [
      { id: 'read', name: 'describeScene', input: {}, result: { ok: true as const, summary: '' } },
      { id: 'declined', name: 'invokeCapability', input: { id: 'bookmarks.removeBookmark' }, result: { ok: false as const, code: 'refused' as const, error: 'Declined' } },
    ];
    expect(actionStatus({ status: 'done', steps })).toBe('No viewer changes confirmed');
  });

});
