/**
 * Closing the plan mid-drawing hands the scene's clicks back (#250). No
 * renderer in a unit test, so the shared draw tool is stood in for.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./geographic-editing.svelte', async (original) => {
  const actual = await original<typeof import('./geographic-editing.svelte')>();
  return {
    ...actual,
    setDrawTool: vi.fn((tool: string | null) => {
      actual.edits.tool = tool as never;
      actual.edits.target = tool ? 'user:mars:planner-regions' : actual.edits.target;
    }),
  };
});

const { edits, setDrawTool } = await import('./geographic-editing.svelte');
const { closePlan, drawRegion, planner } = await import('./surface-planner.svelte');
const { createSurfacePlanDraft } = await import('@cosmolabe/core');

describe('planner region drawing', () => {
  it('turns the shared draw tool off when the plan closes during an unfinished polygon', () => {
    planner.plan = createSurfacePlanDraft('Mars', { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '0..360',
      referenceShape: { kind: 'sphere', radiusKm: 3396.19 } });
    drawRegion();
    expect(edits.tool).toBe('polygon');
    expect(planner.awaitingDraw).toBe(true);
    closePlan();
    expect(setDrawTool).toHaveBeenLastCalledWith(null);
    expect(edits.tool).toBeNull();
    expect(planner.awaitingDraw).toBe(false);
  });

  it('leaves a draw tool it did not start alone', () => {
    edits.tool = 'line';
    vi.mocked(setDrawTool).mockClear();
    closePlan();
    expect(setDrawTool).not.toHaveBeenCalled();
    edits.tool = null;
  });
});
