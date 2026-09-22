import { describe, expect, it } from 'vitest';
import { parse } from '@cosmolabe/control';
import { SCRIPT_DEMOS, queueScriptDemo, takePendingScript } from '../script-demo.svelte';
import { shell } from '../shell.svelte';

describe('scripted demos', () => {
  it.each(SCRIPT_DEMOS.map((d) => [d.id, d] as const))('%s parses against the verb table', (_id, demo) => {
    expect(() => parse(demo.source)).not.toThrow();
  });

  it('has unique ids', () => {
    expect(new Set(SCRIPT_DEMOS.map((d) => d.id)).size).toBe(SCRIPT_DEMOS.length);
  });

  it('queues a script for the console once, and opens the console', () => {
    queueScriptDemo(SCRIPT_DEMOS[0]);
    expect(shell.openTools).toContain('script');
    expect(takePendingScript()).toEqual({ source: SCRIPT_DEMOS[0].source, autorun: true });
    expect(takePendingScript()).toBeNull();
  });
});
