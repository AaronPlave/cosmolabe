import { describe, expect, it, vi } from 'vitest';
import { UniverseRenderer } from '../UniverseRenderer.js';
import type { SceneHit } from '../SceneHit.js';

const feature = { layerId: 'science', featureId: 'string:target', bodyName: 'Mars' };
function harness(featureCount = 0) {
  const state = {
    placeNames: { pick: vi.fn(() => null as typeof feature | null) },
    geographicVectors: { featureCount, pick: vi.fn(() => null as typeof feature | null), setHovered: vi.fn(), setSelected: vi.fn() },
    hoveredGeographicFeature: null, _hoveredBody: null, _hoveredSceneEvent: null, _lastPointer: { x: 40, y: 50 },
    pointerTool: null, _probeActive: false, universe: { time: 123, state: { set: vi.fn() } }, lastSpatialPickMs: -Infinity, bodyMeshes: new Map([['Mars', {body:{name:'Mars'}}], ['Moon', {body:{name:'Moon'}}]]), plugins: [],
    spatialInteraction: { picking: () => false, beforePick: () => false, onHover: vi.fn(), onSelect: vi.fn(), preview: vi.fn() },
    spatialRelationships: { pick: vi.fn(() => null as string | null) },
    pickSceneEvent: vi.fn(() => null as { marker: { id: string; queryId: string }; et: number } | null),
    _discoverLabel: vi.fn(() => null as string | null), _discoverBodyMesh: vi.fn(() => 'Mars' as string | null),
    _discoverSurface: vi.fn(() => null),
    events: { emit: vi.fn() }, trajectoryLines: new Map([['Mars', { body: { name: 'Mars' }, setEmphasis: vi.fn() }]]),
    labelManager: { setLabelHighlighted: vi.fn() },
    renderer: { domElement: { style: { cursor: '' }, getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }) } },
  };
  const renderer = Object.assign(Object.create(UniverseRenderer.prototype), state) as UniverseRenderer;
  const internal = renderer as unknown as { updateObjectHover(): void; _selectAt(x: number, y: number): boolean; _onDblClick(event: MouseEvent): void };
  return { renderer, internal, state };
}

describe('geographic and rendered-surface picking integration', () => {
  it('selects a geographic name through the shared geographic feature channel without a surface cast', () => {
    const h = harness(0);
    h.state.placeNames.pick.mockReturnValue(feature);
    expect(h.renderer.pickScene(40, 50, 'select')).toEqual({ kind: 'geographic-feature', ...feature });
    expect(h.state._discoverSurface).not.toHaveBeenCalled();
  });
  it.each([false,true])('preserves body exclusion and renderedOnly=%s together', renderedOnly => {
    const h = harness(1);
    expect(h.renderer.pickScene(40,50,'select',{bodyMeshes:false,renderedOnly})).toBeNull();
    expect(h.state._discoverSurface).toHaveBeenCalledWith(-0.9,5/6,!renderedOnly);
    expect(h.state.geographicVectors.pick).toHaveBeenCalledOnce();
    expect(h.state._discoverBodyMesh).not.toHaveBeenCalled();
  });
});

describe('geographic hover and body fallback', () => {
  it.each([0, 1])('highlights the body mesh when %s vector batches miss, and clears on empty space', count => {
    const h = harness(count);
    h.internal.updateObjectHover();
    expect(h.state._discoverBodyMesh).toHaveBeenCalledWith(-0.9, 5 / 6);
    expect(h.state.labelManager.setLabelHighlighted).toHaveBeenLastCalledWith('Mars');
    expect(h.state.trajectoryLines.get('Mars')!.setEmphasis).toHaveBeenLastCalledWith('highlight');
    expect(h.state.events.emit).toHaveBeenCalledWith('body:hovered', { bodyName: 'Mars' });
    expect(h.state.renderer.domElement.style.cursor).toBe('pointer');
    h.state._discoverBodyMesh.mockReturnValue(null);
    h.internal.updateObjectHover();
    expect(h.state.labelManager.setLabelHighlighted).toHaveBeenLastCalledWith(null);
    expect(h.state.trajectoryLines.get('Mars')!.setEmphasis).toHaveBeenLastCalledWith('rest');
    expect(h.state.renderer.domElement.style.cursor).toBe('');
  });

  it.each(['measurement', 'event', 'label', 'geographic'] as const)('keeps %s hover above body mesh fallback', kind => {
    const h = harness(1);
    if (kind === 'measurement') h.state.spatialRelationships.pick.mockReturnValue('measurement');
    if (kind === 'event') h.state.pickSceneEvent.mockReturnValue({ marker: { id: 'event', queryId: 'query' }, et: 123 });
    if (kind === 'label') h.state._discoverLabel.mockReturnValue('Moon');
    if (kind === 'geographic') h.state.geographicVectors.pick.mockReturnValue(feature);
    h.internal.updateObjectHover();
    expect(h.state._discoverBodyMesh).not.toHaveBeenCalled();
    expect(h.state.renderer.domElement.style.cursor).toBe('pointer');
    if (kind === 'geographic') expect(h.state.geographicVectors.setHovered).toHaveBeenCalledWith(feature);
  });
});

