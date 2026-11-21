// The embeddable workspace's two pieces of plumbing that can be checked
// without a browser: the stylesheet split for the shadow root, and restoring
// every module store when a host disposes the workspace.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { splitShadowCss } from '../embed-css';
import { resetStores } from '../session.svelte';
import { shell, openTool } from '../shell.svelte';
import { vs } from '../viewer-state.svelte';
import { ef, setSelection } from '../event-finder.svelte';
import { analysis } from '../analysis.svelte';
import { timeline } from '../timeline.svelte';

describe('splitShadowCss', () => {
  it('sends only @font-face and @property to the document, whatever they contain', () => {
    const css = [
      '@layer theme{:root,:host{--x:1}}',
      '@font-face{font-family:"A";src:url("a}b.woff2")}',
      '/* a comment with { braces } */',
      '@property --tw-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}',
      'html,:host{line-height:1.5}',
      '@media (min-width:1px){.a{color:red}}',
      '@import url("x.css");',
    ].join('');
    const { document, shadow } = splitShadowCss(css);
    expect(document).toBe('@font-face{font-family:"A";src:url("a}b.woff2")}\n@property --tw-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}');
    expect(shadow).toContain(':root,:host{--x:1}');
    expect(shadow).toContain('html,:host{line-height:1.5}');
    expect(shadow).toContain('@media (min-width:1px){.a{color:red}}');
    expect(shadow).toContain('@import url("x.css");');
    expect(shadow).not.toMatch(/@font-face|@property/);
  });

  it('keeps every element-selecting rule of the real stylesheet in the shadow root', () => {
    // Uncompiled source: the split must at least never move a selector rule out.
    const { document } = splitShadowCss(readFileSync(new URL('../../app.css', import.meta.url), 'utf8'));
    for (const rule of document.split('\n').filter(Boolean)) expect(rule).toMatch(/^@(font-face|property)\b/);
  });
});

describe('resetStores', () => {
  it('returns panels, selection, scene state and timeline to a fresh session', () => {
    const fresh = JSON.stringify({ shell, vs, ef, analysis, timeline });
    openTool('events');
    vs.selectedBodyName = 'SC-1';
    vs.activities = [{ id: 'x' } as never];
    setSelection({ id: 'a', queryId: 'activity:SC-1:other' });
    analysis.items.push({ id: 'q' } as never);
    timeline.laneHeight = 300;
    expect(JSON.stringify({ shell, vs, ef, analysis, timeline })).not.toBe(fresh);
    resetStores();
    expect(JSON.stringify({ shell, vs, ef, analysis, timeline })).toBe(fresh);
    // Twice: a reset must not hand out the initial value itself to be mutated.
    analysis.items.push({ id: 'q' } as never);
    resetStores();
    expect(analysis.items).toEqual([]);
  });
});
