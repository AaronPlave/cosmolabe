import { describe, it, expect, vi } from 'vitest';
import { Universe } from '../Universe.js';
import { Body } from '../Body.js';
import { FixedPointTrajectory } from '../trajectories/FixedPoint.js';

describe('Universe events and state', () => {
  it('emits time:change when setTime is called', () => {
    const universe = new Universe();
    const handler = vi.fn();
    universe.events.on('time:change', handler);
    universe.setTime(100);
    expect(handler).toHaveBeenCalledWith({ et: 100 });
  });

  it('emits body:added when addBody is called', () => {
    const universe = new Universe();
    const handler = vi.fn();
    universe.events.on('body:added', handler);
    const body = new Body({ name: 'TestBody', trajectory: new FixedPointTrajectory([0, 0, 0]) });
    universe.addBody(body);
    expect(handler).toHaveBeenCalledWith({ body });
  });

  it('emits body:removed when removeBody is called', () => {
    const universe = new Universe();
    const body = new Body({ name: 'TestBody', trajectory: new FixedPointTrajectory([0, 0, 0]) });
    universe.addBody(body);
    const handler = vi.fn();
    universe.events.on('body:removed', handler);
    const removed = universe.removeBody('TestBody');
    expect(removed).toBe(true);
    expect(handler).toHaveBeenCalledWith({ bodyName: 'TestBody' });
  });

  it('emits catalog:loaded when loadCatalog is called', () => {
    const universe = new Universe();
    const handler = vi.fn();
    universe.events.on('catalog:loaded', handler);
    universe.loadCatalog({ name: 'test-catalog', items: [] });
    expect(handler).toHaveBeenCalledWith({ name: 'test-catalog' });
  });

  it('state store is initialized with defaults', () => {
    const universe = new Universe();
    expect(universe.state.get('selectedBody')).toBeNull();
    expect(universe.state.get('paused')).toBe(false);
    expect(universe.state.get('timeRate')).toBe(1);
  });

  it('state store watch works', () => {
    const universe = new Universe();
    const listener = vi.fn();
    universe.state.watch('selectedBody', listener);
    universe.state.set('selectedBody', 'Mars');
    expect(listener).toHaveBeenCalledWith('Mars', null);
  });

  it('dispose cleans up events and state', () => {
    const universe = new Universe();
    const handler = vi.fn();
    universe.events.on('time:change', handler);
    universe.dispose();
    universe.setTime(999);
    expect(handler).not.toHaveBeenCalled();
  });
});