describe('geographic selection lifetime', () => {
  it.each([null, { kind: 'event', eventId: 'event', queryId: 'query', et: 123 },
    { kind: 'entity', bodyName: 'Mars', via: 'mesh' }, { kind: 'entity', bodyName: 'Moon', via: 'label' }] as (SceneHit | null)[])('clears geographic highlight when selecting %j', hit => {
    const h = harness(1);
    const pick = vi.spyOn(h.renderer, 'pickScene').mockReturnValue({ kind: 'geographic-feature', ...feature });
    h.internal._selectAt(40, 50);
    expect(h.state.geographicVectors.setSelected).toHaveBeenLastCalledWith(feature);
    pick.mockReturnValue(hit);
    h.internal._selectAt(40, 50);
    expect(h.state.geographicVectors.setSelected).toHaveBeenLastCalledWith(null);
  });

  it('replaces the selected feature and clears it when selecting a measurement', () => {
    const h = harness(1);
    const next = { ...feature, featureId: 'string:next' };
    vi.spyOn(h.renderer, 'pickScene').mockReturnValueOnce({ kind: 'geographic-feature', ...feature })
      .mockReturnValueOnce({ kind: 'geographic-feature', ...next });
    h.internal._selectAt(40, 50); h.internal._selectAt(41, 50);
    expect(h.state.geographicVectors.setSelected.mock.calls).toEqual([[feature], [next]]);
    h.state.spatialRelationships.pick.mockReturnValue('measurement');
    h.internal._selectAt(42, 50);
    expect(h.state.geographicVectors.setSelected).toHaveBeenLastCalledWith(null);
    expect(h.state.spatialInteraction.onSelect).toHaveBeenCalledWith('measurement');
  });

  it.each(['pointer-tool', 'measurement-tool', 'probe'] as const)('preserves selected geography during %s gestures', kind => {
    const h = harness(1);
    vi.spyOn(h.renderer, 'pickScene').mockReturnValue(null);
    if (kind === 'pointer-tool') Object.assign(h.renderer, { pointerTool: { pick: vi.fn() } });
    if (kind === 'measurement-tool') h.state.spatialInteraction.beforePick = () => true;
    if (kind === 'probe') Object.assign(h.renderer, { _probeActive: true });
    h.internal._selectAt(40, 50);
    expect(h.state.geographicVectors.setSelected).not.toHaveBeenCalled();
  });
});

describe('geographic double-click navigation routing', () => {
  const event=() => ({clientX:40,clientY:50,preventDefault:vi.fn(),stopImmediatePropagation:vi.fn()}) as unknown as MouseEvent;
  it.each(['Mars','Moon'])('emits a place event for a visible %s name without picking the body', bodyName => {
    const h=harness();h.state.placeNames.pick.mockReturnValue({...feature,bodyName});
    h.internal._onDblClick(event());
    expect(h.state.events.emit).toHaveBeenCalledExactlyOnceWith('geographic:dblclick',{...feature,bodyName});
    expect(h.state._discoverBodyMesh).not.toHaveBeenCalled();
  });
  it('retains unlabelled body behavior', () => {
    const h=harness();h.internal._onDblClick(event());
    expect(h.state.events.emit).toHaveBeenCalledWith('body:dblclick',{bodyName:'Mars',et:123,screenX:40,screenY:50});
  });
  it.each(['probe','drawing','measurement','recent measurement','event'])('does not fly during %s gestures', mode => {
    const h=harness();h.state.placeNames.pick.mockReturnValue(feature);
    if(mode==='probe') Object.assign(h.renderer,{_probeActive:true});
    if(mode==='drawing') Object.assign(h.renderer,{pointerTool:{pick:vi.fn()}});
    if(mode==='measurement') h.state.spatialRelationships.pick.mockReturnValue('length');
    if(mode==='recent measurement') Object.assign(h.renderer,{lastSpatialPickMs:performance.now()});
    if(mode==='event') h.state.pickSceneEvent.mockReturnValue({marker:{id:'event',queryId:'query'},et:123});
    h.internal._onDblClick(event());expect(h.state.events.emit).not.toHaveBeenCalled();
  });
});
